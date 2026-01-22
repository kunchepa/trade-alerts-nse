/**
 * trade-alerts-nse
 * Strategy: Fresh EMA Crossover + Cooldown
 * NOTE: CORE STRATEGY IS UNCHANGED
 */

import YahooFinance from "yahoo-finance2";
import { EMA, RSI } from "technicalindicators";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const yahooFinance = new YahooFinance();

/* =========================
   CONFIG (UNCHANGED)
========================= */

const SL_PCT = 0.7;
const TARGET_PCT = 1.4;
const MIN_CONFIDENCE = 60;
const COOLDOWN_MINUTES = 30;

const INTERVAL = "5m";
const LOOKBACK_DAYS = 5;

/* =========================
   STRICT NIFTY 100 SYMBOLS
========================= */

const SYMBOLS = [
"ADANIENT.NS","ADANIPORTS.NS","APOLLOHOSP.NS","ASIANPAINT.NS","AXISBANK.NS",
"BAJAJ-AUTO.NS","BAJFINANCE.NS","BAJAJFINSV.NS","BPCL.NS","BHARTIARTL.NS",
"BRITANNIA.NS","CIPLA.NS","COALINDIA.NS","DIVISLAB.NS","DRREDDY.NS",
"EICHERMOT.NS","GRASIM.NS","HCLTECH.NS","HDFCBANK.NS","HDFCLIFE.NS",
"HEROMOTOCO.NS","HINDALCO.NS","HINDUNILVR.NS","ICICIBANK.NS","ITC.NS",
"IOC.NS","INDUSINDBK.NS","INFY.NS","JSWSTEEL.NS","KOTAKBANK.NS",
"LT.NS","M&M.NS","MARUTI.NS","NESTLEIND.NS","NTPC.NS",
"ONGC.NS","POWERGRID.NS","RELIANCE.NS","SBIN.NS","SBILIFE.NS",
"SHREECEM.NS","SUNPHARMA.NS","TATACONSUM.NS","TATAMOTORS.NS","TATASTEEL.NS",
"TCS.NS","TECHM.NS","TITAN.NS","ULTRACEMCO.NS","UPL.NS",
"WIPRO.NS",

// Next 50
"ABB.NS","ACC.NS","AMBUJACEM.NS","ASHOKLEY.NS","BANDHANBNK.NS","BEL.NS",
"BHEL.NS","BIOCON.NS","CANBK.NS","CHOLAFIN.NS","DLF.NS","GAIL.NS",
"HAL.NS","HAVELLS.NS","ICICIPRULI.NS","IDFCFIRSTB.NS","IGL.NS",
"IRCTC.NS","JINDALSTEL.NS","JSWENERGY.NS","LICHSGFIN.NS","MGL.NS",
"MUTHOOTFIN.NS","NAUKRI.NS","PEL.NS","PIDILITIND.NS","PNB.NS",
"POLYCAB.NS","SAIL.NS","SIEMENS.NS","TORNTPHARM.NS","TVSMOTOR.NS",
"UNIONBANK.NS","VEDL.NS","ZOMATO.NS"
];

/* =========================
   ALERT MEMORY
========================= */

const alertedStocks = new Map();

/* =========================
   CONFIDENCE (UNCHANGED)
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
  const now = Date.now();

  for (const symbol of SYMBOLS) {
    try {
      const lastAlert = alertedStocks.get(symbol);
      if (lastAlert && now - lastAlert < COOLDOWN_MINUTES * 60 * 1000) continue;

      const result = await yahooFinance.chart(symbol, {
        interval: INTERVAL,
        period1,
        period2
      });

      const candles = result?.quotes;
      if (!candles || candles.length < 50) continue;

      const closes = candles.map(c => c.close).filter(Boolean);

      const ema9 = EMA.calculate({ period: 9, values: closes }).at(-1);
      const ema21 = EMA.calculate({ period: 21, values: closes }).at(-1);
      const ema50 = EMA.calculate({ period: 50, values: closes }).at(-1);

      const prevEma9 = EMA.calculate({ period: 9, values: closes.slice(0, -1) }).at(-1);
      const prevEma21 = EMA.calculate({ period: 21, values: closes.slice(0, -1) }).at(-1);

      const rsi = RSI.calculate({ period: 14, values: closes }).at(-1);

      if (!ema9 || !ema21 || !ema50 || !prevEma9 || !prevEma21 || !rsi) continue;

      /* ========= CORE LOGIC (UNCHANGED) ========= */

      const freshCrossover = prevEma9 <= prevEma21 && ema9 > ema21;
      if (!freshCrossover || rsi <= 50) continue;

      /* ========= SAFETY FILTERS ========= */

      const entry = closes.at(-1);
      const lastCandle = candles.at(-1);

      // 1️⃣ Candle strength ≥ 0.25%
      const candleStrength =
        ((lastCandle.close - lastCandle.open) / lastCandle.open) * 100;
      if (candleStrength < 0.25) continue;

      // 2️⃣ EMA50 trend filter
      if (entry < ema50) continue;

      // 3️⃣ RSI ceiling
      if (rsi > 68) continue;

      // 4️⃣ Time filter (IST)
      const nowUTC = new Date();
      const timeIST = new Date(nowUTC.getTime() + 5.5 * 60 * 60 * 1000);
      const hour = timeIST.getHours();
      if (hour < 9 || hour === 12 || hour === 13) continue;

      // 5️⃣ ATR volatility skip
      const recentHigh = Math.max(...closes.slice(-14));
      const recentLow = Math.min(...closes.slice(-14));
      const atrPct = ((recentHigh - recentLow) / entry) * 100;
      if (atrPct > 3) continue;

      /* ========= CONFIDENCE (UNCHANGED) ========= */

      const confidence = calculateConfidence({ ema9, ema21, rsi });
      if (confidence < MIN_CONFIDENCE) continue;

      /* ========= SL / TARGET (UNCHANGED) ========= */

      const sl = entry * (1 - SL_PCT / 100);
      const target = entry * (1 + TARGET_PCT / 100);

      await sendTelegram(`
📈 *BUY SIGNAL*
Stock: *${symbol}*
Entry: ₹${entry.toFixed(2)}
SL: ₹${sl.toFixed(2)}
Target: ₹${target.toFixed(2)}
Confidence: *${confidence}/100*
`);

      await logToSheet([
        timeIST.toLocaleString("en-IN"),
        symbol,
        "BUY",
        entry.toFixed(2),
        target.toFixed(2),
        sl.toFixed(2),
        "PENDING",
        confidence,
        nowUTC.toISOString()
      ]);

      alertedStocks.set(symbol, now);

    } catch (err) {
      console.error(`❌ ${symbol}:`, err.message);
    }
  }
}

await runScanner();
