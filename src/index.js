/**
 * NSE EMA Scanner – FIXED v3 YAHOO-FINANCE2 VERSION
 */

import fetch from "node-fetch";
import { EMA, RSI } from "technicalindicators";
import { GoogleSpreadsheet } from "google-spreadsheet";
import YahooFinance from "yahoo-finance2";  // ← Changed: capital Y, class import

/* ================= CONFIG ================= */

const SL_PCT = 0.7;
const TARGET_PCT = 1.4;
const MIN_CONFIDENCE = 60;
const DELAY_MS = 2000;
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
].map(sym => `${sym}.NS`);

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
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  return (h > 8 || (h === 8 && m >= 30)) && (h < 15 || (h === 15 && m <= 30));
}

async function sendTelegram(msg) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: msg })
    });
    if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
  } catch (e) {
    console.error("Telegram failed:", e.message);
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

/* ================= YAHOO FINANCE v3 ================= */

const yahoo = new YahooFinance();  // ← NEW: Instantiate once here!

async function fetchCloses(symbol) {
  try {
    const plain = symbol.replace('.NS', '');
    console.log(`Fetching ${plain}`);

    const history = await yahoo.historical(symbol, {  // ← yahoo. (instance), not yahooFinance.
      period: "3mo",
      interval: "1d"
    });

    if (!history || history.length < 40) {
      console.log(`Insufficient data ${plain} (${history?.length || 0} days)`);
      return [];
    }

    const closes = history.map(day => day.close).filter(v => typeof v === 'number' && !isNaN(v));
    console.log(`Got ${closes.length} closes for ${plain}`);
    return closes;
  } catch (e) {
    console.error(`Fetch error ${symbol.replace('.NS', '')}:`, e.message);
    return [];
  }
}

/* ================= CONFIDENCE ================= */

function confidence(ema9, ema21, rsi) {
  let score = 0;
  if (ema9 > ema21) score += 40;
  if (rsi > 55 && rsi < 70) score += 30;
  if (rsi > 50) score += 30;
  return score;
}

/* ================= MAIN ================= */

const cooldown = new Map();

async function run() {
  if (!isMarketOpenIST()) {
    console.log("⏰ Market closed or weekend — skipping");
    return;
  }

  console.log(`Scan started — ${SYMBOLS.length} symbols`);

  for (const sym of SYMBOLS) {
    const plainSym = sym.replace('.NS', '');

    try {
      console.log(`Scanning ${plainSym}`);
      await sleep(DELAY_MS);

      const closes = await fetchCloses(sym);
      if (closes.length < 40) continue;

      const ema9    = EMA.calculate({ period: 9,  values: closes }).at(-1);
      const ema21   = EMA.calculate({ period: 21, values: closes }).at(-1);
      const prev9   = EMA.calculate({ period: 9,  values: closes.slice(0, -1) }).at(-1);
      const prev21  = EMA.calculate({ period: 21, values: closes.slice(0, -1) }).at(-1);
      const rsi     = RSI.calculate({ period: 14, values: closes }).at(-1);

      if (!ema9 || !ema21 || !prev9 || !prev21 || !rsi) continue;

      const freshCrossover = prev9 <= prev21 && ema9 > ema21;
      if (!freshCrossover || rsi < 50) continue;

      const conf = confidence(ema9, ema21, rsi);
      if (conf < MIN_CONFIDENCE) continue;

      const lastAlert = cooldown.get(plainSym);
      if (lastAlert && Date.now() - lastAlert < COOLDOWN_MINUTES * 60_000) {
        console.log(`Cooldown skip ${plainSym}`);
        continue;
      }

      cooldown.set(plainSym, Date.now());

      const entry  = closes.at(-1);
      const sl     = entry * (1 - SL_PCT / 100);
      const target = entry * (1 + TARGET_PCT / 100);

      const msg = `📈 BUY SIGNAL\n\n${plainSym}\nEntry: ${entry.toFixed(2)}\nSL: ${sl.toFixed(2)}\nTarget: ${target.toFixed(2)}\nConfidence: ${conf}/100`;

      await sendTelegram(msg);
      await logToSheet({
        Symbol: plainSym,
        Entry: entry,
        SL: sl,
        Target: target,
        Confidence: conf,
        Time: new Date().toISOString()
      });

      console.log(`✅ Alert sent: ${plainSym} (Conf ${conf})`);

    } catch (e) {
      console.error(`Error ${plainSym}:`, e.message);
    }
  }

  console.log("Full scan completed!");
}

await run();
