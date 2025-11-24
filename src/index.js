/**
 * FINAL index.js
 * LIVE Trade Alerts with:
 *  - Yahoo Finance (Stable)
 *  - ATR-based TP/SL
 *  - Risk-based lot sizing
 *  - WinRate60d estimation
 *  - EMA20/50/200 + ADX
 *  - NSE Top 100 symbols scanning
 *  - Telegram + Google Sheets
 */

import fetch from "node-fetch";
import yahooFinance from "yahoo-finance2";
import technical from "technicalindicators";
import { google } from "googleapis";

// --------------------- CONFIG ----------------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const GOOGLE_SERVICE_ACCOUNT_JSON = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = "Alerts";

const ACCOUNT_CAPITAL = Number(process.env.ACCOUNT_CAPITAL || 100000); // ₹1 lakh default
const RISK_PCT = Number(process.env.RISK_PCT || 0.01);                // 1% risk per trade
const SL_ATR_MULTIPLIER = 1.5;
const TP_ATR_MULTIPLIER = 3.0;
const WINRATE_LOOKBACK_DAYS = 60;

// --------------------- NSE TOP 100 ----------------------
const symbols = [
  "RELIANCE","HDFCBANK","ICICIBANK","INFY","TCS","AXISBANK","SBIN","KOTAKBANK","LT",
  "BHARTIARTL","ITC","HINDUNILVR","HCLTECH","WIPRO","ASIANPAINT","SUNPHARMA","ULTRACEMCO",
  "NESTLEIND","BAJFINANCE","BAJAJFINSV","POWERGRID","JSWSTEEL","TITAN","MARUTI","TATASTEEL",
  "ADANIENT","ADANIPORTS","TECHM","CIPLA","DRREDDY","DIVISLAB","ONGC","COALINDIA","BPCL","IOC",
  "GRASIM","HEROMOTOCO","BRITANNIA","SHREECEM","EICHERMOT","APOLLOHOSP","HDFCLIFE","SBILIFE",
  "ICICIPRULI","INDUSINDBK","BAJAJ-AUTO","M&M","TATAMOTORS","UPL","VEDL","NTPC","HINDALCO",
  "LTIM","LTTS","DABUR","PIDILITIND","PEL","JINDALSTEL","SRF","SIEMENS","TORNTPHARM",
  "AMBUJACEM","BANDHANBNK","GAIL","BOSCHLTD","COLPAL","GLAND","HAL","MAXHEALTH","MPHASIS",
  "PAGEIND","PIIND","RECLTD","SAIL","TATACOMM","TRENT","UBL","VOLTAS","ZEEL","ATUL",
  "DLF","INDIGO","IRCTC","LICI","MUTHOOTFIN","NAVINFLUOR","POLYCAB","RAMCOCEM","TVSMOTOR",
  "VBL","CONCOR","IDFCFIRSTB","BANKBARODA"
];

// ---------------------- MARKET DATA (YAHOO) ----------------------
async function fetchQuote(symbol) {
  try {
    const data = await yahooFinance.quote(`${symbol}.NS`);
    return { price: data.regularMarketPrice };
  } catch (err) {
    console.warn(`Quote failed for ${symbol}: ${err.message}`);
    return null;
  }
}

async function fetchDailyHistory(symbol, days = 250) {
  try {
    const result = await yahooFinance.historical(`${symbol}.NS`, {
      period1: `${days}d`,
      interval: "1d"
    });

    return result.map((d) => ({
      date: d.date,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: d.volume
    }));
  } catch (err) {
    console.warn(`History failed for ${symbol}: ${err.message}`);
    return null;
  }
}

// ---------------------- INDICATORS ----------------------
function computeIndicators(hist) {
  const closes = hist.map((d) => d.close);
  const highs = hist.map((d) => d.high);
  const lows = hist.map((d) => d.low);
  const vols = hist.map((d) => d.volume);

  const ema20 = technical.EMA.calculate({ period: 20, values: closes }).at(-1);
  const ema50 = technical.EMA.calculate({ period: 50, values: closes }).at(-1);
  const ema200 = technical.EMA.calculate({ period: 200, values: closes }).at(-1);

  const adx = technical.ADX.calculate({ close: closes, high: highs, low: lows, period: 14 }).at(-1)?.adx;
  const atr = technical.ATR.calculate({ close: closes, high: highs, low: lows, period: 14 }).at(-1);
  const vol20 = technical.SMA.calculate({ period: 20, values: vols }).at(-1);

  return { ema20, ema50, ema200, adx, atr, volume: vols.at(-1), vol20 };
}

// ------------ WINRATE 60-DAYS ESTIMATION ------------
function estimateWinRate(hist) {
  if (hist.length < 80) return null;

  let wins = 0, signals = 0;

  for (let i = 60; i < hist.length - 5; i++) {
    const slice = hist.slice(0, i);
    const ind = computeIndicators(slice);
    const price = slice.at(-1).close;
    const sig = generateDirection(price, ind);

    if (!sig) continue;
    signals++;

    const atr = ind.atr || 1;
    const sl = sig === "BUY" ? price - atr : price + atr;
    const tp = sig === "BUY" ? price + atr * 2 : price - atr * 2;
    const next = hist.slice(i + 1, i + 6);

    for (const day of next) {
      if (sig === "BUY") {
        if (day.low <= sl) break;
        if (day.high >= tp) { wins++; break; }
      } else {
        if (day.high >= sl) break;
        if (day.low <= tp) { wins++; break; }
      }
    }
  }

  if (signals === 0) return null;
  return (wins / signals) * 100;
}

// ---------------------- DIRECTION SIGNAL ----------------------
function generateDirection(price, ind) {
  if (!ind.ema20 || !ind.ema50 || !ind.ema200 || !ind.adx) return null;

  const up =
    price > ind.ema20 &&
    ind.ema20 > ind.ema50 &&
    ind.ema50 > ind.ema200 &&
    ind.adx > 25;

  const down =
    price < ind.ema20 &&
    ind.ema20 < ind.ema50 &&
    ind.ema50 < ind.ema200 &&
    ind.adx > 25;

  return up ? "BUY" : down ? "SELL" : null;
}

// ---------------------- RISK & POSITION SIZING ----------------------
function buildTradePlan(symbol, price, ind) {
  const direction = generateDirection(price, ind);
  if (!direction) return null;

  const atr = ind.atr || 1;
  const sl = direction === "BUY" ? price - SL_ATR_MULTIPLIER * atr : price + SL_ATR_MULTIPLIER * atr;
  const tp = direction === "BUY" ? price + TP_ATR_MULTIPLIER * atr : price - TP_ATR_MULTIPLIER * atr;

  const riskPerShare = Math.abs(price - sl);
  const qty = Math.max(1, Math.floor((ACCOUNT_CAPITAL * RISK_PCT) / riskPerShare));

  return { symbol, direction, price, sl, tp, qty, ...ind };
}

// ---------------------- TELEGRAM ----------------------
async function sendTelegram(text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML"
      })
    });
  } catch (e) {
    console.error("Telegram error:", e);
  }
}

// ---------------------- SHEETS ----------------------
async function appendSheet(row) {
  const auth = new google.auth.JWT(
    GOOGLE_SERVICE_ACCOUNT_JSON.client_email,
    null,
    GOOGLE_SERVICE_ACCOUNT_JSON.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );

  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:Z`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [row] }
  });
}

// ---------------------- MAIN LOOP ----------------------
async function run() {
  console.log("🚀 Starting Trade Alerts...");

  for (const symbol of symbols) {
    try {
      console.log(`📡 Fetching: ${symbol}`);

      const quote = await fetchQuote(symbol);
      if (!quote?.price) continue;

      const price = quote.price;
      const hist = await fetchDailyHistory(symbol, 250);
      if (!hist) continue;

      const ind = computeIndicators(hist);
      const plan = buildTradePlan(symbol, price, ind);
      if (!plan) continue;

      const winRate = estimateWinRate(hist);
      const wrTxt = winRate ? `${winRate.toFixed(1)}%` : "N/A";

      const msg = `
📢 <b>TRADE SIGNAL</b>
<b>${symbol}</b> — ${plan.direction}
Price: ₹${plan.price}
SL: ₹${plan.sl.toFixed(2)}
TP: ₹${plan.tp.toFixed(2)}
Qty: ${plan.qty}

<b>Indicators</b>
EMA20: ${plan.ema20.toFixed(2)}
EMA50: ${plan.ema50.toFixed(2)}
EMA200: ${plan.ema200.toFixed(2)}
ADX: ${plan.adx.toFixed(2)}
ATR: ${plan.atr.toFixed(2)}

<b>WinRate(60d):</b> ${wrTxt}
      `;

      await sendTelegram(msg);

      const row = [
        new Date().toLocaleString("en-IN"),
        plan.symbol,
        plan.direction,
        plan.price,
        plan.sl,
        plan.tp,
        plan.qty,
        plan.ema20,
        plan.ema50,
        plan.ema200,
        plan.adx,
        plan.atr,
        plan.volume,
        plan.vol20,
        winRate ? winRate.toFixed(2) : ""
      ];

      await appendSheet(row);

      console.log(`✅ Signal sent: ${symbol}`);
    } catch (err) {
      console.error(`Error in ${symbol}:`, err.message);
    }
  }

  console.log("🏁 Completed scan.");
}

run();
