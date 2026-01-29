/**
 * NSE EMA Scanner – FIXED PRODUCTION VERSION (Yahoo Finance Backend)
 */

import fetch from "node-fetch";
import { EMA, RSI } from "technicalindicators";
import { GoogleSpreadsheet } from "google-spreadsheet";
import yahooFinance from "yahoo-finance2";  // NEW: Reliable free source for NSE data

/* ================= CONFIG ================= */

const SL_PCT = 0.7;
const TARGET_PCT = 1.4;
const MIN_CONFIDENCE = 60;
const DELAY_MS = 2000;  // Increased for safety (Yahoo allows ~2000 calls/hour free)
const COOLDOWN_MINUTES = 30;

/* ================= SYMBOLS ================= */

const SYMBOLS = [
  "RELIANCE","TCS","HDFCBANK","INFY","HDFC","ICICIBANK","KOTAKBANK","LT",
  "SBIN","AXISBANK","BAJFINANCE","BHARTIARTL","ITC","HINDUNILVR","MARUTI",
  "SUNPHARMA","BAJAJFINSV","ASIANPAINT","NESTLEIND","TITAN","ONGC","POWERGRID",
  "ULTRACEMCO","NTPC","DRREDDY","HCLTECH","INDUSINDBK","DIVISLAB","ADANIPORTS",
  "JSWSTEEL","COALINDIA","ADANIENT","M&M","TATASTEEL","GRASIM","WIPRO",
  "HDFCLIFE","TECHM","SBILIFE","BRITANNIA","CIPLA","EICHERMOT","HINDALCO",
  "HEROMOTOCO","BPCL","SHREECEM","IOC","TATACONSUM","UPL","ADANIGREEN",
  "VEDL","DLF","PIDILITIND","ICICIPRULI","JSWENERGY","BANKBARODA","CANBK",
  "PNB","UNIONBANK","BANDHANBNK","IDFCFIRSTB","GAIL","TATAPOWER","TORNTPHARM",
  "ABB","SIEMENS","MUTHOOTFIN","BAJAJ-AUTO","PEL","AMBUJACEM","ACC","BEL",
  "HAL","IRCTC","PAYTM","POLYCAB","ETERNAL","NAUKRI","BOSCHLTD","ASHOKLEY","TMCV",
  "TVSMOTOR","MFSL","CHOLAFIN","INDIGO","DABUR","EMAMILTD","MGL","IGL",
  "LUPIN","BIOCON","APOLLOHOSP","MAXHEALTH","FORTIS"
].map(sym => `${sym}.NS`);  // Add .NS suffix for Yahoo Finance NSE

/* ================= ENV ================= */

const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "SPREADSHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON"
];

for (const k of REQUIRED_ENV) {
  if (!process.env[k]) throw new Error(`Missing ENV ${k}`);
}

console.log("✅ All environment variables loaded");

/* ================= HELPERS ================= */

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isMarketOpenIST() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours();
  const m = ist.getMinutes();
  const day = ist.getDay();  // 0=Sunday, 6=Saturday
  if (day === 0 || day === 6) return false;  // Weekend
  return (h > 8 || (h === 8 && m >= 30)) && (h < 15 || (h === 15 && m <= 30));
}

async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: msg })
    });
  } catch (e) {
    console.error("Telegram send failed:", e.message);
  }
}

async function logToSheet(row) {
  try {
    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);
    await doc.useServiceAccountAuth(JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
    await doc.loadInfo();
    await doc.sheetsByIndex[0].addRow(row);
  } catch (e) {
    console.error("Sheet log failed:", e.message);
  }
}

/* ================= YAHOO FINANCE DATA ================= */

async function fetchCloses(symbol) {
  try {
    console.log(`Fetching data for ${symbol.replace('.NS', '')}`);
    
    // Fetch last ~3 months daily data (enough for EMA21 + buffer)
    const quote = await yahooFinance.historical(symbol, {
      period: "3mo",   // or { from: "2025-01-01" }
      interval: "1d"
    });

    if (!quote || quote.length < 40) {
      console.log(`Not enough data for ${symbol.replace('.NS', '')} (${quote?.length || 0} candles)`);
      return [];
    }

    const closes = quote.map(day => day.close).filter(Boolean);
    console.log(`Got ${closes.length} closes for ${symbol.replace('.NS', '')}`);
    return closes;
  } catch (e) {
    console.error(`Yahoo fetch error for ${symbol.replace('.NS', '')}:`, e.message);
    return [];
  }
}

/* ================= CONFIDENCE ================= */

function confidence(ema9, ema21, rsi) {
  let s = 0;
  if (ema9 > ema21) s += 40;
  if (rsi > 55 && rsi < 70) s += 30;
  if (rsi > 50) s += 30;
  return s;
}

/* ================= MAIN ================= */

const cooldown = new Map();

async function run() {
  if (!isMarketOpenIST()) {
    console.log("⏰ Market closed or weekend — skipping scan");
    return;
  }

  console.log(`Starting scan of ${SYMBOLS.length} symbols...`);

  for (const sym of SYMBOLS) {
    const plainSym = sym.replace('.NS', '');

    try {
      console.log(`Scanning ${plainSym}`);
      await sleep(DELAY_MS);

      const closes = await fetchCloses(sym);
      if (closes.length < 40) continue;

      const ema9 = EMA.calculate({ period: 9, values: closes }).at(-1);
      const ema21 = EMA.calculate({ period: 21, values: closes }).at(-1);
      const prev9 = EMA.calculate({ period: 9, values: closes.slice(0, -1) }).at(-1);
      const prev21 = EMA.calculate({ period: 21, values: closes.slice(0, -1) }).at(-1);
      const rsi = RSI.calculate({ period: 14, values: closes }).at(-1);

      if (!ema9 || !ema21 || !prev9 || !prev21 || !rsi) continue;

      const fresh = prev9 <= prev21 && ema9 > ema21;
      if (!fresh || rsi < 50) continue;

      const conf = confidence(ema9, ema21, rsi);
      if (conf < MIN_CONFIDENCE) continue;

      const last = cooldown.get(plainSym);
      if (last && Date.now() - last < COOLDOWN_MINUTES * 60000) {
        console.log(`Cooldown active for ${plainSym}`);
        continue;
      }

      cooldown.set(plainSym, Date.now());

      const entry = closes.at(-1);
      const sl = entry * (1 - SL_PCT / 100);
      const target = entry * (1 + TARGET_PCT / 100);

      const msg = `📈 BUY SIGNAL

${plainSym}
Entry: ${entry.toFixed(2)}
SL: ${sl.toFixed(2)}
Target: ${target.toFixed(2)}
Confidence: ${conf}/100`;

      await sendTelegram(msg);
      await logToSheet({
        Symbol: plainSym,
        Entry: entry,
        SL: sl,
        Target: target,
        Confidence: conf,
        Time: new Date().toISOString()
      });

      console.log(`✅ Alert sent: ${plainSym} (Conf: ${conf})`);

    } catch (e) {
      console.error(`❌ Error on ${plainSym}:`, e.message);
    }
  }

  console.log("Scan completed!");
}

await run();
