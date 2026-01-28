/**
 * NSE 5-Min EMA Crossover Scanner
 * Stable Production Version for GitHub Actions
 */

import YahooFinance from "yahoo-finance2";
import { EMA, RSI } from "technicalindicators";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";

const yahooFinance = new YahooFinance();

// ================= CONFIG =================

const SL_PCT = 0.7;
const TARGET_PCT = 1.4;
const MIN_CONFIDENCE = 60;
const COOLDOWN_MINUTES = 30;

const INTERVAL = "5m";
const LOOKBACK_DAYS = 5;

// ========================================

const alertedStocks = new Map();

// -------- ENV CHECK --------

const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "SPREADSHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON"
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing env variable: ${key}`);
    process.exit(1);
  }
}

console.log("✅ Environment variables loaded");

// -------- SYMBOLS --------

const SYMBOLS = [
  "RELIANCE.NS", "HDFCBANK.NS", "BHARTIARTL.NS", "TCS.NS", "ICICIBANK.NS", "SBIN.NS", "INFY.NS",
  "BAJFINANCE.NS", "HINDUNILVR.NS", "LT.NS", "LICI.NS", "MARUTI.NS", "HCLTECH.NS", "M&M.NS",
  "AXISBANK.NS", "KOTAKBANK.NS", "ITC.NS", "SUNPHARMA.NS", "ULTRACEMCO.NS", "TITAN.NS",
  "NTPC.NS", "ADANIPORTS.NS", "ONGC.NS", "HINDZINC.NS", "BAJAJFINSV.NS", "BEL.NS", "JSWSTEEL.NS",
  "HAL.NS", "VEDL.NS", "BAJAJ-AUTO.NS", "COALINDIA.NS", "ADANIPOWER.NS", "ADANIENT.NS",
  "ASIANPAINT.NS", "NESTLEIND.NS", "WIPRO.NS", "ZOMATO.NS", "TATASTEEL.NS", "DMART.NS",
  "POWERGRID.NS", "IOC.NS", "HINDALCO.NS", "SBILIFE.NS", "EICHERMOT.NS", "GRASIM.NS",
  "SHRIRAMFIN.NS", "INDIGO.NS", "LTIM.NS", "TECHM.NS", "TVSMOTOR.NS",
  "JIOFIN.NS", "DIVISLAB.NS", "VBL.NS", "BANKBARODA.NS", "HDFCLIFE.NS", "BPCL.NS", "DLF.NS",
  "IRFC.NS", "PIDILITIND.NS", "BRITANNIA.NS", "PNB.NS", "CANBK.NS", "CHOLAFIN.NS",
  "TORNTPHARM.NS", "TRENT.NS", "ADANIGREEN.NS", "AMBUJACEM.NS", "TATAMOTORS.NS",
  "GODREJCP.NS", "PFC.NS", "APOLLOHOSP.NS", "CIPLA.NS", "GAIL.NS", "BOSCHLTD.NS",
  "DRREDDY.NS", "SIEMENS.NS", "SHREECEM.NS", "MAXHEALTH.NS", "ZYDUSLIFE.NS", "HAVELLS.NS",
  "JSWENERGY.NS", "POLYCAB.NS", "NAUKRI.NS", "PAYTM.NS", "MUTHOOTFIN.NS", "PEL.NS",
  "ACC.NS", "ASHOKLEY.NS", "MFSL.NS", "DABUR.NS", "EMAMILTD.NS", "IGL.NS", "LUPIN.NS",
  "BIOCON.NS", "FORTIS.NS", "ABB.NS", "TATACONSUM.NS", "UPL.NS", "UNIONBANK.NS", "IDFCFIRSTB.NS",
  "BANDHANBNK.NS", "TATAPOWER.NS", "HEROMOTOCO.NS"
];

// ========================================

async function fetchWithRetry(symbol, options, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await yahooFinance.chart(symbol, options);
    } catch (err) {
      if (i === retries) throw err;
      console.log(`⏳ Retry ${i + 1} for ${symbol}`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

async function sendTelegram(message) {
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown"
      })
    });
  } catch (err) {
    console.error("Telegram failed:", err.message);
  }
}

async function logToSheet(row) {
  try {
    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);
    await doc.useServiceAccountAuth(JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
    await doc.loadInfo();

    const sheet = doc.sheetsByTitle["Alerts"];
    if (!sheet) return console.error("Sheet 'Alerts' not found");

    await sheet.addRow(row);
  } catch (err) {
    console.error("Sheets failed:", err.message);
  }
}

function calculateConfidence({ ema9, ema21, rsi }) {
  let score = 0;
  if (ema9 > ema21) score += 40;
  if (rsi > 55 && rsi < 70) score += 30;
  if (ema9 > ema21 && rsi > 50) score += 30;
  return Math.min(score, 100);
}

// ========================================

async function runScanner() {
  console.log("🚀 Scanner started:", new Date().toISOString());

  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - LOOKBACK_DAYS * 24 * 60 * 60;
  const now = Date.now();

  let alerts = 0;

  for (const symbol of SYMBOLS) {
    try {
      const last = alertedStocks.get(symbol);
      if (last && now - last < COOLDOWN_MINUTES * 60 * 1000) continue;

      const result = await fetchWithRetry(symbol, {
        interval: INTERVAL,
        period1,
        period2
      });

      const candles = result?.quotes;
      if (!candles || candles.length < 40) continue;

      const closes = candles.map(c => c.close).filter(Boolean);
      if (closes.length < 40) continue;

      const ema9 = EMA.calculate({ period: 9, values: closes }).at(-1);
      const ema21 = EMA.calculate({ period: 21, values: closes }).at(-1);
      const prev9 = EMA.calculate({ period: 9, values: closes.slice(0, -1) }).at(-1);
      const prev21 = EMA.calculate({ period: 21, values: closes.slice(0, -1) }).at(-1);
      const rsi = RSI.calculate({ period: 14, values: closes }).at(-1);

      if (!ema9 || !ema21 || !prev9 || !prev21 || !rsi) continue;

      const fresh = prev9 <= prev21 && ema9 > ema21;
      if (!fresh || rsi <= 50) continue;

      const confidence = calculateConfidence({ ema9, ema21, rsi });
      if (confidence < MIN_CONFIDENCE) continue;

      const entry = closes.at(-1);
      const sl = entry * (1 - SL_PCT / 100);
      const target = entry * (1 + TARGET_PCT / 100);

      const msg = `
📈 *BUY SIGNAL*
${symbol}
Entry: ₹${entry.toFixed(2)}
SL: ₹${sl.toFixed(2)}
Target: ₹${target.toFixed(2)}
Confidence: ${confidence}/100
`;

      await sendTelegram(msg);
      await logToSheet({
        Symbol: symbol,
        Entry: entry,
        SL: sl,
        Target: target,
        Confidence: confidence,
        Time: new Date().toISOString()
      });

      alertedStocks.set(symbol, now);
      alerts++;

      console.log(`✅ ${symbol} alerted`);

    } catch (err) {
      console.error(`❌ ${symbol}:`, err.message);
    }
  }

  console.log(`🏁 Completed. Alerts: ${alerts}`);
}

runScanner().catch(err => {
  console.error("Scanner crashed:", err);
  process.exit(1);
});
