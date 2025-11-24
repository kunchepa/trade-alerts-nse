// index.js  — Option B (FULL, copy–paste ready)
/**
 * Trade Alerts — FINAL (Option B)
 *
 * Features:
 *  - YahooFinance v3 (class instance)
 *  - EMA20/50/200 + ADX filter
 *  - ATR-based SL / TP
 *  - Risk-based lot sizing
 *  - WinRate(60d) quick heuristic
 *  - Telegram alerts + Google Sheets logging
 *  - Throttling, robust error handling
 *
 * Install:
 *   npm install yahoo-finance2@^3.0.0 technicalindicators googleapis axios
 *
 * Required env (GitHub Secrets):
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 *   GOOGLE_SERVICE_ACCOUNT_JSON  (stringified JSON)
 *   SPREADSHEET_ID
 *
 * Optional env:
 *   ACCOUNT_CAPITAL (default: 100000)
 *   RISK_PCT (default: 0.01)
 *   SL_ATR_MULTIPLIER (default: 1.5)
 *   TP_ATR_MULTIPLIER (default: 3.0)
 *   WINRATE_LOOKBACK_DAYS (default: 60)
 */

import { YahooFinance } from "yahoo-finance2";
import technical from "technicalindicators";
import { google } from "googleapis";
import axios from "axios";

const yahooFinance = new YahooFinance();

// -------------------- CONFIG --------------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  : null;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || null;

const ACCOUNT_CAPITAL = Number(process.env.ACCOUNT_CAPITAL || 100000);
const RISK_PCT = Number(process.env.RISK_PCT || 0.01); // fraction of capital per trade
const SL_ATR_MULTIPLIER = Number(process.env.SL_ATR_MULTIPLIER || 1.5);
const TP_ATR_MULTIPLIER = Number(process.env.TP_ATR_MULTIPLIER || 3.0);
const WINRATE_LOOKBACK_DAYS = Number(process.env.WINRATE_LOOKBACK_DAYS || 60);

// NSE symbol list (replace/expand for NSE100)
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

// -------------------- UTIL --------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("Telegram env not set; skipping Telegram send.");
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
    console.error("Telegram send error:", e?.response?.data || e?.message || e);
  }
}

async function appendSheetRow(row) {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !SPREADSHEET_ID) {
    console.warn("Google Sheets not configured; skipping append.");
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

// -------------------- MARKET DATA (YahooFinance v3) --------------------
async function fetchQuote(symbol) {
  const s = symbol.endsWith(".NS") ? symbol : `${symbol}.NS`;
  try {
    const q = await yahooFinance.quote(s);
    const price = q?.regularMarketPrice ?? q?.previousClose ?? null;
    return { price, raw: q };
  } catch (e) {
    console.warn(`Quote failed for ${symbol}: ${e?.message || e}`);
    return null;
  }
}

async function fetchDailyHistory(symbol, days = 400) {
  const s = symbol.endsWith(".NS") ? symbol : `${symbol}.NS`;
  try {
    const period2 = new Date();
    const period1 = new Date();
    period1.setDate(period2.getDate() - days);

    const chart = await yahooFinance.chart(s, { period1, period2, interval: "1d" });
    // chart.chart.result[0].timestamp and indicators.quote[0]
    const chartRes = chart?.chart?.result?.[0];
    if (!chartRes) {
      console.warn(`No chart result for ${symbol}`);
      return null;
    }
    const timestamps = chartRes.timestamp ?? [];
    const quoteInd = chartRes.indicators?.quote?.[0] ?? {};
    const openArr = quoteInd.open ?? [];
    const highArr = quoteInd.high ?? [];
    const lowArr = quoteInd.low ?? [];
    const closeArr = quoteInd.close ?? [];
    const volArr = quoteInd.volume ?? [];

    const rows = timestamps.map((t, i) => ({
      date: new Date(t * 1000),
      open: Number(openArr[i] ?? closeArr[i] ?? 0),
      high: Number(highArr[i] ?? closeArr[i] ?? 0),
      low: Number(lowArr[i] ?? closeArr[i] ?? 0),
      close: Number(closeArr[i] ?? 0),
      volume: Number(volArr[i] ?? 0),
    })).filter((r) => r.close && !Number.isNaN(r.close));

    rows.sort((a, b) => a.date - b.date);
    return rows;
  } catch (e) {
    console.warn(`History failed for ${symbol}: ${e?.message || e}`);
    return null;
  }
}

// -------------------- INDICATORS --------------------
function computeIndicatorsFromHistory(hist) {
  const closes = hist.map((d) => d.close);
  const highs = hist.map((d) => d.high);
  const lows = hist.map((d) => d.low);
  const vols = hist.map((d) => d.volume);

  const ema20 = technical.EMA.calculate({ period: 20, values: closes }).at(-1);
  const ema50 = technical.EMA.calculate({ period: 50, values: closes }).at(-1);
  const ema200 = technical.EMA.calculate({ period: 200, values: closes }).at(-1);

  let adxVal;
  try {
    const adxArr = technical.ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    adxVal = adxArr.length ? adxArr.at(-1).adx : undefined;
  } catch { adxVal = undefined; }

  let atrVal;
  try {
    const atrArr = technical.ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    atrVal = atrArr.length ? atrArr.at(-1) : undefined;
  } catch { atrVal = undefined; }

  const vol20 = technical.SMA.calculate({ period: 20, values: vols }).at(-1);

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

// -------------------- SIGNAL + RISK --------------------
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

function buildTradePlan(symbol, price, ind) {
  const sig = generateSignalFromIndicators(price, ind);
  if (!sig || !ind.atr) return null;

  const atr = ind.atr;
  const slDist = SL_ATR_MULTIPLIER * atr;
  const tpDist = TP_ATR_MULTIPLIER * atr;

  const sl = sig.direction === "BUY" ? price - slDist : price + slDist;
  const tp = sig.direction === "BUY" ? price + tpDist : price - tpDist;

  const riskPerShare = slDist;
  const maxRiskAmount = ACCOUNT_CAPITAL * RISK_PCT;
  const rawQty = Math.floor(maxRiskAmount / Math.max(riskPerShare, 1e-6));
  const lotSize = 1; // adapt to exchange lot sizes if needed
  const qty = Math.floor(rawQty / lotSize) * lotSize;

  if (qty <= 0) return null;

  return {
    symbol,
    direction: sig.direction,
    price,
    sl,
    tp,
    atr,
    qty,
    lotSize,
    riskAmount: qty * riskPerShare,
    riskPctActual: ((qty * riskPerShare) / ACCOUNT_CAPITAL) * 100,
    ema20: ind.ema20,
    ema50: ind.ema50,
    ema200: ind.ema200,
    adx: ind.adx,
    volume: ind.volume,
    vol20: ind.vol20
  };
}

// -------------------- WinRate60d heuristic --------------------
function estimateWinRate(hist, lookback = WINRATE_LOOKBACK_DAYS) {
  const n = hist.length;
  if (n < 100) return null;

  let wins = 0, total = 0;
  const start = Math.max(50, n - lookback - 6);
  for (let idx = start; idx < n - 6; idx++) {
    const past = hist.slice(0, idx + 1);
    const ind = computeIndicatorsFromHistory(past);
    const priceToday = past.at(-1).close;
    const sig = generateSignalFromIndicators(priceToday, ind);
    if (!sig) continue;
    total++;
    const future = hist.slice(idx + 1, idx + 6);
    const atr = ind.atr || 0.01;
    const slPrice = sig.direction === "BUY" ? priceToday - SL_ATR_MULTIPLIER * atr : priceToday + SL_ATR_MULTIPLIER * atr;
    const tpPrice = sig.direction === "BUY" ? priceToday + TP_ATR_MULTIPLIER * atr : priceToday - TP_ATR_MULTIPLIER * atr;
    let got = null;
    for (const f of future) {
      if (sig.direction === "BUY") {
        if (f.low <= slPrice) { got = "loss"; break; }
        if (f.high >= tpPrice) { got = "win"; break; }
      } else {
        if (f.high >= slPrice) { got = "loss"; break; }
        if (f.low <= tpPrice) { got = "win"; break; }
      }
    }
    if (got === "win") wins++;
  }
  if (total === 0) return null;
  return (wins / total) * 100;
}

// -------------------- MAIN RUN --------------------
async function run() {
  console.log("🚀 Starting Trade Alerts (Option B)...");
  for (const symbol of symbols) {
    try {
      console.log(`📡 Fetching: ${symbol}`);
      const q = await fetchQuote(symbol);
      if (!q || !q.price) { console.warn(`Quote failed for ${symbol}`); await sleep(200); continue; }
      const price = Number(q.price);

      const hist = await fetchDailyHistory(symbol, 400);
      if (!hist || hist.length < 120) { console.warn(`Insufficient history for ${symbol}`); await sleep(200); continue; }

      const ind = computeIndicatorsFromHistory(hist);
      const plan = buildTradePlan(symbol, price, ind);
      if (!plan) { console.log(`${symbol} -> no trade signal`); await sleep(150); continue; }

      const winRate = estimateWinRate(hist, WINRATE_LOOKBACK_DAYS);
      const winText = winRate ? `${winRate.toFixed(1)}%` : "N/A";

      const message = [
        `📢 <b>TRADE SIGNAL</b>`,
        `🔸 Symbol: <b>${plan.symbol}</b>`,
        `🔸 Direction: <b>${plan.direction}</b>`,
        `🔸 Price: ₹${plan.price}`,
        `🔸 SL: ₹${plan.sl.toFixed(2)} | TP: ₹${plan.tp.toFixed(2)}`,
        `🔸 Qty: ${plan.qty} (lot ${plan.lotSize})`,
        `🔸 RiskAmt: ₹${plan.riskAmount.toFixed(2)} (~${plan.riskPctActual.toFixed(2)}% of capital)`,
        `🔸 ATR: ${plan.atr?.toFixed(4) || "NA"} | ADX: ${plan.adx?.toFixed(1) || "NA"}`,
        `🔸 WinRate(60d est): ${winText}`,
        ``,
        `Reason: Trend with strength (EMA & ADX)`
      ].join("\n");

      await sendTelegram(message);

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
        plan.riskPctActual.toFixed(4)
      ];
      await appendSheetRow(row);

      console.log(`✅ Signal: ${plan.symbol} ${plan.direction} @ ${plan.price} (qty ${plan.qty})`);
      await sleep(200); // small throttle to be nice to APIs
    } catch (e) {
      console.error(`Error processing ${symbol}:`, e?.message || e);
      await sleep(400);
    }
  }
  console.log("🏁 Scan complete.");
}

// Run when executed directly (node index.js)
if (typeof process !== "undefined" && process.argv && process.argv[1] && process.argv[1].endsWith("index.js")) {
  run().catch((e) => console.error("Fatal:", e));
} else {
  // also run in other contexts
  run().catch((e) => console.error("Fatal:", e));
}
