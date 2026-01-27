/**
 * trade-alerts-nse
 * Strategy: Fresh EMA Crossover + Cooldown + Filters
 * Fixed: Added ATR, candle, EMA50, time filters + safety
 */

import YahooFinance from "yahoo-finance2";
import { EMA, RSI, ATR } from "technicalindicators";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

/* =========================
   YAHOO CLIENT
========================= */
const yahooFinance = new YahooFinance();

/* =========================
   CONFIG
========================= */
const SL_PCT = 0.7;
const TARGET_PCT = 1.4;
const MIN_CONFIDENCE = 60;
const COOLDOWN_MINUTES = 30;
const INTERVAL = "5m";
const LOOKBACK_DAYS = 5;
const ATR_PCT_MAX = 8;          // Volatility filter
const CANDLE_STRENGTH_MIN = 0.05; // % change min for bullish candle
const RSI_UPPER = 72;           // Avoid overbought

/* =========================
   ALERT MEMORY
========================= */
const alertedStocks = new Map();

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
   SYMBOLS (cleaned, removed PEL.NS)
========================= */
const SYMBOLS = [
  "RELIANCE.NS","TCS.NS","HDFCBANK.NS","INFY.NS","ICICIBANK.NS","KOTAKBANK.NS","LT.NS",
  "SBIN.NS","AXISBANK.NS","BAJFINANCE.NS","BHARTIARTL.NS","ITC.NS","HINDUNILVR.NS","MARUTI.NS",
  "SUNPHARMA.NS","BAJAJFINSV.NS","ASIANPAINT.NS","NESTLEIND.NS","TITAN.NS","ONGC.NS","POWERGRID.NS",
  "ULTRACEMCO.NS","NTPC.NS","DRREDDY.NS","HCLTECH.NS","INDUSINDBK.NS","DIVISLAB.NS","ADANIPORTS.NS",
  "JSWSTEEL.NS","COALINDIA.NS","ADANIENT.NS","M&M.NS","TATASTEEL.NS","GRASIM.NS","WIPRO.NS",
  "HDFCLIFE.NS","TECHM.NS","SBILIFE.NS","BRITANNIA.NS","CIPLA.NS","EICHERMOT.NS","HINDALCO.NS",
  "HEROMOTOCO.NS","BPCL.NS","SHREECEM.NS","IOC.NS","TATACONSUM.NS","UPL.NS","VEDL.NS",
  "DLF.NS","PIDILITIND.NS","ICICIPRULI.NS","JSWENERGY.NS","BANKBARODA.NS","CANBK.NS",
  "PNB.NS","UNIONBANK.NS","BANDHANBNK.NS","IDFCFIRSTB.NS","GAIL.NS","TATAPOWER.NS","TORNTPHARM.NS",
  "ABB.NS","SIEMENS.NS","MUTHOOTFIN.NS","BAJAJ-AUTO.NS","AMBUJACEM.NS","ACC.NS","BEL.NS","TMCV.NS",
  "HAL.NS","IRCTC.NS","POLYCAB.NS","ETERNAL.NS","NAUKRI.NS","ASHOKLEY.NS",
  "TVSMOTOR.NS","CHOLAFIN.NS","MGL.NS","IGL.NS","APOLLOHOSP.NS"
];

/* =========================
   TELEGRAM
========================= */
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
    console.log("Telegram sent");
  } catch (err) {
    console.error("Telegram failed:", err.message);
  }
}

/* =========================
   GOOGLE SHEETS
========================= */
async function logToSheet(rowArray) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle["Alerts"] || (await doc.addSheet({ title: "Alerts" }));
    await sheet.addRow(rowArray);
    console.log("✅ Logged to Google Sheets");
  } catch (err) {
    console.error("❌ Google Sheets error:", err.message);
  }
}

/* =========================
   CONFIDENCE
========================= */
function calculateConfidence({ ema9, ema21, rsi }) {
  let score = 0;
  if (ema9 > ema21) score += 40;
  if (rsi > 55 && rsi < RSI_UPPER) score += 30;
  if (ema9 > ema21 && rsi > 50) score += 30;
  return Math.min(score, 100);
}

/* =========================
   MAIN SCANNER
========================= */
async function runScanner() {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - LOOKBACK_DAYS * 24 * 60 * 60;
  const now = Date.now();

  // IST time
  const istNow = new Date(now + 5.5 * 60 * 60 * 1000);
  const hr = istNow.getHours();
  const min = istNow.getMinutes();
  console.log(`Scanner started IST: ${istNow.toLocaleString('en-IN')}`);

  for (const symbol of SYMBOLS) {
    try {
      const lastAlert = alertedStocks.get(symbol);
      if (lastAlert && now - lastAlert < COOLDOWN_MINUTES * 60 * 1000) {
        console.log(`${symbol} skipped: cooldown`);
        continue;
      }

      const result = await yahooFinance.chart(symbol, {
        interval: INTERVAL,
        period1,
        period2
      });

      const candles = result?.quotes;
      if (!candles || candles.length < 60) {
        console.log(`${symbol} skipped: insufficient candles`);
        continue;
      }

      const closes = candles.map(c => c.close).filter(Boolean);
      const highs = candles.map(c => c.high).filter(Boolean);
      const lows = candles.map(c => c.low).filter(Boolean);
      if (closes.length < 60) continue;

      const ema9 = EMA.calculate({ period: 9, values: closes }).at(-1);
      const ema21 = EMA.calculate({ period: 21, values: closes }).at(-1);
      const ema50 = EMA.calculate({ period: 50, values: closes }).at(-1);
      const prevEma9 = EMA.calculate({ period: 9, values: closes.slice(0, -1) }).at(-1);
      const prevEma21 = EMA.calculate({ period: 21, values: closes.slice(0, -1) }).at(-1);
      const rsi = RSI.calculate({ period: 14, values: closes }).at(-1);
      const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes }).at(-1);

      if (!ema9 || !ema21 || !ema50 || !prevEma9 || !prevEma21 || !rsi || !atr) {
        console.log(`${symbol} skipped: indicator calc failed`);
        continue;
      }

      const freshCrossover = prevEma9 <= prevEma21 && ema9 > ema21;
      if (!freshCrossover) {
        console.log(`${symbol} skipped: no fresh crossover`);
        continue;
      }

      const entry = closes.at(-1);
      const candle = candles.at(-1);
      const candleStrength = ((candle.close - candle.open) / candle.open) * 100;
      const atrPct = (atr / entry) * 100;

      // Filters
      if (rsi <= 50 || rsi > RSI_UPPER) {
        console.log(`${symbol} skipped: RSI out of range (${rsi.toFixed(2)})`);
        continue;
      }
      if (entry < ema50) {
        console.log(`${symbol} skipped: below EMA50`);
        continue;
      }
      if (candleStrength < CANDLE_STRENGTH_MIN) {
        console.log(`${symbol} skipped: weak candle ${candleStrength.toFixed(2)}%`);
        continue;
      }
      if (atrPct > ATR_PCT_MAX) {
        console.log(`${symbol} skipped: high ATR% ${atrPct.toFixed(2)}`);
        continue;
      }

      // Trading hours filter
      if (
        hr < 9 ||
        (hr === 9 && min < 15) ||
        hr > 15 ||
        (hr === 15 && min > 30)
      ) {
        console.log(`${symbol} skipped: out of trading hours`);
        continue;
      }

      const confidence = calculateConfidence({ ema9, ema21, rsi });
      if (confidence < MIN_CONFIDENCE) {
        console.log(`${symbol} skipped: low confidence ${confidence}`);
        continue;
      }

      const sl = entry * (1 - SL_PCT / 100);
      const target = entry * (1 + TARGET_PCT / 100);

      const message = `
📈 *BUY SIGNAL*
Stock: *${symbol}*
Entry: ₹${entry.toFixed(2)}

SL: ₹${sl.toFixed(2)}
Target: ₹${target.toFixed(2)}

Confidence: *${confidence}/100*
RSI: ${rsi.toFixed(2)} | ATR%: ${atrPct.toFixed(2)}
`;

      await sendTelegram(message);

      await logToSheet([
        istNow.toLocaleString("en-IN"),
        symbol,
        "BUY",
        entry.toFixed(2),
        target.toFixed(2),
        sl.toFixed(2),
        "PENDING",
        confidence,
        now.toISOString()
      ]);

      alertedStocks.set(symbol, now);
      console.log(`✅ Alert sent for ${symbol}`);

    } catch (err) {
      console.error(`❌ ${symbol}: ${err.message}`);
    }
  }
}

/* =========================
   START
========================= */
await runScanner();
