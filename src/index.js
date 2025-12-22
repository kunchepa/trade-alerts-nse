import yahooFinance from "yahoo-finance2";
import ti from "technicalindicators";
import fetch from "node-fetch";
import { google } from "googleapis";

/* ---------------- CONFIG ---------------- */

const SYMBOLS = [
  "RELIANCE.NS","TCS.NS","HDFCBANK.NS","INFY.NS","ICICIBANK.NS","SBIN.NS",
  "AXISBANK.NS","ITC.NS","LT.NS","HINDUNILVR.NS","KOTAKBANK.NS","BAJFINANCE.NS"
];

const ADX_THRESHOLD = 20;
const VOLUME_MULTIPLIER = 1.3;

/* ---------------- ENV ---------------- */

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  SPREADSHEET_ID,
  SHEET_NAME = "Alerts"
} = process.env;

/* ---------------- TELEGRAM ---------------- */

async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: msg,
          parse_mode: "HTML"
        })
      }
    );
  } catch (err) {
    console.log("Telegram error:", err.message);
  }
}

/* ---------------- GOOGLE SHEETS ---------------- */

async function appendSheetRow(row) {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !SPREADSHEET_ID) return;

  try {
    const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    const sheets = google.sheets({
      version: "v4",
      auth: await auth.getClient()
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  } catch (err) {
    console.log("Sheet error:", err.message);
  }
}

/* ---------------- DATA ---------------- */

async function fetchData(symbol) {
  try {
    const c5 = await yahooFinance.chart(symbol, { interval: "5m", range: "2d" });
    const c15 = await yahooFinance.chart(symbol, { interval: "15m", range: "1d" });

    if (!c5?.quotes?.length || !c15?.quotes?.length) return null;

    return { candles5: c5.quotes, candles15: c15.quotes };
  } catch {
    return null;
  }
}

/* ---------------- LOGIC ---------------- */

function getORB(c15) {
  return { high: c15[0].high, low: c15[0].low };
}

function checkSignal(symbol, orb, candles5) {
  if (candles5.length < 50) return null;

  const closes = candles5.map(c => c.close);
  const highs = candles5.map(c => c.high);
  const lows = candles5.map(c => c.low);
  const volumes = candles5.map(c => c.volume);

  const ema20 = ti.EMA.calculate({ period: 20, values: closes });
  const ema50 = ti.EMA.calculate({ period: 50, values: closes });
  const adx = ti.ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const avgVol = ti.SMA.calculate({ period: 20, values: volumes });

  if (!adx.length || !avgVol.length) return null;

  const last = candles5.at(-1);

  const trendUp = ema20.at(-1) > ema50.at(-1);
  const trendDown = ema20.at(-1) < ema50.at(-1);
  const strongADX = adx.at(-1).adx > ADX_THRESHOLD;
  const volumeSpike = last.volume > avgVol.at(-1) * VOLUME_MULTIPLIER;

  if (last.close > orb.high && trendUp && strongADX && volumeSpike)
    return { type: "BUY", reason: "ORB + EMA + ADX + Volume" };

  if (last.close < orb.low && trendDown && strongADX && volumeSpike)
    return { type: "SELL", reason: "ORB + EMA + ADX + Volume" };

  return null;
}

/* ---------------- MAIN ---------------- */

async function runScanner() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();

  if (h < 9 || (h === 9 && m < 16) || h > 15) {
    console.log("Market closed.");
    return;
  }

  for (const symbol of SYMBOLS) {
    const data = await fetchData(symbol);
    if (!data) continue;

    const orb = getORB(data.candles15);
    const sig = checkSignal(symbol, orb, data.candles5);

    if (sig) {
      const msg = `📈 <b>${sig.type}</b>\n<b>${symbol}</b>\n${sig.reason}\n${now.toLocaleTimeString()}`;
      await sendTelegram(msg);

      await appendSheetRow([
        now.toLocaleString(), symbol, sig.type, sig.reason
      ]);
    }
  }
}

runScanner();
