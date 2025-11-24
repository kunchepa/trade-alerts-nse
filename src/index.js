// src/index.js
/**
 * Trade Alerts — FINAL index.js (copy-paste ready)
 *
 * Requirements:
 *   npm install yahoo-finance2 technicalindicators googleapis axios
 *
 * Env vars required:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 *   GOOGLE_SERVICE_ACCOUNT_JSON   (stringified JSON)
 *   SPREADSHEET_ID
 * Optional:
 *   ACCOUNT_CAPITAL (default 100000)
 *   RISK_PCT (default 0.01 -> 1%)
 *   SL_ATR_MULTIPLIER (default 1.5)
 *   TP_ATR_MULTIPLIER (default 3.0)
 *   WINRATE_LOOKBACK_DAYS (default 60)
 */

import yahooFinance from "yahoo-finance2";
import technical from "technicalindicators";
import { google } from "googleapis";
import axios from "axios";

// ---------- CONFIG from env ----------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  : null;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const ACCOUNT_CAPITAL = Number(process.env.ACCOUNT_CAPITAL || 100000);
const RISK_PCT = Number(process.env.RISK_PCT || 0.01); // 1% default
const SL_ATR_MULTIPLIER = Number(process.env.SL_ATR_MULTIPLIER || 1.5);
const TP_ATR_MULTIPLIER = Number(process.env.TP_ATR_MULTIPLIER || 3.0);
const WINRATE_LOOKBACK_DAYS = Number(process.env.WINRATE_LOOKBACK_DAYS || 60);

// ---------- SYMBOL LIST (NSE tickers; extend to NSE100 if desired) ----------
const symbols = [
  "RELIANCE","HDFCBANK","ICICIBANK","INFY","TCS","AXISBANK","SBIN","KOTAKBANK","LT",
  "BHARTIARTL","ITC","HINDUNILVR","HCLTECH","WIPRO","ASIANPAINT","SUNPHARMA","ULTRACEMCO",
  "NESTLEIND","BAJFINANCE","BAJAJFINSV","POWERGRID","JSWSTEEL","TITAN","MARUTI","TATASTEEL",
  "ADANIENT","ADANIPORTS","TECHM","CIPLA","DRREDDY","DIVISLAB","ONGC","COALINDIA","BPCL","IOC",
  "GRASIM","HEROMOTOCO","BRITANNIA","SHREECEM","EICHERMOT","APOLLOHOSP","HDFCLIFE","SBILIFE",
  "ICICIPRULI","INDUSINDBK","BAJAJ-AUTO","M&M","TATAMOTORS","UPL","VEDL","NTPC","HINDALCO",
  "LTIM","LTTS","DABUR","PIDILITIND","PEL","JINDALSTEL","SRF","SIEMENS","TORNTPHARM",
  "AMBUJACEM","BANDHANBNK","GAIL","BOSCHLTD","COLPAL","GLAND","HAL","MAXHEALTH","MPHASIS",
  "PAGEIND","PIIND","RECLTD","SAIL","TATACOMM","TRENT","UBL","VOLTAS","ZEEL","ATUL",
  "DLF","INDIGO","IRCTC","LICI","MUTHOOTFIN","NAVINFLUOR","POLYCAB","RAMCOCEM","TVSMOTOR",
  "VBL","CONCOR","IDFCFIRSTB","BANKBARODA"
];

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("Telegram not configured (missing env).");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }, { timeout: 15000 });
  } catch (e) {
    console.error("Telegram send error:", e?.response?.data || e.message);
  }
}

async function appendSheetRow(row) {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !SPREADSHEET_ID) {
    console.warn("Google Sheets not configured (missing env).");
    return;
  }
  try {
    const auth = new google.auth.JWT(
      GOOGLE_SERVICE_ACCOUNT_JSON.client_email,
      null,
      GOOGLE_SERVICE_ACCOUNT_JSON.private_key,
      ["https://www.googleapis.com/auth/spreadsheets"]
    );
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `Alerts!A:Z`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [row] },
    });
  } catch (e) {
    console.error("Sheets append error:", e?.message || e);
  }
}

// ---------- Market data using yahoo-finance2 (v3) ----------
async function fetchQuote(symbol) {
  // append .NS for NSE
  const qsym = symbol.endsWith(".NS") ? symbol : `${symbol}.NS`;
  try {
    const quote = await yahooFinance.quote(qsym);
    // prefer regularMarketPrice, fallback to previousClose
    const price = quote?.regularMarketPrice ?? quote?.previousClose;
    return { price, raw: quote };
  } catch (e) {
    console.warn(`Quote failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchDailyHistory(symbol, days = 400) {
  const s = symbol.endsWith(".NS") ? symbol : `${symbol}.NS`;
  try {
    const period2 = new Date();
    const period1 = new Date();
    period1.setDate(period2.getDate() - days);
    const result = await yahooFinance.chart(s, {
      period1,
      period2,
      interval: "1d",
    });
    // result.chart?.result[0].indicators.quote[0].close etc OR result.quotes
    const quotes = result?.quotes ?? result?.chart?.result?.[0]?.indicators?.quote?.[0];
    // Normalise to array of objects { date, open, high, low, close, volume }
    const out = (result?.quotes ?? result?.chart?.result?.[0]?.timestamp?.map((t, i) => {
      const q = result.chart.result[0].indicators.quote[0];
      const open = q.open?.[i];
      const high = q.high?.[i];
      const low = q.low?.[i];
      const close = q.close?.[i];
      const volume = q.volume?.[i];
      return { date: new Date(result.chart.result[0].timestamp[i] * 1000), open, high, low, close, volume };
    })) || [];

    // If result.quotes exists, map directly
    const mapped = Array.isArray(out)
      ? out
      : [];

    // Ensure proper structure and filter out null closes
    const cleaned = mapped
      .map((d) => ({
        date: d.date ? new Date(d.date) : null,
        open: Number(d.open ?? d.close ?? 0),
        high: Number(d.high ?? d.close ?? 0),
        low: Number(d.low ?? d.close ?? 0),
        close: Number(d.close ?? 0),
        volume: Number(d.volume ?? 0),
      }))
      .filter((d) => d.close && !isNaN(d.close));

    // Sort oldest -> newest
    cleaned.sort((a, b) => new Date(a.date) - new Date(b.date));

    return cleaned;
  } catch (e) {
    console.warn(`History failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// ---------- Indicators ----------
function computeIndicatorsFromHistory(hist) {
  const closes = hist.map((d) => d.close);
  const highs = hist.map((d) => d.high);
  const lows = hist.map((d) => d.low);
  const vols = hist.map((d) => d.volume);

  const ema20Arr = technical.EMA.calculate({ period: 20, values: closes });
  const ema50Arr = technical.EMA.calculate({ period: 50, values: closes });
  const ema200Arr = technical.EMA.calculate({ period: 200, values: closes });
  const ema20 = ema20Arr.length ? ema20Arr.at(-1) : undefined;
  const ema50 = ema50Arr.length ? ema50Arr.at(-1) : undefined;
  const ema200 = ema200Arr.length ? ema200Arr.at(-1) : undefined;

  let adxVal;
  try {
    const adxArr = technical.ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    adxVal = adxArr.length ? adxArr.at(-1).adx : undefined;
  } catch (e) {
    adxVal = undefined;
  }

  let atrVal;
  try {
    const atrArr = technical.ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    atrVal = atrArr.length ? atrArr.at(-1) : undefined;
  } catch (e) {
    atrVal = undefined;
  }

  const vol20Arr = technical.SMA.calculate({ period: 20, values: vols });
  const vol20 = vol20Arr.length ? vol20Arr.at(-1) : undefined;

  return {
    ema20,
    ema50,
    ema200,
    adx: adxVal,
    atr: atrVal,
    volume: vols.at(-1),
    vol20,
  };
}

// ---------------- WinRate60d estimate (quick heuristic) ----------------
function generateSignalFromIndicators(price, ind) {
  if (!ind.ema20 || !ind.ema50 || !ind.ema200 || !ind.adx) return null;
  if (price > ind.ema20 && ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200 && ind.adx > 25) {
    return { direction: "BUY", reason: "Trend+ADX" };
  }
  if (price < ind.ema20 && ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200 && ind.adx > 25) {
    return { direction: "SELL", reason: "Trend+ADX" };
  }
  return null;
}

function estimateWinRate(hist, lookbackDays = WINRATE_LOOKBACK_DAYS) {
  // quick heuristic; expects hist oldest->newest
  const n = hist.length;
  if (n < 100) return null;

  let wins = 0;
  let total = 0;

  // loop through days where we can look forward 5 days
  for (let idx = Math.max(50, n - lookbackDays - 6); idx < n - 6; idx++) {
    const slice = hist.slice(0, idx + 1);
    const ind = computeIndicatorsFromHistory(slice);
    const priceToday = slice.at(-1).close;
    const sig = generateSignalFromIndicators(priceToday, ind);
    if (!sig) continue;
    total++;

    const future = hist.slice(idx + 1, idx + 6);
    const atr = ind.atr || 0.01;
    const slPrice = sig.direction === "BUY" ? priceToday - SL_ATR_MULTIPLIER * atr : priceToday + SL_ATR_MULTIPLIER * atr;
    const tpPrice = sig.direction === "BUY" ? priceToday + TP_ATR_MULTIPLIER * atr : priceToday - TP_ATR_MULTIPLIER * atr;

    let outcome = null;
    for (const f of future) {
      if (sig.direction === "BUY") {
        if (f.low <= slPrice) { outcome = "loss"; break; }
        if (f.high >= tpPrice) { outcome = "win"; break; }
      } else {
        if (f.high >= slPrice) { outcome = "loss"; break; }
        if (f.low <= tpPrice) { outcome = "win"; break; }
      }
    }
    if (outcome === "win") wins++;
  }

  if (total === 0) return null;
  return (wins / total) * 100;
}

// --------- Build trade plan (signal + risk sizing) ----------
function buildTradePlan(symbol, price, ind) {
  if (!ind.ema20 || !ind.ema50 || !ind.ema200 || !ind.adx) return null;

  const direction = price > ind.ema20 && ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200 && ind.adx > 25 ? "BUY"
                  : price < ind.ema20 && ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200 && ind.adx > 25 ? "SELL"
                  : null;

  if (!direction) return null;

  const atr = ind.atr || 0.01;
  const slDistance = atr * SL_ATR_MULTIPLIER;
  const tpDistance = atr * TP_ATR_MULTIPLIER;

  const sl = direction === "BUY" ? price - slDistance : price + slDistance;
  const tp = direction === "BUY" ? price + tpDistance : price - tpDistance;

  const riskPerShare = slDistance;
  const rawPositionShares = Math.floor((ACCOUNT_CAPITAL * RISK_PCT) / Math.max(riskPerShare, 1e-6));
  const lotSize = 1; // modify if exchange lot sizes needed
  const qty = Math.floor(rawPositionShares / lotSize) * lotSize;

  const riskAmount = qty * riskPerShare;
  const riskPctActual = (riskAmount / ACCOUNT_CAPITAL) * 100;

  return {
    symbol,
    direction,
    price,
    sl,
    tp,
    atr,
    qty,
    lotSize,
    riskAmount,
    riskPctActual,
    ema20: ind.ema20,
    ema50: ind.ema50,
    ema200: ind.ema200,
    adx: ind.adx,
    volume: ind.volume,
    vol20: ind.vol20
  };
}

// ---------------- Main run ----------------
async function run() {
  console.log("🚀 Starting Trade Alerts...");

  for (const symbol of symbols) {
    try {
      console.log(`📡 Fetching: ${symbol}`);

      // 1) quote
      const q = await fetchQuote(symbol);
      if (!q || !q.price) {
        console.warn(`Quote failed for ${symbol}`);
        await sleep(200); // gentle throttle
        continue;
      }
      const price = Number(q.price);

      // 2) history
      const hist = await fetchDailyHistory(symbol, 400);
      if (!hist || hist.length < 100) {
        console.warn(`Insufficient history for ${symbol}`);
        await sleep(200);
        continue;
      }

      // 3) indicators
      const ind = computeIndicatorsFromHistory(hist);

      // 4) plan
      const plan = buildTradePlan(symbol, price, ind);
      if (!plan) {
        console.log(`${symbol} -> no trade signal`);
        await sleep(150);
        continue;
      }

      // 5) WinRate estimate
      const winRate = estimateWinRate(hist, WINRATE_LOOKBACK_DAYS);
      const winRateText = winRate ? `${winRate.toFixed(1)}%` : "N/A";

      // 6) Telegram message
      const msg = [
        `📢 <b>TRADE SIGNAL</b>`,
        `🔸 Symbol: <b>${plan.symbol}</b>`,
        `🔸 Direction: <b>${plan.direction}</b>`,
        `🔸 Price: ₹${plan.price}`,
        `🔸 SL: ₹${plan.sl.toFixed(2)} | TP: ₹${plan.tp.toFixed(2)}`,
        `🔸 Qty: ${plan.qty} (lot ${plan.lotSize})`,
        `🔸 RiskAmt: ₹${plan.riskAmount.toFixed(2)} (~${plan.riskPctActual.toFixed(2)}% of capital)`,
        `🔸 ATR: ${plan.atr?.toFixed(4) || "NA"} | ADX: ${plan.adx?.toFixed(1) || "NA"}`,
        `🔸 WinRate(60d estimate): ${winRateText}`,
        ``,
        `Reason: Trend with strength (EMA & ADX)`,
      ].join("\n");

      await sendTelegram(msg);

      // 7) Append to Google Sheet
      const row = [
        new Date().toLocaleString("en-IN"),
        plan.symbol,
        plan.direction,
        plan.price,
        "Trend+ADX",
        plan.ema20,
        plan.ema50,
        plan.ema200,
        plan.adx,
        plan.atr,
        plan.volume,
        plan.vol20,
        winRate ? winRate.toFixed(2) : "",
        plan.sl,
        plan.tp,
        plan.qty,
        plan.riskAmount.toFixed(2),
        plan.riskPctActual.toFixed(4),
      ];
      await appendSheetRow(row);

      console.log(`✅ Signal sent for ${symbol}: ${plan.direction} @ ${plan.price}`);
      await sleep(200); // throttle between symbols
    } catch (err) {
      console.error(`Error processing ${symbol}:`, err?.message || err);
      // small sleep to avoid hammering on repeated errors
      await sleep(300);
    }
  }

  console.log("🏁 Completed scan.");
}

// Run standalone
if (import.meta.url === `file://${process.cwd()}/src/index.js` || import.meta.url.endsWith("/src/index.js")) {
  run().catch((e) => console.error("Fatal error:", e));
} else {
  // If run via "node src/index.js", above condition triggers; else just run anyway
  run().catch((e) => console.error("Fatal error:", e));
}
