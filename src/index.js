import yahooFinance from "yahoo-finance2";
import technicalIndicators from "technicalindicators";
import fetch from "node-fetch";
import { google } from "googleapis";

/* ===============================
   NSE SYMBOLS
================================ */
const SYMBOLS = [
  "RELIANCE.NS","TCS.NS","HDFCBANK.NS","INFY.NS","ICICIBANK.NS","SBIN.NS",
  "AXISBANK.NS","ITC.NS","LT.NS","MARUTI.NS","TITAN.NS","HINDUNILVR.NS",
  "BAJFINANCE.NS","ADANIENT.NS","ONGC.NS","NTPC.NS","POWERGRID.NS"
];

/* ===============================
   ENV VARIABLES
================================ */
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  SPREADSHEET_ID,
  SHEET_NAME = "Alerts"
} = process.env;

/* ===============================
   CONSTANTS
================================ */
const ADX_THRESHOLD = 20;
const VOLUME_MULTIPLIER = 1.3;

/* ===============================
   TELEGRAM
================================ */
function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: msg,
      parse_mode: "HTML"
    })
  }).catch(() => {});
}

/* ===============================
   GOOGLE SHEETS
================================ */
async function getSheetsClient() {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) return null;

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  return google.sheets({ version: "v4", auth: await auth.getClient() });
}

async function appendSheetRow(row) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  } catch (e) {
    console.log("Sheet error:", e.message);
  }
}

/* ===============================
   ORB
================================ */
function getORB(candles15) {
  if (!candles15?.length) return null;
  const first = candles15[0];
  return { high: first.high, low: first.low };
}

/* ===============================
   SIGNAL CHECK
================================ */
function checkSignal(symbol, orb, candles5) {
  if (!orb || !candles5 || candles5.length < 50) return null;

  const closes = candles5.map(c => c.close).filter(Boolean);
  const highs = candles5.map(c => c.high).filter(Boolean);
  const lows = candles5.map(c => c.low).filter(Boolean);
  const volumes = candles5.map(c => c.volume).filter(Boolean);

  if (closes.length < 50 || volumes.length < 20) return null;

  const ema20 = technicalIndicators.EMA.calculate({ period: 20, values: closes });
  const ema50 = technicalIndicators.EMA.calculate({ period: 50, values: closes });
  const adx = technicalIndicators.ADX.calculate({
    high: highs, low: lows, close: closes, period: 14
  });
  const avgVol20 = technicalIndicators.SMA.calculate({ period: 20, values: volumes });

  if (!ema20.length || !ema50.length || !adx.length || !avgVol20.length) return null;

  const last = candles5.at(-1);

  const trendUp = ema20.at(-1) > ema50.at(-1);
  const trendDown = ema20.at(-1) < ema50.at(-1);
  const strongADX = adx.at(-1)?.adx > ADX_THRESHOLD;
  const volumeSpike = last.volume > avgVol20.at(-1) * VOLUME_MULTIPLIER;

  if (last.close > orb.high && trendUp && strongADX && volumeSpike)
    return { type: "BUY", reason: "ORB Breakout + Trend + ADX + Volume" };

  if (last.close < orb.low && trendDown && strongADX && volumeSpike)
    return { type: "SELL", reason: "ORB Breakdown + Trend + ADX + Volume" };

  return null;
}

/* ===============================
   FETCH DATA
================================ */
async function fetchData(symbol) {
  try {
    const c5 = await yahooFinance.chart(symbol, { interval: "5m", range: "2d" });
    const c15 = await yahooFinance.chart(symbol, { interval: "15m", range: "1d" });
    return { candles5: c5.quotes, candles15: c15.quotes };
  } catch {
    return null;
  }
}

/* ===============================
   MAIN
================================ */
async function runScanner() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();

  // NSE market hours
  if (h < 9 || (h === 9 && m < 16) || h > 15) {
    console.log("Market closed. Safe exit.");
    process.exit(0);
  }

  for (const symbol of SYMBOLS) {
    const data = await fetchData(symbol);
    if (!data) continue;

    const orb = getORB(data.candles15);
    const signal = checkSignal(symbol, orb, data.candles5);

    if (signal) {
      const msg = `
<b>${signal.type} SIGNAL</b>
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
    }
  }

  process.exit(0);
}

runScanner().catch(err => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
