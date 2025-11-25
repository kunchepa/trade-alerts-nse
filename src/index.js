import fs from 'fs';
import yahooFinance from 'yahoo-finance2';
import { google } from 'googleapis';
import fetch from 'node-fetch';
import technicalIndicators from 'technicalindicators';
import path from 'path';

const __dirname = path.resolve();

// ----------------------
// Load Symbols
// ----------------------
const symbolsPath = path.join(__dirname, 'data', 'symbols.json');
const SYMBOLS = JSON.parse(fs.readFileSync(symbolsPath, 'utf8'));

// ----------------------
// ENV Variables
// ----------------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Alerts";

const ADX_THRESHOLD = 20;
const VOLUME_MULTIPLIER = 1.3;

// ----------------------
// Utilities
// ----------------------
function log(msg) {
  console.log(msg);
}

function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: msg,
      parse_mode: "HTML"
    })
  });
}

// ----------------------
// Google Sheets Client
// ----------------------
async function getSheetsClient() {
  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

  const client = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth: await client.getClient() });
}

async function appendSheetRow(row) {
  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  } catch (err) {
    console.error("Google Sheets Error:", err);
  }
}

// ----------------------
// ORB Logic
// ----------------------
function getORB(candles15) {
  const firstCandle = candles15[0];
  return {
    high: firstCandle.high,
    low: firstCandle.low
  };
}

// ----------------------
// Main Signal Logic
// ----------------------
function checkSignal(symbol, orb, candles5) {
  const closes = candles5.map(c => c.close);
  const highs = candles5.map(c => c.high);
  const lows = candles5.map(c => c.low);
  const volumes = candles5.map(c => c.volume);

  const ema20 = technicalIndicators.EMA.calculate({ period: 20, values: closes });
  const ema50 = technicalIndicators.EMA.calculate({ period: 50, values: closes });
  const adx = technicalIndicators.ADX.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14
  });

  const avgVol20 = technicalIndicators.SMA.calculate({ period: 20, values: volumes });
  const lastCandle = candles5[candles5.length - 1];

  const trendUp = ema20[ema20.length - 1] > ema50[ema50.length - 1];
  const trendDown = ema20[ema20.length - 1] < ema50[ema50.length - 1];
  const strongADX = adx[adx.length - 1].adx > ADX_THRESHOLD;
  const volumeSpike = lastCandle.volume > avgVol20[avgVol20.length - 1] * VOLUME_MULTIPLIER;

  if (lastCandle.close > orb.high && trendUp && strongADX && volumeSpike) {
    return {
      type: "BUY",
      reason: "ORB Breakout + Trend Up + ADX > 20 + Volume Spike"
    };
  }

  if (lastCandle.close < orb.low && trendDown && strongADX && volumeSpike) {
    return {
      type: "SELL",
      reason: "ORB Breakdown + Trend Down + ADX > 20 + Volume Spike"
    };
  }

  return null;
}

// ----------------------
// Fetch Yahoo Data
// ----------------------
async function fetchCandleData(symbol) {
  try {
    log(`📡 Fetching data → ${symbol}`);
    const candles5 = await yahooFinance.chart(symbol, { interval: "5m", range: "2d" });
    const candles15 = await yahooFinance.chart(symbol, { interval: "15m", range: "1d" });

    return {
      candles5: candles5.quotes,
      candles15: candles15.quotes
    };
  } catch (err) {
    console.error(`❌ Error fetching ${symbol}:`, err);
    return null;
  }
}

// ----------------------
// Main Scanner
// ----------------------
async function runScanner() {
  log("=== Scanner Started ===");

  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();

  // Market hours check
  if (hour < 9 || (hour === 9 && minute < 16) || hour > 15) {
    log("Market closed. Exiting.");
    return;
  }

  for (const symbol of SYMBOLS) {
    const data = await fetchCandleData(symbol);
    if (!data) continue;

    const { candles5, candles15 } = data;
    const orb = getORB(candles15);
    const signal = checkSignal(symbol, orb, candles5);

    if (signal) {
      const msg = `
<b>${signal.type} Signal</b>
Symbol: <b>${symbol}</b>
Reason: ${signal.reason}
Time: ${now.toLocaleTimeString()}
      `;

      sendTelegram(msg);

      appendSheetRow([
        new Date().toLocaleString(),
        symbol,
        signal.type,
        signal.reason
      ]);

      log(`✔ SIGNAL → ${symbol} → ${signal.type}`);
    }
  }

  log("=== Scan Complete ===");
}

// Run
runScanner();
