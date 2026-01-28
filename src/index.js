/**
 * NSE 5-Min EMA Scanner – fixed for rate limit + timeouts + latest symbols
 * (sheets auth + yahoo chart fixed + delays + request timeout)
 */

import yahooFinance from "yahoo-finance2";
import { EMA, RSI } from "technicalindicators";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import { randomInt } from 'crypto';          // for random delays
import { AbortController } from 'node-abort-controller';  // for request timeout

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

// ===== SYMBOLS: Top Nifty 50 + active ones (Jan 2026) =====
const SYMBOLS = [
  "RELIANCE.NS", "HDFCBANK.NS", "TCS.NS", "ICICIBANK.NS", "BHARTIARTL.NS",
  "INFY.NS", "SBIN.NS", "ITC.NS", "HINDUNILVR.NS", "LT.NS",
  "BAJFINANCE.NS", "AXISBANK.NS", "KOTAKBANK.NS", "SUNPHARMA.NS", "MARUTI.NS",
  "TITAN.NS", "NTPC.NS", "ONGC.NS", "POWERGRID.NS", "BEL.NS",
  "COALINDIA.NS", "HINDALCO.NS", "ADANIPORTS.NS", "ADANIENT.NS", "ULTRACEMCO.NS"
];

// ================= HELPERS =================
const sleep = ms => new Promise(r => setTimeout(r, ms));

function istTime() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

// yahoo-finance2 FIX: delays + UA + retry + TIMEOUT (15s per request)
async function fetchWithRetry(symbol, opts, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 seconds timeout

    try {
      // Random delay before request
      await sleep(randomInt(4000, 10000));

      const customOpts = {
        ...opts,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
        },
        signal: controller.signal  // ← timeout control
      };

      const result = await yahooFinance.chart(symbol, customOpts);
      clearTimeout(timeoutId);
      return result;

    } catch (e) {
      clearTimeout(timeoutId);

      if (e.name === 'AbortError') {
        console.log(`⏱ Timeout (15s) for ${symbol} - retrying`);
      }

      const errStr = String(e);
      if (errStr.includes('Too Many Requests') || errStr.includes('rate limit')) {
        console.log(`🚫 Rate limited on ${symbol} - extra long wait`);
        await sleep(15000 + randomInt(10000, 20000)); // 15-35 sec
      }

      if (i === retries) throw e;

      console.log(`⏳ Retry ${i + 1}/${retries} for ${symbol}`);
      await sleep(8000 + randomInt(3000, 7000));
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

  const jwt = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, jwt);

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

      const msg = `BUY ${s}\nEntry ${entry.toFixed(2)}\nSL ${sl.toFixed(2)}\nTarget ${tgt.toFixed(2)}\nConfidence: ${conf}%`;
      await sendTelegram(msg);

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
      console.log(`✅ ${s} - Alert sent!`);

      // Long sleep after each symbol/alert
      await sleep(12000 + randomInt(3000, 8000)); // 12-20 sec

    } catch (e) {
      console.error(`❌ ${s}`, e.message);
      await sleep(10000); // wait even on error
    }
  }

  console.log(`🏁 Done. Alerts: ${alerts}`);
}

run().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
