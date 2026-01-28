/**
 * trade-alerts-nse
 * REVISED VERSION – Fixed for GitHub Actions
 * Strategy: Fresh EMA Crossover + Cooldown
 */

import YahooFinance from "yahoo-finance2";
import { EMA, RSI } from "technicalindicators";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";

const yahooFinance = new YahooFinance();

const SL_PCT = 0.7;
const TARGET_PCT = 1.4;
const MIN_CONFIDENCE = 60;
const COOLDOWN_MINUTES = 30;

const alertedStocks = new Map();

const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "SPREADSHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON"
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing env variable: ${key}`);
    process.exit(1); // immediate stop if env missing
  }
}

console.log("✅ All environment variables loaded");

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

const INTERVAL = "5m";
const LOOKBACK_DAYS = 5;

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
    console.error("Telegram send failed:", err.message);
  }
}

async function logToSheet(row) {
  try {
    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);
    await doc.useServiceAccountAuth(JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle["Alerts"];
    if (!sheet) {
      console.error("Sheet 'Alerts' not found!");
      return;
    }
    await sheet.addRow(row);
  } catch (err) {
    console.error("Google Sheet log failed:", err.message);
  }
}

function calculateConfidence({ ema9, ema21, rsi }) {
  let score = 0;
  if (ema9 > ema21) score += 40;
  if (rsi > 55 && rsi < 70) score += 30;
  if (ema9 > ema21 && rsi > 50) score += 30;
  return Math.min(score, 100);
}

async function runScanner() {
  console.log("🚀 Scanner started at", new Date().toISOString());

  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - LOOKBACK_DAYS * 24 * 60 * 60;
  const now = Date.now();

  let alertCount = 0;

  for (const symbol of SYMBOLS) {
    try {
      const lastAlert = alertedStocks.get(symbol);
      if (lastAlert && now - lastAlert < COOLDOWN_MINUTES * 60 * 1000) {
        continue;
      }

      const result = await yahooFinance.chart(symbol, {
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
      const prevEma9 = EMA.calculate({ period: 9, values: closes.slice(0, -1) }).at(-1);
      const prevEma21 = EMA.calculate({ period: 21, values: closes.slice(0, -1) }).at(-1);
      const rsi = RSI.calculate({ period: 14, values: closes }).at(-1);

      if (!ema9 || !ema21 || !prevEma9 || !prevEma21 || !rsi) continue;

      const freshCrossover = prevEma9 <= prevEma21 && ema9 > ema21;
      if (!freshCrossover || rsi <= 50) continue;

      const confidence = calculateConfidence({ ema9, ema21, rsi });
      if (confidence < MIN_CONFIDENCE) continue;

      const entry = closes.at(-1);
      const sl = entry * (1 - SL_PCT / 100);
      const target = entry * (1 + TARGET_PCT / 100);

      const message = `
📈 *BUY SIGNAL*
Stock: *${symbol}*
Entry: ₹${entry.toFixed(2)}
SL: ₹${sl.toFixed(2)}
Target: ₹${target.toFixed(2)}
Confidence: *${confidence}/100*
`;

      await sendTelegram(message);
      await logToSheet({
        Symbol: symbol,
        Entry: entry,
        SL: sl,
        Target: target,
        Confidence: confidence,
        Time: new Date().toISOString()
      });

      alertedStocks.set(symbol, now);
      alertCount++;
      console.log(`✅ Alert sent: ${symbol} (Confidence: ${confidence})`);

    } catch (err) {
      console.error(`❌ ${symbol}: ${err.message}`);
    }
  }

  console.log(`🏁 Scanner completed. Alerts sent: ${alertCount}`);
}

// ✅ NO TOP-LEVEL AWAIT — Safe for GitHub Actions
runScanner().catch(err => {
  console.error("Scanner crashed:", err);
  process.exit(1);
});
