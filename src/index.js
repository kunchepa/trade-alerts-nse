/**
 * NSE EMA Scanner – FINAL WORKING VERSION
 */

import fetch from "node-fetch";
import { EMA, RSI } from "technicalindicators";
import { GoogleSpreadsheet } from "google-spreadsheet";

/* ================= CONFIG ================= */

const SL_PCT = 0.7;
const TARGET_PCT = 1.4;
const MIN_CONFIDENCE = 60;
const DELAY_MS = 1200;

/* ================= SYMBOLS (NO .NS) ================= */

const SYMBOLS = [
  "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","SBIN","AXISBANK","ITC",
  "LT","BHARTIARTL","BAJFINANCE","MARUTI","SUNPHARMA","ONGC","TATASTEEL",
  "WIPRO","ADANIPORTS","JSWSTEEL","HINDALCO","POWERGRID","NTPC","TECHM",
  "ZOMATO","IRCTC","BEL","HAL","IOC","PNB","CANBK"
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

async function sendTelegram(msg) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: msg
    })
  });
}

async function logToSheet(row) {
  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);
  await doc.useServiceAccountAuth(JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
  await doc.loadInfo();
  await doc.sheetsByIndex[0].addRow(row);
}

/* ================= NSE FETCH ================= */

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

  return j?.grapthData?.map(x => Number(x[1])) || [];
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

async function run() {

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

      const entry = closes.at(-1);
      const sl = entry * (1 - SL_PCT / 100);
      const target = entry * (1 + TARGET_PCT / 100);

      const msg = `
📈 BUY SIGNAL

${sym}
Entry: ${entry.toFixed(2)}
SL: ${sl.toFixed(2)}
Target: ${target.toFixed(2)}
Confidence: ${conf}/100
`;

      await sendTelegram(msg);

      await logToSheet({
        Symbol: sym,
        Entry: entry,
        SL: sl,
        Target: target,
        Confidence: conf,
        Time: new Date().toISOString()
      });

      console.log(`✅ Alert sent for ${sym}`);

    } catch(e) {
      console.log(`❌ ${sym}`, e.message);
      cookie = "";
    }
  }
}

await run();
