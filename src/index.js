/**
 * NSE EMA Scanner (Yahoo removed)
 */

import fetch from "node-fetch";
import { EMA, RSI } from "technicalindicators";
import { GoogleSpreadsheet } from "google-spreadsheet";

/* ================= CONFIG ================= */

const SL_PCT = 0.7;
const TARGET_PCT = 1.4;
const MIN_CONFIDENCE = 60;
const COOLDOWN_MINUTES = 30;
const DELAY_MS = 1200;

/* ================= SYMBOLS ================= */

const SYMBOLS = [
  "RELIANCE.NS","TCS.NS","HDFCBANK.NS","INFY.NS","HDFC.NS","ICICIBANK.NS","KOTAKBANK.NS","LT.NS",
  "SBIN.NS","AXISBANK.NS","BAJFINANCE.NS","BHARTIARTL.NS","ITC.NS","HINDUNILVR.NS","MARUTI.NS",
  "SUNPHARMA.NS","BAJAJFINSV.NS","ASIANPAINT.NS","NESTLEIND.NS","TITAN.NS","ONGC.NS","POWERGRID.NS",
  "ULTRACEMCO.NS","NTPC.NS","DRREDDY.NS","HCLTECH.NS","INDUSINDBK.NS","DIVISLAB.NS","ADANIPORTS.NS",
  "JSWSTEEL.NS","COALINDIA.NS","ADANIENT.NS","M&M.NS","TATASTEEL.NS","GRASIM.NS","WIPRO.NS",
  "HDFCLIFE.NS","TECHM.NS","SBILIFE.NS","BRITANNIA.NS","CIPLA.NS","EICHERMOT.NS","HINDALCO.NS",
  "HEROMOTOCO.NS","BPCL.NS","SHREECEM.NS","IOC.NS","TATACONSUM.NS","UPL.NS","ADANIGREEN.NS",
  "VEDL.NS","DLF.NS","PIDILITIND.NS","ICICIPRULI.NS","JSWENERGY.NS","BANKBARODA.NS","CANBK.NS",
  "PNB.NS","UNIONBANK.NS","BANDHANBNK.NS","IDFCFIRSTB.NS","GAIL.NS","TATAPOWER.NS","TORNTPHARM.NS",
  "ABB.NS","SIEMENS.NS","MUTHOOTFIN.NS","BAJAJ-AUTO.NS","PEL.NS","AMBUJACEM.NS","ACC.NS","BEL.NS",
  "HAL.NS","IRCTC.NS","PAYTM.NS","POLYCAB.NS","ZOMATO.NS","NAUKRI.NS","BOSCHLTD.NS","ASHOKLEY.NS",
  "TVSMOTOR.NS","MFSL.NS","CHOLAFIN.NS","INDIGO.NS","DABUR.NS","EMAMILTD.NS","MGL.NS","IGL.NS",
  "LUPIN.NS","BIOCON.NS","APOLLOHOSP.NS","MAXHEALTH.NS","FORTIS.NS"
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
      text: msg,
      parse_mode: "Markdown"
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

  const url = `https://www.nseindia.com/api/chart-databyindex?index=${symbol}EQN&indices=true`;

  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
      "Referer": "https://www.nseindia.com",
      "Cookie": cookie
    }
  });

  const j = await r.json();
  return j?.grapthData || [];
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

const alerted = new Map();

async function run() {

  for (const sym of SYMBOLS) {

    try {

      await sleep(DELAY_MS);

      const raw = await fetchNSECandles(sym);
      if (raw.length < 40) continue;

      const closes = raw.map(x => x[1]).filter(Boolean);

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
      const sl = entry * (1 - SL_PCT/100);
      const target = entry * (1 + TARGET_PCT/100);

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

      console.log(`✅ ${sym}`);

    } catch(e) {
      console.log(`❌ ${sym}`, e.message);
      cookie = "";
    }
  }
}

await run();
