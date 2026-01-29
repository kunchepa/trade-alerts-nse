/**
 * NSE EMA Scanner – PRODUCTION VERSION
 */

import fetch from "node-fetch";
import { EMA, RSI } from "technicalindicators";
import { GoogleSpreadsheet } from "google-spreadsheet";

/* ================= CONFIG ================= */

const SL_PCT = 0.7;
const TARGET_PCT = 1.4;
const MIN_CONFIDENCE = 60;
const DELAY_MS = 1200;
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
];


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
  return (h > 8 || (h === 8 && m >= 30)) && (h < 15 || (h === 15 && m <= 30));
}

async function sendTelegram(msg) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: msg })
  });
}

async function logToSheet(row) {
  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);
  await doc.useServiceAccountAuth(JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
  await doc.loadInfo();
  await doc.sheetsByIndex[0].addRow(row);
}

/* ================= NSE ================= */

let cookie = "";

async function refreshCookie() {
  const r = await fetch("https://www.nseindia.com", {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  cookie = r.headers.get("set-cookie");
}

async function fetchNSECandles(symbol) {
  if (!cookie) await refreshCookie();

  const url = `https://www.nseindia.com/api/chart-databyindex?index=${symbol}`;

  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
      "Referer": "https://www.nseindia.com",
      "Cookie": cookie
    }
  });

  const j = await r.json();
  return j?.grapthData?.map(x => Number(x[1])).filter(Boolean) || [];
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
    console.log("⏰ Market closed — skipping scan");
    return;
  }

  for (const sym of SYMBOLS) {

    try {

      console.log("Scanning", sym);
      await sleep(DELAY_MS);

      const closes = await fetchNSECandles(sym);
      if (closes.length < 40) continue;

      const ema9 = EMA.calculate({ period: 9, values: closes }).at(-1);
      const ema21 = EMA.calculate({ period: 21, values: closes }).at(-1);
      const prev9 = EMA.calculate({ period: 9, values: closes.slice(0,-1) }).at(-1);
      const prev21 = EMA.calculate({ period: 21, values: closes.slice(0,-1) }).at(-1);
      const rsi = RSI.calculate({ period: 14, values: closes }).at(-1);

      if (!ema9 || !ema21 || !prev9 || !prev21 || !rsi) continue;

      const fresh = prev9 <= prev21 && ema9 > ema21;
      if (!fresh || rsi < 50) continue;

      const conf = confidence(ema9, ema21, rsi);
      if (conf < MIN_CONFIDENCE) continue;

      const last = cooldown.get(sym);
      if (last && Date.now() - last < COOLDOWN_MINUTES * 60000) continue;

      cooldown.set(sym, Date.now());

      const entry = closes.at(-1);
      const sl = entry * (1 - SL_PCT / 100);
      const target = entry * (1 + TARGET_PCT / 100);

      const msg = `📈 BUY SIGNAL

${sym}
Entry: ${entry.toFixed(2)}
SL: ${sl.toFixed(2)}
Target: ${target.toFixed(2)}
Confidence: ${conf}/100`;

      await sendTelegram(msg);

      await logToSheet({
        Symbol: sym,
        Entry: entry,
        SL: sl,
        Target: target,
        Confidence: conf,
        Time: new Date().toISOString()
      });

      console.log(`✅ Alert sent: ${sym}`);

    } catch (e) {
      console.log(`❌ ${sym}`, e.message);
      cookie = "";
    }
  }
}

await run();
