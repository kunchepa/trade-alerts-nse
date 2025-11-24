/**
 * index.js
 * Trade Alerts — LIVE signals with:
 *  - WinRate60d estimate
 *  - Profit Targets + SL + Exit signals
 *  - Risk-based lot sizing
 *  - Optional expanded symbol list (NSE 100)
 *
 * Requirements:
 *  npm install node-fetch technicalindicators googleapis
 *
 * Env vars required:
 *  TELEGRAM_BOT_TOKEN
 *  TELEGRAM_CHAT_ID
 *  GOOGLE_SERVICE_ACCOUNT_JSON  (stringified JSON)
 *  SPREADSHEET_ID
 *  ACCOUNT_CAPITAL  (optional, default 100000)
 *  RISK_PCT (optional, default 0.01 -> 1% per trade)
 */

import fetch from "node-fetch";
import technical from "technicalindicators";
import { google } from "googleapis";

// ---------- CONFIG ----------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const GOOGLE_SERVICE_ACCOUNT_JSON = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}");
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = "Alerts";

const ACCOUNT_CAPITAL = Number(process.env.ACCOUNT_CAPITAL || 100000);
const RISK_PCT = Number(process.env.RISK_PCT || 0.01); // 1% default
const SL_ATR_MULTIPLIER = Number(process.env.SL_ATR_MULTIPLIER || 1.5);
const TP_ATR_MULTIPLIER = Number(process.env.TP_ATR_MULTIPLIER || 3.0);
const WINRATE_LOOKBACK_DAYS = 60;

// ---------- SYMBOL LIST (replace/expand to NSE100 if desired) ----------
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

// If you want the full NSE100, replace `symbols` with an array of the top100 tickers.

// ------------------------- Utility fetch helpers -------------------------
async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  }
  return res.json();
}

// ------------------------- Market data functions -------------------------
// NOTE: NSE endpoints: in practice you may need to use a reliable data source (AlphaVantage/Yahoo/your broker).
// Below endpoints are placeholders — replace with your actual data API if needed.

async function fetchQuote(symbol) {
  // Attempt to hit NSE quote endpoint (may require cookie/auth in real life)
  try {
    const url = `https://www.nseindia.com/api/quote-equity?symbol=${symbol}`;
    const json = await fetchJSON(url, { "User-Agent": "Mozilla/5.0", Accept: "*/*" });
    // Try to extract lastPrice
    const last = json?.priceInfo?.lastPrice || json?.priceInfo?.lastPrice;
    return { price: last, raw: json };
  } catch (err) {
    console.warn(`Quote fetch failed for ${symbol}: ${err.message}`);
    return null;
  }
}

async function fetchDailyHistory(symbol, days = 250) {
  // This is a simple placeholder: fetch /chart or daily CSV from a provider.
  // Replace with your real daily history endpoint that returns array of { date, open, high, low, close, volume }
  try {
    const url = `https://www.nseindia.com/api/historical/cm/equity?symbol=${symbol}`; // placeholder
    const json = await fetchJSON(url, { "User-Agent": "Mozilla/5.0", Accept: "*/*" });
    // adapt to structure — user must update this depending on chosen API
    // Example return format expected by this script:
    // [{date:'2025-11-20', open:..., high:..., low:..., close:..., volume:...}, ...]
    const data = json?.data || json?.prices || [];
    // Ensure most recent at end; slice last 'days' items
    return data.slice(-days);
  } catch (err) {
    console.warn(`History fetch failed for ${symbol}: ${err.message}`);
    return null;
  }
}

// ------------------------- Indicators -------------------------
function computeIndicatorsFromHistory(hist) {
  // hist expected: array of {close, high, low, volume}
  const closes = hist.map((d) => d.close);
  const highs = hist.map((d) => d.high ?? d.close);
  const lows = hist.map((d) => d.low ?? d.close);
  const vols = hist.map((d) => d.volume ?? 0);

  const ema20 = technical.EMA.calculate({ period: 20, values: closes });
  const ema50 = technical.EMA.calculate({ period: 50, values: closes });
  const ema200 = technical.EMA.calculate({ period: 200, values: closes });

  let adxVal;
  try {
    const adx = technical.ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    adxVal = adx?.at(-1)?.adx;
  } catch (e) {
    adxVal = undefined;
  }

  const atr = technical.ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const atrVal = atr?.at(-1);

  const vol20 = technical.SMA.calculate({ period: 20, values: vols })?.at(-1);

  return {
    ema20: ema20.at(-1),
    ema50: ema50.at(-1),
    ema200: ema200.at(-1),
    adx: adxVal,
    atr: atrVal,
    volume: vols.at(-1),
    vol20
  };
}

// ------------------------- WinRate60d (quick estimate) -------------------------
/**
 * Quick WinRate estimate:
 * - Loop last 60 trading days
 * - For each day, compute same signal using previous-history snapshot
 * - If signal existed on day i, check price movement in next 5 days:
 *    - success if price reached TP (TP = price + TP_ATR*ATR) before SL
 * This is a quick heuristic; not a rigorous backtest.
 */
function estimateWinRate(hist, lookbackDays = WINRATE_LOOKBACK_DAYS) {
  // hist: daily OHLCV with oldest -> newest
  const n = hist.length;
  if (n < 100) return null;

  let wins = 0;
  let totalSignals = 0;

  for (let idx = n - lookbackDays - 6; idx < n - 6; idx++) {
    if (idx < 50) continue;
    const slice = hist.slice(0, idx + 1); // up to day idx
    const indicators = computeIndicatorsFromHistory(slice);
    const priceToday = slice.at(-1).close;
    // generate signal on that day
    const sig = generateSignalFromIndicators(priceToday, indicators);
    if (!sig) continue;
    totalSignals++;

    // evaluate next up to 5 days
    const futureWindow = hist.slice(idx + 1, idx + 6); // up to 5 days
    const atr = indicators.atr || 0.01;
    const slPrice = sig.direction === "BUY" ? priceToday - SL_ATR_MULTIPLIER * atr : priceToday + SL_ATR_MULTIPLIER * atr;
    const tpPrice = sig.direction === "BUY" ? priceToday + TP_ATR_MULTIPLIER * atr : priceToday - TP_ATR_MULTIPLIER * atr;

    let outcome = null;
    for (const f of futureWindow) {
      const high = f.high;
      const low = f.low;
      if (sig.direction === "BUY") {
        if (low <= slPrice) { outcome = "loss"; break; }
        if (high >= tpPrice) { outcome = "win"; break; }
      } else {
        if (high >= slPrice) { outcome = "loss"; break; }
        if (low <= tpPrice) { outcome = "win"; break; }
      }
    }
    if (outcome === "win") wins++;
  }

  if (totalSignals === 0) return null;
  return (wins / totalSignals) * 100;
}

// Helper used by estimateWinRate
function generateSignalFromIndicators(price, ind) {
  if (!ind.ema20 || !ind.ema50 || !ind.ema200) return null;
  if (price > ind.ema20 && ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200 && ind.adx > 25) {
    return { direction: "BUY", reason: "Trend+ADX" };
  }
  if (price < ind.ema20 && ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200 && ind.adx > 25) {
    return { direction: "SELL", reason: "Trend+ADX" };
  }
  return null;
}

// ------------------------- Signal generator + risk sizing -------------------------
function buildTradePlan(symbol, price, ind) {
  const slDistance = (ind.atr || 0.01) * SL_ATR_MULTIPLIER; // rupees
  const tpDistance = (ind.atr || 0.01) * TP_ATR_MULTIPLIER;

  // risk per share in rupees:
  const riskPerShare = slDistance;
  // position size shares:
  const positionSize = Math.max(0, Math.floor((ACCOUNT_CAPITAL * RISK_PCT) / Math.max(riskPerShare, 0.0001)));
  // round to nearest lot if needed (lot size default 1 share)
  const lotSize = 1;
  const qty = Math.floor(positionSize / lotSize) * lotSize;

  const direction = price > ind.ema20 && ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200 && ind.adx > 25 ? "BUY"
                  : price < ind.ema20 && ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200 && ind.adx > 25 ? "SELL"
                  : null;

  if (!direction) return null;

  const sl = direction === "BUY" ? price - slDistance : price + slDistance;
  const tp = direction === "BUY" ? price + tpDistance : price - tpDistance;

  const riskAmount = qty * riskPerShare;
  const riskPctActual = (riskAmount / ACCOUNT_CAPITAL) * 100;

  return {
    symbol,
    direction,
    price,
    sl,
    tp,
    atr: ind.atr,
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

// ------------------------- Telegram + Sheets -------------------------
async function sendTelegram(text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
  } catch (e) {
    console.error("Telegram send error:", e);
  }
}

async function appendSheetRow(row) {
  const auth = new google.auth.JWT(
    GOOGLE_SERVICE_ACCOUNT_JSON.client_email,
    null,
    GOOGLE_SERVICE_ACCOUNT_JSON.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:Z`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [row] }
  });
}

// ------------------------- Main loop -------------------------
async function run() {
  console.log("Starting Trade Alerts run...");
  for (const symbol of symbols) {
    try {
      console.log(`Processing ${symbol}...`);

      // Live quote
      const q = await fetchQuote(symbol);
      if (!q || !q.price) {
        console.warn(`No quote for ${symbol}`);
        continue;
      }
      const price = Number(q.price);

      // Daily history
      const hist = await fetchDailyHistory(symbol, 250);
      if (!hist || hist.length < 100) {
        console.warn(`Insufficient history for ${symbol}`);
        continue;
      }

      // Compute indicators
      const ind = computeIndicatorsFromHistory(hist);

      // Build trade plan (signals + risk sizing)
      const plan = buildTradePlan(symbol, price, ind);
      if (!plan) {
        console.log(`${symbol} -> no trade signal`);
        continue;
      }

      // Compute WinRate60d estimate using the daily history
      const winRate = estimateWinRate(hist, WINRATE_LOOKBACK_DAYS);
      const winRateText = winRate ? `${winRate.toFixed(1)}%` : "N/A";

      // Prepare Telegram message
      const tg = [
        `📢 <b>TRADE SIGNAL</b>`,
        `🔸 Symbol: <b>${symbol}</b>`,
        `🔸 Direction: <b>${plan.direction}</b>`,
        `🔸 Price: ₹${plan.price}`,
        `🔸 SL: ₹${plan.sl.toFixed(2)} | TP: ₹${plan.tp.toFixed(2)}`,
        `🔸 Qty: ${plan.qty} (lot ${plan.lotSize})`,
        `🔸 RiskAmt: ₹${plan.riskAmount.toFixed(2)} (~${plan.riskPctActual.toFixed(2)}% of capital)`,
        `🔸 ATR: ${plan.atr?.toFixed(4) || "NA"} | ADX: ${plan.adx?.toFixed(1) || "NA"}`,
        `🔸 WinRate(60d estimate): ${winRateText}`,
        `\nReason: Trend with strength (EMA & ADX)`,
      ].join("\n");

      // Send Telegram
      await sendTelegram(tg);

      // Append to Google Sheet
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

      console.log(`Signal sent for ${symbol}: ${plan.direction} @ ${plan.price}`);
    } catch (err) {
      console.error(`Error processing ${symbol}:`, err.message);
    }
  }
  console.log("Run complete.");
}

// Run
run().catch((e) => console.error("Fatal error:", e));
