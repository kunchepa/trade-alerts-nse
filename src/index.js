import yahooFinance from "yahoo-finance2";
import technicalIndicators from "technicalindicators";
import fetch from "node-fetch";
import { google } from "googleapis";

// ---------------- CONFIG ----------------
const SYMBOLS = [
  "RELIANCE.NS","TCS.NS","HDFCBANK.NS","INFY.NS","ICICIBANK.NS",
  "SBIN.NS","AXISBANK.NS","BAJFINANCE.NS","ITC.NS","TITAN.NS"
];

const ADX_MIN = 18;
const VOLUME_MULTIPLIER = 0.9;

// ---------------- TELEGRAM ----------------
async function sendTelegram(msg) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;

  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "HTML"
      })
    }
  );
}

// ---------------- GOOGLE SHEETS ----------------
async function appendSheetRow(row) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${process.env.SHEET_NAME}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  } catch (e) {
    console.log("Sheet error:", e.message);
  }
}

// ---------------- SIGNAL LOGIC ----------------
function checkSignal(candles) {
  if (candles.length < 60) return null;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const ema20 = technicalIndicators.EMA.calculate({ period: 20, values: closes });
  const ema50 = technicalIndicators.EMA.calculate({ period: 50, values: closes });
  const adxArr = technicalIndicators.ADX.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14
  });
  const volAvg = technicalIndicators.SMA.calculate({ period: 20, values: volumes });

  const last = candles.at(-1);
  const adxNow = adxArr.at(-1)?.adx;
  const adxPrev = adxArr.at(-2)?.adx;

  if (!adxNow || !adxPrev) return null;

  const adxRising = adxNow > ADX_MIN && adxNow > adxPrev;
  const volumeOk = last.volume > volAvg.at(-1) * VOLUME_MULTIPLIER;

  if (ema20.at(-1) > ema50.at(-1) && adxRising && volumeOk && last.close > ema20.at(-1)) {
    return { type: "BUY", reason: "EMA20>EMA50 + ADX rising" };
  }

  if (ema20.at(-1) < ema50.at(-1) && adxRising && volumeOk && last.close < ema20.at(-1)) {
    return { type: "SELL", reason: "EMA20<EMA50 + ADX rising" };
  }

  return null;
}

// ---------------- FETCH DATA ----------------
async function fetchData(symbol) {
  try {
    const data = await yahooFinance.chart(symbol, {
      interval: "5m",
      range: "2d"
    });
    return data.quotes;
  } catch {
    return null;
  }
}

// ---------------- MAIN ----------------
async function runScanner() {
  const now = new Date();

  for (const symbol of SYMBOLS) {
    const candles = await fetchData(symbol);
    if (!candles) continue;

    const signal = checkSignal(candles);
    if (!signal) continue;

    const msg = `<b>${signal.type} ALERT</b>
Symbol: <b>${symbol}</b>
Logic: ${signal.reason}
Time: ${now.toLocaleTimeString()}`;

    await sendTelegram(msg);
    await appendSheetRow([now.toLocaleString(), symbol, signal.type, signal.reason]);
  }
}

await runScanner();
process.exit(0);
