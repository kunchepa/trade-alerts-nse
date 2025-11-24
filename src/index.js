// src/index.js
import fs from "fs";
import axios from "axios";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import { EMA, ADX } from "technicalindicators";

// ---------- Config / env ----------
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  SPREADSHEET_ID,
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing");
  process.exit(1);
}
if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
  console.error("❌ GOOGLE_SERVICE_ACCOUNT_JSON missing");
  process.exit(1);
}
if (!SPREADSHEET_ID) {
  console.error("❌ SPREADSHEET_ID missing");
  process.exit(1);
}

const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
const auth = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheets = google.sheets({ version: "v4", auth });

// ---------- Helpers ----------
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function retry(fn, attempts = 3, delayMs = 1000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } 
    catch (err) { lastErr = err; await sleep(delayMs * (i+1)); }
  }
  throw lastErr;
}

// Send telegram alert with retries
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await retry(() => axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown",
    }), 3, 800);
    console.log("Telegram sent");
  } catch (err) {
    console.error("Telegram error:", err?.response?.data || err.message);
  }
}

// Write to Google Sheets with retries
async function writeToSheet(row) {
  try {
    await retry(() => sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Alerts!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    }), 3, 800);
    console.log("Sheet append OK");
  } catch (err) {
    console.error("Sheet error:", err?.response?.data || err.message);
  }
}

// ---------- Strategy ----------
function applyStrategy(data) {
  // data: array of {time, open, high, low, close, volume}
  const close = data.map(d => d.close);
  const high = data.map(d => d.high);
  const low = data.map(d => d.low);
  const volume = data.map(d => d.volume);

  const ema = EMA.calculate({ period: 20, values: close });
  const adx = ADX.calculate({ close, high, low, period: 14 });

  if (!ema.length || !adx.length) return false;

  const latest = data[data.length - 1];
  const prev = data[data.length - 2];

  const orbBreakout = latest.high > prev.high && latest.low > prev.low;
  const volumeSpike = (latest.volume || 0) > 1.5 * (prev.volume || 1);
  const emaSupport = latest.close > ema[ema.length - 1];
  const strongTrend = (adx[adx.length - 1] && adx[adx.length - 1].adx) ? adx[adx.length - 1].adx > 25 : false;

  return orbBreakout && volumeSpike && emaSupport && strongTrend;
}

// ---------- Candle fetch (Yahoo) ----------
async function getYahooCandles5m(symbol) {
  // Yahoo expects symbol with exchange suffix e.g. RELIANCE.NS
  const yfSymbol = `${symbol}.NS`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSymbol)}?interval=5m&range=2d`;
  const res = await axios.get(url, { timeout: 15000 });
  const chart = res.data?.chart?.result?.[0];
  if (!chart) throw new Error("No chart result");
  const timestamps = chart.timestamp || [];
  const quote = chart.indicators?.quote?.[0];
  if (!quote) throw new Error("No quote in chart");
  const { open, high, low, close, volume } = quote;

  // build candles array, filter out nulls
  const candles = timestamps.map((t, i) => ({
    time: new Date(t * 1000),
    open: open?.[i] ?? null,
    high: high?.[i] ?? null,
    low: low?.[i] ?? null,
    close: close?.[i] ?? null,
    volume: volume?.[i] ?? 0,
  })).filter(c => c.open !== null && c.close !== null && c.high !== null && c.low !== null);

  return candles;
}

// ---------- Symbols (smaller list for speed) ----------
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

// ---------- Lockfile to avoid overlapping runs ----------
const LOCKFILE = "/tmp/trade-alerts.lock";

function acquireLock() {
  try {
    if (fs.existsSync(LOCKFILE)) {
      const pid = fs.readFileSync(LOCKFILE, "utf8");
      console.log("Lock exists, previous PID:", pid);
      return false;
    }
    fs.writeFileSync(LOCKFILE, String(process.pid));
    return true;
  } catch (err) {
    console.error("Lockfile error", err.message);
    return false;
  }
}

function releaseLock() {
  try { if (fs.existsSync(LOCKFILE)) fs.unlinkSync(LOCKFILE); }
  catch (err) { /* ignore */ }
}

// ---------- Main ----------
async function run() {
  if (!acquireLock()) {
    console.log("Previous run still active — exiting.");
    return;
  }

  console.log("Start run:", new Date().toISOString());
  try {
    for (const symbol of symbols) {
      try {
        console.log("Fetching:", symbol);
        const candles = await getYahooCandles5m(symbol);
        console.log(symbol, "CANDLES RECEIVED:", candles.length);
        if (!candles || candles.length < 30) {
          console.log(symbol, "Not enough candles, skipping");
          continue;
        }

        const qualified = applyStrategy(candles);
        console.log(symbol, "QUALIFIED:", qualified);

        if (qualified) {
          const latest = candles[candles.length-1];
          const message = `📈 *Trade Alert*: ${symbol}\nORB + EMA + ADX + Volume breakout.\nTime: ${latest.time.toLocaleString()}\nClose: ${latest.close}`;
          await sendTelegram(message);
          await writeToSheet([symbol, new Date().toISOString(), latest.close, "Alert Triggered"]);
        }

        // polite delay to avoid hitting Yahoo too fast
        await sleep(600);
      } catch (err) {
        console.error(`Error for ${symbol}:`, err?.response?.data || err?.message || err);
        // small pause after error to avoid rapid failures
        await sleep(1000);
      }
    }
  } finally {
    releaseLock();
    console.log("Run finished:", new Date().toISOString());
  }
}

run().catch(err => {
  console.error("Fatal error:", err?.message || err);
  releaseLock();
  process.exit(1);
});
