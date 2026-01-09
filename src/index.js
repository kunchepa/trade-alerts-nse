/**
 * trade-alerts-nse
 * FINAL WORKING VERSION (yahoo-finance2 v3 compatible)
 */

import YahooFinance from "yahoo-finance2";
import { EMA, RSI } from "technicalindicators";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";

/* =========================
   YAHOO CLIENT (v3)
========================= */

const yahooFinance = new YahooFinance();

/* =========================
   MODE & RISK CONFIG
========================= */

const MODE = "LIVE"; // "LIVE" or "BACKTEST"
const SL_PCT = 0.7;
const TARGET_PCT = 1.4;
const MIN_CONFIDENCE = 60;

/* =========================
   ENV VALIDATION
========================= */

const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "SPREADSHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON"
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`❌ Missing env variable: ${key}`);
  }
}

console.log("✅ All environment variables loaded");

/* =========================
   SYMBOLS
========================= */

const SYMBOLS = [
  "RELIANCE.NS","TCS.NS","HDFCBANK.NS","INFY.NS","ICICIBANK.NS","LT.NS",
  "SBIN.NS","AXISBANK.NS","BAJFINANCE.NS","ITC.NS","MARUTI.NS",
  "SUNPHARMA.NS","ASIANPAINT.NS","TITAN.NS","ONGC.NS","NTPC.NS",
  "HCLTECH.NS","ADANIPORTS.NS","JSWSTEEL.NS","TATASTEEL.NS","WIPRO.NS"
];

const INTERVAL = "5m";
const LOOKBACK_DAYS = 5;

/* =========================
   HELPERS
========================= */

async function sendTelegram(message) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown"
    })
  });
}

async function logToSheet(row) {
  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);
  await doc.useServiceAccountAuth(JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
  await doc.loadInfo();
  await doc.sheetsByTitle["Alerts"].addRow(row);
}

/* =========================
   INDICATORS
========================= */

function calculateIndicators(closes) {
  return {
    ema9: EMA.calculate({ period: 9, values: closes }).at(-1),
    ema21: EMA.calculate({ period: 21, values: closes }).at(-1),
    rsi: RSI.calculate({ period: 14, values: closes }).at(-1)
  };
}

/* =========================
   CONFIDENCE SCORE
========================= */

function calculateConfidence({ ema9, ema21, rsi }) {
  let score = 0;

  if (ema9 > ema21) score += 40;
  if (rsi > 55 && rsi < 70) score += 30;
  if (ema9 > ema21 && rsi > 50) score += 30;

  return Math.min(score, 100);
}

/* =========================
   MAIN SCANNER
========================= */

async function runScanner() {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - LOOKBACK_DAYS * 24 * 60 * 60;

  for (const symbol of SYMBOLS) {
    try {
      const result = await yahooFinance.chart(symbol, {
        interval: INTERVAL,
        period1,
        period2
      });

      const candles = result?.quotes;
      if (!candles || candles.length < 30) continue;

      const closes = candles.map(c => c.close).filter(Boolean);
      if (closes.length < 30) continue;

      const lastClose = closes.at(-1);
      const indicators = calculateIndicators(closes);

      if (!indicators.ema9 || !indicators.ema21 || !indicators.rsi) continue;

      const confidence = calculateConfidence(indicators);
      if (confidence < MIN_CONFIDENCE) continue;

      const buySignal = indicators.ema9 > indicators.ema21 && indicators.rsi > 50;
      if (!buySignal) continue;

      const sl = lastClose * (1 - SL_PCT / 100);
      const target = lastClose * (1 + TARGET_PCT / 100);

      const message = `
📈 *BUY SIGNAL*
Stock: *${symbol}*
Entry: ₹${lastClose.toFixed(2)}

SL: ₹${sl.toFixed(2)}
Target: ₹${target.toFixed(2)}

Confidence: *${confidence}/100*
`;

      await sendTelegram(message);
      await logToSheet({
        Symbol: symbol,
        Entry: lastClose,
        SL: sl,
        Target: target,
        Confidence: confidence,
        Time: new Date().toISOString()
      });

      console.log(`✅ Alert sent for ${symbol}`);

    } catch (err) {
      console.error(`❌ ${symbol}:`, err.message);
    }
  }
}

/* =========================
   START
========================= */

await runScanner();
