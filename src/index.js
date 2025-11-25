/**
 * ORB 15-min Strategy + 5-min Indicator Logic
 * BUY/SELL Based on:
 * - ORB 15-min range (9:15–9:30)
 * - EMA20/EMA50 trend (5-min)
 * - ADX > 20 (5-min)
 * - Volume spike > 1.3 × avg20 (5-min)
 * - Entry candle must CLOSE above/below ORB
 */

import yahooFinance from "yahoo-finance2";
import axios from "axios";
import pLimit from "p-limit";
import pRetry from "p-retry";
import { google } from "googleapis";
import { ADX } from "technicalindicators";
import fs from "fs";
import path from "path";

// ===== ENV =====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = "Alerts";
const DRY_RUN = process.env.DRY_RUN === "true";

const ADX_THRESHOLD = 20;
const VOLUME_MULTIPLIER = 1.3;
const CONCURRENCY = 6;
const RETRIES = 2;

// ===== NSE 100 Stocks =====
const symbols = [
  "RELIANCE","TCS","HDFCBANK","INFY","HDFC","ICICIBANK","KOTAKBANK","LT","SBIN","AXISBANK",
  "BAJFINANCE","BHARTIARTL","ITC","HINDUNILVR","MARUTI","SUNPHARMA","BAJAJFINSV","ASIANPAINT",
  "NESTLEIND","TITAN","ONGC","POWERGRID","ULTRACEMCO","NTPC","DRREDDY","HCLTECH","INDUSINDBK",
  "DIVISLAB","ADANIPORTS","BRITANNIA","SBILIFE","ADANIENT","ADANIGREEN","BPCL","CIPLA","IOC",
  "SHREECEM","TATACONSUM","EICHERMOT","GRASIM","HINDALCO","JSWSTEEL","TECHM","M&M","HEROMOTOCO",
  "UPL","COALINDIA","TATASTEEL","HDFCLIFE","TVSMOTOR","BOSCHLTD","WIPRO","PAGEIND","GODREJPROP",
  "INDIGO","COLPAL","LTIMINDTREE","AUROPHARMA","SIEMENS","PIDILITIND","ICICIPRULI","NMDC",
  "DABUR","SRF","BERGEPAINT","DLF","MUTHOOTFIN","AMBUJACEM","TATAMOTORS","VOLTAS","ACC",
  "PEL","ALKEM","GAIL","CANBK","SRTRANSFIN","JUBLFOOD","MCX","AARTIIND","APOLLOHOSP",
  "CENTURYTEX","BIOCON","ZEEL"
];

// ===== Logging =====
const logsDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  fs.appendFileSync(path.join(logsDir, `${new Date().toISOString().slice(0, 10)}.log`), line);
  console.log(msg);
}

// ===== Helpers =====
function toIST(ts) {
  return new Date(ts + (5.5 * 3600 * 1000));
}

function isMarketOpen() {
  const now = toIST(Date.now());
  const hm = now.getHours() + now.getMinutes() / 60;
  return hm >= 9.25 && hm <= 15.50;
}

function extractBars(chart) {
  const r = chart?.result?.[0];
  if (!r) return [];

  const q = r.indicators?.quote?.[0];
  const ts = r.timestamp;

  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (!q.close[i]) continue;
    out.push({
      ts: ts[i] * 1000,
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
      volume: q.volume[i]
    });
  }
  return out;
}

async function getORB15(symbol) {
  const chart = await pRetry(() => yahooFinance.chart(symbol + ".NS", {
    period1: "1d",
    interval: "15m"
  }), { retries: RETRIES });

  const bars = extractBars(chart);

  const orbBars = bars.filter(b => {
    const t = toIST(b.ts);
    const hm = t.getHours() + t.getMinutes() / 60;
    return hm >= 9.25 && hm < 9.50;  // 9:15–9:30
  });

  if (!orbBars.length) return null;

  return {
    high: Math.max(...orbBars.map(b => b.high)),
    low: Math.min(...orbBars.map(b => b.low))
  };
}

// ===== Google Sheets =====
async function appendSheet(row) {
  if (DRY_RUN) return log("[DRY_RUN] SHEET: " + JSON.stringify(row));

  try {
    const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const client = new google.auth.JWT(
      creds.client_email, null, creds.private_key,
      ["https://www.googleapis.com/auth/spreadsheets"]
    );

    await client.authorize();

    const sheets = google.sheets({ version: "v4", auth: client });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  } catch (err) {
    log("Sheets error: " + err.message);
  }
}

// ===== Telegram =====
async function sendTelegram(msg) {
  if (DRY_RUN) return log("[DRY_RUN] TG: " + msg);
  if (!TELEGRAM_BOT_TOKEN) return;

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "HTML" });
  } catch (err) {
    log("Telegram error: " + err.message);
  }
}

// ===== MAIN SYMBOL PROCESSOR =====
async function processSymbol(symbol) {
  log(`→ ${symbol}`);

  try {
    // ORB from 15-min chart
    const orb = await getORB15(symbol);
    if (!orb) return;

    // Indicators from 5-min chart
    const chart = await pRetry(() => yahooFinance.chart(symbol + ".NS", {
      period1: "3d",
      interval: "5m"
    }), { retries: RETRIES });

    const bars = extractBars(chart);
    if (bars.length < 50) return;

    const closes = bars.map(b => b.close);
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const vols = bars.map(b => b.volume);

    const last = bars[bars.length - 1];
    const lastClose = last.close;
    const lastVol = last.volume;

    // EMA20 & EMA50
    function EMA(values, period) {
      if (values.length < period) return null;
      const k = 2 / (period + 1);
      let ema = values.slice(0, period).reduce((a,b)=>a+b) / period;
      for (let i = period; i < values.length; i++)
        ema = values[i] * k + ema * (1 - k);
      return ema;
    }

    const ema20 = EMA(closes, 20);
    const ema50 = EMA(closes, 50);

    // ADX
    const adxSeries = ADX.calculate({
      high: highs.slice(-100),
      low: lows.slice(-100),
      close: closes.slice(-100),
      period: 14
    });
    const adxVal = adxSeries.pop()?.adx || 0;

    // Volume Spike
    const avgVol20 = vols.slice(-20).reduce((a,b)=>a+b, 0) / 20;
    const volSpike = lastVol > avgVol20 * VOLUME_MULTIPLIER;

    // Breakout → MUST CLOSE above ORB High
    const brokeHigh = lastClose > orb.high;
    const brokeLow = lastClose < orb.low;
    const upTrend = ema20 > ema50;
    const downTrend = ema20 < ema50;

    let signal = null;

    if (brokeHigh && upTrend && adxVal > ADX_THRESHOLD && volSpike)
      signal = "BUY";

    if (brokeLow && downTrend && adxVal > ADX_THRESHOLD && volSpike)
      signal = "SELL";

    if (!signal) return;

    const msg =
      `📈 <b>${signal} SIGNAL</b>\n` +
      `Symbol: <b>${symbol}</b>\n` +
      `Price: <b>${lastClose}</b>\n` +
      `ORB (H/L): <b>${orb.high} / ${orb.low}</b>\n` +
      `EMA20/50: <b>${ema20.toFixed(2)} / ${ema50.toFixed(2)}</b>\n` +
      `ADX: <b>${adxVal.toFixed(2)}</b>\n` +
      `Volume Spike: <b>${volSpike}</b>`;

    await sendTelegram(msg);

    await appendSheet([
      new Date().toISOString(),
      symbol,
      signal,
      lastClose,
      orb.high,
      orb.low,
      ema20.toFixed(2),
      ema50.toFixed(2),
      adxVal.toFixed(2),
      volSpike ? "YES" : "NO"
    ]);

  } catch (err) {
    log(`[${symbol}] ERROR: ${err.message}`);
  }
}

// ===== MAIN RUNNER =====
async function run() {
  log("=== Scanner Started ===");

  if (!isMarketOpen()) {
    log("Market closed. Exiting.");
    return;
  }

  const limit = pLimit(CONCURRENCY);
  await Promise.all(symbols.map(s => limit(() => processSymbol(s))));

  log("=== Scanner Completed ===");
}

run();
