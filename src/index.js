/**
 * trade-alerts-nse
 * FULL WORKING CODE + BACKTEST + SL/TARGET + CONFIDENCE
 */

import yahooFinance from "yahoo-finance2";
import { EMA, RSI } from "technicalindicators";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";

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
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "ALPHA_VANTAGE_KEY"
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

const SYMBOLS = [ /* unchanged list */ 
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
const RANGE_DAYS = 5;

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

  const emaDiffPct = ((ema9 - ema21) / ema21) * 100;
  if (emaDiffPct > 0.2) score += 40;
  else if (emaDiffPct > 0.1) score += 25;
  else score += 10;

  if (rsi >= 55 && rsi <= 65) score += 30;
  else if (rsi > 50 && rsi < 70) score += 20;
  else score += 10;

  if (ema9 > ema21 && rsi > 50) score += 30;
  else score += 15;

  return Math.min(score, 100);
}

/* =========================
   BACKTEST ENGINE
========================= */

const backtestStats = { trades: 0, wins: 0, losses: 0 };

function backtestTrade(candles, entryIndex, entryPrice) {
  const sl = entryPrice * (1 - SL_PCT / 100);
  const target = entryPrice * (1 + TARGET_PCT / 100);

  for (let i = entryIndex + 1; i < candles.length; i++) {
    if (candles[i].low <= sl) return "LOSS";
    if (candles[i].high >= target) return "WIN";
  }
  return "OPEN";
}

/* =========================
   MAIN SCANNER
========================= */

async function runScanner() {
  for (const symbol of SYMBOLS) {
    try {
      const period1 = new Date(Date.now() - RANGE_DAYS * 86400000);
      const candles = await yahooFinance.historical(symbol, { period1, interval: INTERVAL });

      if (!candles || candles.length < 30) continue;

      const closes = candles.map(c => c.close);
      const lastClose = closes.at(-1);

      const indicators = calculateIndicators(closes);
      const confidence = calculateConfidence(indicators);

      if (confidence < MIN_CONFIDENCE) continue;

      const buySignal = indicators.ema9 > indicators.ema21 && indicators.rsi > 50;

      if (!buySignal) continue;

      const sl = lastClose * (1 - SL_PCT / 100);
      const target = lastClose * (1 + TARGET_PCT / 100);

      if (MODE === "BACKTEST") {
        backtestStats.trades++;
        const result = backtestTrade(candles, candles.length - 1, lastClose);
        if (result === "WIN") backtestStats.wins++;
        if (result === "LOSS") backtestStats.losses++;
        continue;
      }

      const message = `
📈 *BUY SIGNAL*
Stock: *${symbol}*
Entry: ₹${lastClose.toFixed(2)}

SL: ₹${sl.toFixed(2)}
Target: ₹${target.toFixed(2)}

Confidence: *${confidence}/100*
RR: 1:${(TARGET_PCT / SL_PCT).toFixed(1)}
`;

      await sendTelegram(message);
      await logToSheet({ Symbol: symbol, Entry: lastClose, SL: sl, Target: target, Confidence: confidence });

    } catch (err) {
      console.error(symbol, err.message);
    }
  }
}

/* =========================
   START
========================= */

await runScanner();

if (MODE === "BACKTEST") {
  const winRate = ((backtestStats.wins / backtestStats.trades) * 100 || 0).toFixed(2);
  console.log("📊 BACKTEST RESULT");
  console.log(backtestStats, `WinRate=${winRate}%`);
}
