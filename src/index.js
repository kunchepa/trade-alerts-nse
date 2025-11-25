/**
 * src/index.js
 * Advanced ORB15 + 5-min indicators trade scanner
 *
 * Environment variables (set as GitHub secrets):
 * TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
 * GOOGLE_SERVICE_ACCOUNT_JSON, SPREADSHEET_ID,
 * DRY_RUN (true/false), TEST_LIMIT (number), CONCURRENCY, RETRIES
 *
 * This script runs once per invocation (no internal cron). Use external CRON (GitHub Actions).
 */

import yahooFinance from "yahoo-finance2";
import axios from "axios";
import pLimit from "p-limit";
import pRetry from "p-retry";
import { google } from "googleapis";
import { ADX } from "technicalindicators";
import winston from "winston";
import fs from "fs";
import path from "path";

// ---------- CONFIG ----------
const TEST_LIMIT = process.env.TEST_LIMIT ? Number(process.env.TEST_LIMIT) : null;
const DRY_RUN = process.env.DRY_RUN === "true" || false;
const CONCURRENCY = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : 6;
const RETRIES = process.env.RETRIES ? Number(process.env.RETRIES) : 2;

const ADX_THRESHOLD = process.env.ADX_THRESHOLD ? Number(process.env.ADX_THRESHOLD) : 20;
const VOLUME_MULTIPLIER = process.env.VOLUME_MULTIPLIER ? Number(process.env.VOLUME_MULTIPLIER) : 1.3;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Alerts";

// ---------- SYMBOLS (data/symbols.json will be used if exists) ----------
const dataSymbolsPath = path.join(process.cwd(), "data", "symbols.json");
let SYMBOLS = [
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

// load symbols.json if present
try {
  if (fs.existsSync(dataSymbolsPath)) {
    const raw = fs.readFileSync(dataSymbolsPath, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) SYMBOLS = arr;
  }
} catch (e) {
  // ignore and use built-in list
}

// apply TEST_LIMIT
if (TEST_LIMIT) SYMBOLS = SYMBOLS.slice(0, TEST_LIMIT);

// ---------- Logging (winston) ----------
const logsDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(info => `${info.timestamp} ${info.level.toUpperCase()}: ${info.message}`)
  ),
  transports: [
    new winston.transports.File({ filename: path.join(logsDir, `${new Date().toISOString().slice(0,10)}.log`) }),
    new winston.transports.Console()
  ]
});

function log(...args) { logger.info(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")); }

// ---------- Time helpers ----------
function toISTDate(ms) {
  const d = new Date(ms);
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  return new Date(utc + (5.5 * 3600 * 1000));
}
function nowIST() {
  const utc = Date.now() + (new Date().getTimezoneOffset() * 60000);
  return new Date(utc + (5.5 * 3600 * 1000));
}
function isMarketOpenIST() {
  const ist = nowIST();
  const h = ist.getHours();
  const m = ist.getMinutes();
  const hm = h + m/60;
  return hm >= 9.25 && hm <= 15.5;
}

// ---------- Yahoo helpers ----------
function extractOHLCV(chart) {
  try {
    const r = chart?.result?.[0];
    if (!r) return [];
    const q = r.indicators?.quote?.[0];
    const ts = r.timestamp || [];
    const out = [];
    for (let i=0;i<ts.length;i++){
      const c = q?.close?.[i];
      if (c == null) continue;
      out.push({
        ts: ts[i]*1000,
        open: q.open?.[i],
        high: q.high?.[i],
        low: q.low?.[i],
        close: q.close?.[i],
        volume: q.volume?.[i]
      });
    }
    return out;
  } catch (e) {
    log("extractOHLCV error", e.message || e);
    return [];
  }
}

// ---------- ORB15 fetcher (15-min chart) ----------
async function getORB15(symbol) {
  const chart = await pRetry(() => yahooFinance.chart(`${symbol}.NS`, { period1: "1d", interval: "15m" }), { retries: RETRIES });
  const bars = extractOHLCV(chart);
  const orbBars = bars.filter(b => {
    const t = toISTDate(b.ts);
    const hm = t.getHours() + t.getMinutes()/60;
    return hm >= 9.25 && hm < 9.5; // 9:15–9:30
  });
  if (!orbBars.length) return null;
  const high = Math.max(...orbBars.map(b=>b.high));
  const low = Math.min(...orbBars.map(b=>b.low));
  return { high, low };
}

// ---------- Indicators on 5-min ----------
function EMA(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2/(period+1);
  let ema = values.slice(0,period).reduce((a,b)=>a+(b||0),0)/period;
  for (let i=period;i<values.length;i++){
    ema = values[i]*k + ema*(1-k);
  }
  return ema;
}

function computeADX(highs, lows, closes, period=14) {
  try {
    const res = ADX.calculate({ high: highs, low: lows, close: closes, period });
    if (!Array.isArray(res) || res.length===0) return null;
    const last = res[res.length-1];
    if (typeof last === "number") return last;
    if (last && last.adx!=null) return Number(last.adx);
    return null;
  } catch(e) {
    log("computeADX error", e.message || e);
    return null;
  }
}

// ---------- Google Sheets ----------
async function appendToSheet(row) {
  if (DRY_RUN) { log("[DRY_RUN] sheets append", row); return; }
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !SPREADSHEET_ID) { log("Sheets env missing, skipping"); return; }
  try {
    const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const client = new google.auth.JWT(creds.client_email, null, creds.private_key, ["https://www.googleapis.com/auth/spreadsheets"]);
    await client.authorize();
    const sheets = google.sheets({ version: "v4", auth: client });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  } catch (e) {
    log("appendToSheet error", e.message || e);
  }
}

// ---------- Telegram ----------
async function sendTelegram(msg) {
  if (DRY_RUN) { log("[DRY_RUN] telegram", msg.replace(/\\n/g," | ")); return; }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { log("Telegram env missing, skipping"); return; }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "HTML" });
  } catch (e) {
    log("sendTelegram error", e.message || e);
  }
}

// ---------- Per-symbol processing ----------
async function processSymbol(symbol) {
  log("PROCESS", symbol);
  try {
    const orb = await getORB15(symbol);
    if (!orb) { log(symbol, "ORB15 not available"); return null; }

    const chart = await pRetry(() => yahooFinance.chart(`${symbol}.NS`, { period1: "3d", interval: "5m" }), { retries: RETRIES });
    const bars = extractOHLCV(chart);
    if (!bars || bars.length < 30) { log(symbol, "not enough 5m bars"); return null; }

    const closes = bars.map(b=>b.close);
    const highs = bars.map(b=>b.high);
    const lows = bars.map(b=>b.low);
    const volumes = bars.map(b=>b.volume);

    const ema20 = EMA(closes, 20);
    const ema50 = EMA(closes, 50);
    if (ema20==null || ema50==null) { log(symbol, "insufficient EMA data"); return null; }

    const adx = computeADX(highs.slice(-100), lows.slice(-100), closes.slice(-100), 14);
    if (adx==null) { log(symbol, "ADX not computed"); return null; }

    const validVols = volumes.filter(v => v!=null && v>0);
    const avgVol20 = validVols.length >= 20 ? validVols.slice(-20).reduce((a,b)=>a+b,0)/20 : (validVols.reduce((a,b)=>a+b,0)/(validVols.length||1));
    const lastBar = bars[bars.length-1];
    const lastClose = lastBar.close;
    const lastVol = lastBar.volume || 0;
    const volSpike = avgVol20>0 ? (lastVol > avgVol20 * VOLUME_MULTIPLIER) : false;

    const brokeHigh = lastClose > orb.high;
    const brokeLow = lastClose < orb.low;
    const upTrend = ema20 > ema50;
    const downTrend = ema20 < ema50;
    const adxOk = adx > ADX_THRESHOLD;

    log(symbol, { lastClose, orbHigh: orb.high, orbLow: orb.low, brokeHigh, brokeLow, upTrend, downTrend, adx, adxOk, volSpike });

    let signal = null;
    if (brokeHigh && upTrend && adxOk && volSpike) signal = "BUY";
    if (brokeLow && downTrend && adxOk && volSpike) signal = "SELL";
    if (!signal) return null;

    const price = lastClose;
    const msg = [
      `📈 <b>${signal} SIGNAL</b>`,
      `Symbol: <b>${symbol}</b>`,
      `Price: <b>${price}</b>`,
      `ORB15 H/L: <b>${orb.high} / ${orb.low}</b>`,
      `EMA20/50: <b>${ema20.toFixed(2)} / ${ema50.toFixed(2)}</b>`,
      `ADX: <b>${adx.toFixed(2)}</b>`,
      `Volume Spike: <b>${volSpike ? "YES" : "NO"}</b>`
    ].join("\\n");

    log(symbol, "SIGNAL", signal);
    await sendTelegram(msg);

    await appendToSheet([ new Date().toISOString(), symbol, signal, price, orb.high, orb.low, ema20.toFixed(2), ema50.toFixed(2), adx.toFixed(2), volSpike ? "YES":"NO" ]);

    return { symbol, signal, price };
  } catch (e) {
    log("processSymbol error", symbol, e.message || e);
    return null;
  }
}

// ---------- Runner ----------
async function runScanner() {
  log("=== RUN START ===");
  try {
    if (!isMarketOpenIST()) {
      log("Market closed (IST). Exiting.");
      return;
    }

    const limit = pLimit(CONCURRENCY);
    const tasks = SYMBOLS.map(sym => limit(() => pRetry(() => processSymbol(sym), { retries: RETRIES }).catch(e=>log("final fail", sym, e.message || e))));
    const results = await Promise.all(tasks);
    const signals = results.filter(Boolean);
    log("Scan complete. Signals:", signals.length);
    if (signals.length) {
      const health = `Trade Scanner Status: OK\\nSignals: ${signals.length}`;
      await sendTelegram(health);
    } else {
      log("No signals found this run.");
    }
  } catch (e) {
    log("runScanner crashed", e.message || e);
    try { await sendTelegram(`❌ Trade Scanner CRASHED\\nReason: ${e.message || e}`); } catch {}
  } finally {
    log("=== RUN END ===");
  }
}

// start
runScanner();
