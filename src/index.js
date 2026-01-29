/**
 * NSE EMA Scanner – FINAL REVISED VERSION (No new files, debug for Sheets)
 */

import fetch from "node-fetch";
import { EMA, RSI } from "technicalindicators";
import { GoogleSpreadsheet } from "google-spreadsheet";
import YahooFinance from "yahoo-finance2";

// Suppress deprecation notice
const yahoo = new YahooFinance({
  suppressNotices: ['ripHistorical']
});

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

/* ================= ENV CHECK ================= */
const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "SPREADSHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON"
];

for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`CRITICAL: Missing env ${k}`);
    process.exit(1);
  }
}
console.log("✅ All env variables loaded");

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
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: msg, parse_mode: "Markdown" })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("Telegram failed:", res.status, errText);
    } else {
      console.log("Telegram sent OK");
    }
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

async function logToSheet(row) {
  try {
    console.log("[SHEET] Logging row for:", row.Symbol);

    const spreadsheetId = process.env.SPREADSHEET_ID;
    console.log("[SHEET] Spreadsheet ID:", spreadsheetId.substring(0, 10) + "...");

    let auth;
    try {
      auth = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      console.log("[SHEET] Auth parsed, email:", auth.client_email);
    } catch (err) {
      console.error("[SHEET] JSON parse error:", err.message);
      console.error("[SHEET] Secret length:", process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.length || 0);
      throw err;
    }

    const doc = new GoogleSpreadsheet(spreadsheetId);
    await doc.useServiceAccountAuth(auth);
    await doc.loadInfo();
    console.log("[SHEET] Doc loaded:", doc.title);

    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow(row);
    console.log(`[SHEET] SUCCESS: Added ${row.Symbol}`);
  } catch (e) {
    console.error("[SHEET] FAIL:", e.message);
    if (e.code) console.error("Error code:", e.code);
    if (e.response?.data) console.error("Google response:", JSON.stringify(e.response.data));
  }
}

/* ================= DATA FETCH ================= */
async function fetchCloses(symbol) {
  try {
    const plain = symbol.replace('.NS', '');
    console.log(`Fetching ${plain}`);

    const to = Math.floor(Date.now() / 1000);
    const from = to - (90 * 24 * 60 * 60);

    const history = await yahoo.historical(symbol, {
      period1: from,
      period2: to,
      interval: "1d"
    });

    if (!history || history.length < 40) {
      console.log(`No enough data ${plain} (${history?.length || 0})`);
      return [];
    }

    const closes = history.map(day => day.close).filter(v => !isNaN(v));
    console.log(`Got ${closes.length} closes for ${plain}`);
    return closes;
  } catch (e) {
    console.error(`Fetch fail ${symbol}:`, e.message);
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
    console.log("Market closed, skipping");
    return;
  }

  console.log(`Scan start - ${SYMBOLS.length} symbols`);

  for (const sym of SYMBOLS) {
    const plainSym = sym.replace('.NS', '');

    try {
      await sleep(DELAY_MS);
      const closes = await fetchCloses(sym);
      if (closes.length < 40) continue;

      const ema9   = EMA.calculate({ period: 9, values: closes }).at(-1);
      const ema21  = EMA.calculate({ period: 21, values: closes }).at(-1);
      const prev9  = EMA.calculate({ period: 9, values: closes.slice(0, -1) }).at(-1);
      const prev21 = EMA.calculate({ period: 21, values: closes.slice(0, -1) }).at(-1);
      const rsi    = RSI.calculate({ period: 14, values: closes }).at(-1);

      if (!ema9 || !ema21 || !prev9 || !prev21 || !rsi) continue;

      const crossover = prev9 <= prev21 && ema9 > ema21;
      if (!crossover || rsi < 50) continue;

      const conf = confidence(ema9, ema21, rsi);
      if (conf < MIN_CONFIDENCE) continue;

      if (cooldown.has(plainSym) && Date.now() - cooldown.get(plainSym) < COOLDOWN_MINUTES * 60000) {
        console.log(`Cooldown: ${plainSym}`);
        continue;
      }

      cooldown.set(plainSym, Date.now());

      const entry  = closes.at(-1);
      const sl     = entry * (1 - SL_PCT / 100);
      const target = entry * (1 + TARGET_PCT / 100);

      const msg = `📈 BUY SIGNAL\n\n**${plainSym}**\nEntry: ${entry.toFixed(2)}\nSL: ${sl.toFixed(2)}\nTarget: ${target.toFixed(2)}\nConfidence: ${conf}/100`;

      await sendTelegram(msg);

      await logToSheet({
        Symbol: plainSym,
        Direction: "BUY",
        EntryPrice: entry,
        Target: target,
        StopLoss: sl,
        Plus2Check: "PENDING",
        Confidence: conf,
        Time: new Date().toISOString()
      });

      console.log(`Alert sent: ${plainSym} (Conf ${conf})`);

    } catch (e) {
      console.error(`Error ${plainSym}:`, e.message);
    }
  }

  console.log("Scan complete!");
}

await run();
