/**
 * NSE 5-Min EMA Scanner – minimal patch version
 * (ONLY sheets auth + yahoo chart fixed)
 */

import yahooFinance from "yahoo-finance2";
import { EMA, RSI } from "technicalindicators";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

// ================= CONFIG =================

const SL_PCT = 0.7;
const TARGET_PCT = 1.4;
const MIN_CONFIDENCE = 60;

const INTERVAL = "5m";
const LOOKBACK_DAYS = 5;

// ========================================

const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "SPREADSHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON"
];

for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`❌ Missing env: ${k}`);
    process.exit(1);
  }
}

console.log("✅ Environment variables loaded");

// ===== YOUR EXISTING SYMBOL LIST (unchanged) =====

const SYMBOLS = [
"RELIANCE.NS","TCS.NS","HDFCBANK.NS","INFY.NS","ICICIBANK.NS","SBIN.NS",
"BHARTIARTL.NS","ITC.NS","LT.NS","BAJFINANCE.NS","HINDUNILVR.NS","MARUTI.NS",
"AXISBANK.NS","KOTAKBANK.NS","SUNPHARMA.NS","TITAN.NS","NTPC.NS","ONGC.NS",
"POWERGRID.NS","ADANIPORTS.NS","JSWSTEEL.NS","WIPRO.NS","TECHM.NS","HCLTECH.NS",
"TATASTEEL.NS","COALINDIA.NS","ULTRACEMCO.NS","BAJAJFINSV.NS","NESTLEIND.NS",
"ASIANPAINT.NS","BPCL.NS","GRASIM.NS","DIVISLAB.NS","ADANIENT.NS","BEL.NS",
"HAL.NS","IOC.NS","HINDALCO.NS","SBILIFE.NS","EICHERMOT.NS","DLF.NS",
"PIDILITIND.NS","BRITANNIA.NS","PNB.NS","CANBK.NS","TATAPOWER.NS",
"HEROMOTOCO.NS","GAIL.NS","DRREDDY.NS","SIEMENS.NS","SHREECEM.NS",
"MAXHEALTH.NS","ZYDUSLIFE.NS","HAVELLS.NS","POLYCAB.NS","NAUKRI.NS",
"PAYTM.NS","MUTHOOTFIN.NS","ACC.NS","ASHOKLEY.NS","DABUR.NS","LUPIN.NS",
"BIOCON.NS","ABB.NS","TATACONSUM.NS","UPL.NS","UNIONBANK.NS","IDFCFIRSTB.NS"
];

// ================= HELPERS =================

const sleep = ms => new Promise(r => setTimeout(r, ms));

function istTime() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

// yahoo-finance2 FIX: use _chart
async function fetchWithRetry(symbol, opts, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await yahooFinance._chart(symbol, opts);
    } catch (e) {
      if (i === retries) throw e;
      console.log(`⏳ Retry ${i + 1} for ${symbol}`);
      await sleep(1500);
    }
  }
}

// ================= TELEGRAM =================

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

// ================= GOOGLE SHEETS =================

let sheet;

async function initSheet() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);

  await doc.useServiceAccountAuth({
    client_email: creds.client_email,
    private_key: creds.private_key
  });

  await doc.loadInfo();

  sheet = doc.sheetsByTitle["Alerts"];
  if (!sheet) throw new Error("Alerts sheet not found");

  console.log("✅ Google Sheet connected");
}



// ================= CONFIDENCE =================

function confidence(ema9, ema21, rsi) {
  let s = 0;
  if (ema9 > ema21) s += 40;
  if (rsi > 55 && rsi < 70) s += 30;
  if (rsi > 50) s += 30;
  return s;
}

// ================= MAIN =================

async function run() {
  console.log("🚀 Scanner started");

  await initSheet();

  const p2 = Math.floor(Date.now() / 1000);
  const p1 = p2 - LOOKBACK_DAYS * 86400;

  let alerts = 0;

  for (const s of SYMBOLS) {
    try {
      const r = await fetchWithRetry(s, {
        interval: INTERVAL,
        period1: p1,
        period2: p2
      });

      const candles = r?.quotes;
      if (!candles || candles.length < 40) continue;

      const closes = candles.map(c => c.close).filter(Boolean);

      const ema9 = EMA.calculate({ period: 9, values: closes }).at(-1);
      const ema21 = EMA.calculate({ period: 21, values: closes }).at(-1);
      const prev9 = EMA.calculate({ period: 9, values: closes.slice(0, -1) }).at(-1);
      const prev21 = EMA.calculate({ period: 21, values: closes.slice(0, -1) }).at(-1);
      const rsi = RSI.calculate({ period: 14, values: closes }).at(-1);

      if (!(prev9 <= prev21 && ema9 > ema21 && rsi > 50)) continue;

      const conf = confidence(ema9, ema21, rsi);
      if (conf < MIN_CONFIDENCE) continue;

      const entry = closes.at(-1);
      const sl = entry * (1 - SL_PCT / 100);
      const tgt = entry * (1 + TARGET_PCT / 100);

      await sendTelegram(
        `BUY ${s}\nEntry ${entry.toFixed(2)}\nSL ${sl.toFixed(2)}\nTarget ${tgt.toFixed(2)}`
      );

      await sheet.addRow({
        TimeIST: istTime(),
        Symbol: s,
        Direction: "BUY",
        EntryPrice: entry,
        Target: tgt,
        StopLoss: sl,
        Plus2Check: "PENDING",
        Confidence: conf,
        RawTimeUTC: new Date().toISOString()
      });

      alerts++;
      console.log(`✅ ${s}`);

      await sleep(400);

    } catch (e) {
      console.error(`❌ ${s}`, e.message);
    }
  }

  console.log(`🏁 Done. Alerts: ${alerts}`);
}

run().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
