/**
 * index.js
 * ORB 30-min strategy:
 * - ORB = first 30 minutes (9:15–9:45 IST)
 * - BUY if price breaks above ORB high AND EMA20 > EMA50 AND ADX > 23 AND volume spike
 * - SELL if price breaks below ORB low  AND EMA20 < EMA50 AND ADX > 23 AND volume spike
 *
 * Notes:
 * - Uses yahoo-finance2 v3 (requires new YahooFinance() instance)
 * - DRY_RUN=true disables Telegram & Sheets writes
 * - TEST_LIMIT=n restricts number of symbols for quick test
 *
 * Original uploaded index reference (for your records): /mnt/data/index.js
 */

import { YahooFinance } from "yahoo-finance2";
import axios from "axios";
import pLimit from "p-limit";
import pRetry from "p-retry";
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import { ADX } from "technicalindicators";

// === CONFIG ===
const yahooFinance = new YahooFinance();
const TEST_LIMIT = process.env.TEST_LIMIT ? Number(process.env.TEST_LIMIT) : null;
const DRY_RUN = process.env.DRY_RUN === "true";
const CONCURRENCY = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : 6;
const RETRIES = process.env.RETRIES ? Number(process.env.RETRIES) : 2;

// Thresholds
const ADX_THRESHOLD = process.env.ADX_THRESHOLD ? Number(process.env.ADX_THRESHOLD) : 23;
const VOLUME_MULTIPLIER = process.env.VOLUME_MULTIPLIER ? Number(process.env.VOLUME_MULTIPLIER) : 1.5;

// Telegram & Sheets envs
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Alerts";

// Logging (simple file logs)
const logsDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  fs.appendFileSync(path.join(logsDir, `${new Date().toISOString().slice(0,10)}.log`), line);
  console.log(msg);
}

// === Top-100 NSE symbols (stable list) ===
// You can replace or move to data/symbols.json to manage externally
const symbols = [
  "RELIANCE","TCS","HDFCBANK","INFY","HDFC","ICICIBANK","KOTAKBANK","LT","SBIN","AXISBANK",
  "BAJFINANCE","BHARTIARTL","ITC","HINDUNILVR","MARUTI","SUNPHARMA","BAJAJFINSV","ASIANPAINT",
  "NESTLEIND","TITAN","ONGC","POWERGRID","ULTRACEMCO","NTPC","DRREDDY","HCLTECH","INDUSINDBK",
  "DIVISLAB","ADANIPORTS","BRITANNIA","SBILIFE","ADANIENT","ADANIGREEN","BPCL","CIPLA","IOC",
  "SHREECEM","TATACONSUM","EICHERMOT","GRASIM","HINDALCO","JSWSTEEL","TECHM","M&M","HEROMOTOCO",
  "UPL","COALINDIA","TATASTEEL","HDFCLIFE","TVSMOTOR","BOSCHLTD","WIPRO","PAGEIND","GODREJPROP",
  "INDIGO","COLPAL","LTIMINDTREE","L&TFH","AUROPHARMA","SIEMENS","PIDILITIND","ICICIPRULI",
  "NMDC","DABUR","SRF","BERGEPAINT","DLF","MUTHOOTFIN","ADANITRANS","AMBUJACEM","TATAMOTORS",
  "VOLTAS","BANDHANBNK","ACC","PEL","ALKEM","GAIL","CANBK","SRTRANSFIN","JUBLFOOD","MCX",
  "AARTIIND","APOLLOHOSP","CENTURYTEX","BIOCON","ZEEL"
];

// apply TEST_LIMIT if set
const targetSymbols = TEST_LIMIT ? symbols.slice(0, TEST_LIMIT) : symbols;

// === Helpers ===

function isMarketOpenIST() {
  // Market hours considered: 9:15 - 15:30 IST
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const ist = new Date(utc + (5.5 * 60 * 60 * 1000));
  const h = ist.getHours();
  const m = ist.getMinutes();
  const hm = h + m / 60;
  return hm >= 9.25 && hm <= 15.5;
}

async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log("[Telegram] Missing env, skipping send.");
    return;
  }
  if (DRY_RUN) {
    log("[DRY_RUN] Telegram suppressed: " + msg.replace(/\n/g, " | "));
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "HTML" });
  } catch (err) {
    log("[Telegram] Error: " + (err.message || err));
    throw err;
  }
}

async function appendToSheet(row) {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !SPREADSHEET_ID) {
    log("[Sheets] Missing env, skipping append.");
    return;
  }
  if (DRY_RUN) {
    log("[DRY_RUN] Sheets append suppressed: " + JSON.stringify(row));
    return;
  }
  try {
    const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const client = new google.auth.JWT(creds.client_email, null, creds.private_key, ["https://www.googleapis.com/auth/spreadsheets"]);
    await client.authorize();
    const sheets = google.sheets({ version: "v4", auth: client });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  } catch (err) {
    log("[Sheets] Error: " + (err.message || err));
    throw err;
  }
}

function computeEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  // simple EMA calculation
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + (b || 0), 0) / period;
  for (let i = period; i < values.length; i++) {
    const v = values[i] || 0;
    ema = v * k + ema * (1 - k);
  }
  return ema;
}

function computeADX(highs, lows, closes, period = 14) {
  try {
    const input = { high: highs, low: lows, close: closes, period };
    const res = ADX(input); // returns array of numbers
    if (!Array.isArray(res) || res.length === 0) return null;
    const last = res[res.length - 1];
    // ADX() may return numbers or objects depending on lib version; handle both
    if (typeof last === "number") return last;
    if (typeof last === "object" && last.adx !== undefined) return Number(last.adx);
    return null;
  } catch (err) {
    log("[ADX] compute error: " + err.message);
    return null;
  }
}

// Extract arrays from yahoo-finance chart
function extractOHLCV(chart) {
  try {
    const r = chart?.result?.[0];
    if (!r) return null;
    const quote = r.indicators?.quote?.[0];
    const timestamps = r.timestamp || [];
    const opens = quote?.open || [];
    const highs = quote?.high || [];
    const lows = quote?.low || [];
    const closes = quote?.close || [];
    const volumes = quote?.volume || [];
    // return aligned arrays of objects
    const bars = [];
    for (let i = 0; i < timestamps.length; i++) {
      // skip null closes
      if (closes[i] == null) continue;
      bars.push({
        ts: timestamps[i] * 1000,
        open: opens[i],
        high: highs[i],
        low: lows[i],
        close: closes[i],
        volume: volumes[i]
      });
    }
    return bars;
  } catch (err) {
    log("[extractOHLCV] error: " + err.message);
    return null;
  }
}

// Convert timestamp (ms) to IST Date object
function toISTDate(tsMs) {
  const d = new Date(tsMs);
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  return new Date(utc + (5.5 * 60 * 60 * 1000));
}

// Determine ORB30: first bars between 9:15 and 9:45 IST (inclusive start, exclusive end)
function computeORB30(bars) {
  // bars: array of {ts, open, high, low, close, volume}
  const orbBars = bars.filter(b => {
    const ist = toISTDate(b.ts);
    const h = ist.getHours();
    const m = ist.getMinutes();
    // Accept 9:15 <= time < 9:45
    const hm = h + m / 60;
    return (hm >= 9.25 && hm < 9.75);
  });
  if (!orbBars.length) return null;
  const high = orbBars.reduce((a, b) => (b.high != null && b.high > a ? b.high : a), -Infinity);
  const low = orbBars.reduce((a, b) => (b.low != null && b.low < a ? b.low : a), Infinity);
  if (!isFinite(high) || !isFinite(low)) return null;
  return { high, low, bars: orbBars };
}

// Main per-symbol processing
async function processSymbol(symbol) {
  log(`→ ${symbol} START`);
  try {
    // fetch quote + chart (7d 5m)
    const quote = await pRetry(() => yahooFinance.quote(`${symbol}.NS`), { retries: RETRIES });
    const chart = await pRetry(() => yahooFinance.chart(`${symbol}.NS`, { period1: "7d", interval: "5m" }), { retries: RETRIES });

    const bars = extractOHLCV(chart);
    if (!bars || bars.length < 30) {
      log(`[${symbol}] Not enough bars (${bars ? bars.length : 0})`);
      return null;
    }

    // compute ORB30
    const orb = computeORB30(bars);
    if (!orb) {
      log(`[${symbol}] ORB30 not found`);
      return null;
    }

    // compute EMAs from closes (use last 100 closes)
    const closes = bars.map(b => b.close);
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume);

    const ema20 = computeEMA(closes, 20);
    const ema50 = computeEMA(closes, 50);
    if (ema20 == null || ema50 == null) {
      log(`[${symbol}] Insufficient data for EMAs`);
      return null;
    }

    // ADX compute requires arrays >= period+1 often; pass recent 50-100 values
    const adx = computeADX(highs.slice(-100), lows.slice(-100), closes.slice(-100), 14);
    if (adx == null) {
      log(`[${symbol}] ADX not computed`);
      return null;
    }

    // Volume spike: compare last bar volume to average of last 20 bars (exclude zero/undefined)
    const validVols = volumes.filter(v => v != null && v > 0);
    const avgVol20 = validVols.length >= 20 ? validVols.slice(-20).reduce((a,b)=>a+b,0)/20 : (validVols.reduce((a,b)=>a+b,0) / (validVols.length || 1));
    const lastVol = validVols[validVols.length - 1] || 0;
    const volumeSpike = avgVol20 > 0 ? (lastVol >= VOLUME_MULTIPLIER * avgVol20) : false;

    // Current price and last bar close
    const currentPrice = quote?.regularMarketPrice || quote?.ask || quote?.previousClose || closes[closes.length - 1];
    const lastBar = bars[bars.length - 1];

    // ORB breakout checks: breakout only after ORB period -> check last bar time is after ORB
    const lastBarIST = toISTDate(lastBar.ts);
    const lastHM = lastBarIST.getHours() + lastBarIST.getMinutes()/60;

    // Ensure we evaluate only after ORB window has completed (e.g., after 9:45)
    if (lastHM < 9.75) {
      log(`[${symbol}] Skipping until ORB window completes (current IST ${lastBarIST.toISOString()})`);
      return null;
    }

    // Check breakout relative to ORB high/low
    const brokeHigh = lastBar.close > orb.high;
    const brokeLow  = lastBar.close < orb.low;

    // Trend flags
    const upTrend = ema20 > ema50;
    const downTrend = ema20 < ema50;
    const adxOk = adx >= ADX_THRESHOLD;

    // Compose signal
    let signal = null;
    if (brokeHigh && upTrend && adxOk && volumeSpike) signal = "BUY";
    if (brokeLow && downTrend && adxOk && volumeSpike) signal = "SELL";

    if (!signal) {
      log(`[${symbol}] No signal. brokeHigh=${brokeHigh} brokeLow=${brokeLow} upTrend=${upTrend} downTrend=${downTrend} adx=${adx.toFixed(2)} volSpike=${volumeSpike}`);
      return null;
    }

    // Build message
    const msg =
      `📈 <b>${signal} SIGNAL</b>\n` +
      `Symbol: <b>${symbol}</b>\n` +
      `Price: <b>${currentPrice}</b>\n` +
      `ORB30 High/Low: <b>${orb.high}/${orb.low}</b>\n` +
      `EMA20/50: <b>${ema20.toFixed(2)}/${ema50.toFixed(2)}</b>\n` +
      `ADX: <b>${adx.toFixed(2)}</b>\n` +
      `VolumeSpike: <b>${volumeSpike ? "YES" : "NO"}</b>\n` +
      `Time (IST): ${lastBarIST.toLocaleString()}`;

    log(`[${symbol}] SIGNAL => ${signal} price=${currentPrice} adx=${adx.toFixed(2)} volSpike=${volumeSpike}`);
    await sendTelegram(msg);

    // Append to sheet: timestamp, symbol, signal, price, EMA20, EMA50, ADX, volSpike
    const row = [ new Date().toISOString(), symbol, signal, currentPrice, ema20.toFixed(2), ema50.toFixed(2), adx.toFixed(2), volumeSpike ? "YES" : "NO" ];
    await appendToSheet(row);

    return { symbol, signal, price: currentPrice };
  } catch (err) {
    log(`[${symbol}] ERROR: ${err.message || err}`);
    return null;
  }
}

// Main runner
async function runScanner() {
  log("=== Trade Scanner START ===");
  try {
    if (!isMarketOpenIST()) {
      log("Market closed (IST). Exiting.");
      return;
    }
    const limit = pLimit(CONCURRENCY);
    const tasks = targetSymbols.map(sym => limit(() => pRetry(() => processSymbol(sym), { retries: RETRIES }).catch(e => { log(`[${sym}] final failure: ${e.message || e}`); } )));
    const results = await Promise.all(tasks);
    const signals = results.filter(Boolean);
    const health = `Scan complete. Signals: ${signals.length} / ${targetSymbols.length}`;
    log(health);
    await sendTelegram(`Trade Scanner Status: OK\n${health}`);
  } catch (err) {
    log("Scanner crashed: " + (err.message || err));
    try { await sendTelegram(`❌ Trade Scanner CRASHED\nReason: ${(err.message||err)}`); } catch {}
    process.exit(1);
  }
}

runScanner();
