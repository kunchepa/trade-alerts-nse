import yahooFinance from "yahoo-finance2";
import technicalIndicators from "technicalindicators";
import fetch from "node-fetch";
import { google } from "googleapis";

/* =====================================================
   CONFIG
===================================================== */

const ADX_THRESHOLD = 12;          // Aggressive
const MOMENTUM_ADX = 18;
const VOLUME_MULTIPLIER = 1.1;
const MOMENTUM_VOLUME = 1.5;
const ORB_BUFFER = 0.001;
const ATR_PCT_THRESHOLD = 0.009;

/* =====================================================
   ENV
===================================================== */

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  SPREADSHEET_ID,
  SHEET_NAME = "Alerts"
} = process.env;

/* =====================================================
   TELEGRAM
===================================================== */

async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "HTML"
      })
    });
  } catch {}
}

/* =====================================================
   GOOGLE SHEETS
===================================================== */

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
  } catch {}
}

/* =====================================================
   DATA
===================================================== */

async function fetchData(symbol) {
  try {
    const c5 = await yahooFinance.chart(symbol, { interval: "5m", range: "2d" });
    const c15 = await yahooFinance.chart(symbol, { interval: "15m", range: "1d" });
    if (!c5?.quotes?.length || !c15?.quotes?.length) return null;
    return { c5: c5.quotes, c15: c15.quotes };
  } catch {
    return null;
  }
}

/* =====================================================
   MOMENTUM DETECTOR
===================================================== */

function isMomentumStock(candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const adxArr = technicalIndicators.ADX.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14
  });

  const atrArr = technicalIndicators.ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14
  });

  const avgVol = technicalIndicators.SMA.calculate({
    period: 20,
    values: volumes
  });

  if (!adxArr.length || !atrArr.length || !avgVol.length) return false;

  const last = candles.at(-1);
  const prev = candles.at(-2);

  let score = 0;

  if (Math.abs((last.close - prev.close) / prev.close) >= 0.008) score++;
  if (last.volume >= avgVol.at(-1) * MOMENTUM_VOLUME) score++;
  if ((atrArr.at(-1) / last.close) >= ATR_PCT_THRESHOLD) score++;
  if (adxArr.at(-1).adx >= MOMENTUM_ADX) score++;

  return score >= 2;
}

/* =====================================================
   SIGNAL LOGIC (AGGRESSIVE)
===================================================== */

function checkSignal(orb, candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const ema20 = technicalIndicators.EMA.calculate({ period: 20, values: closes });
  const ema50 = technicalIndicators.EMA.calculate({ period: 50, values: closes });
  const adxArr = technicalIndicators.ADX.calculate({
    high: highs, low: lows, close: closes, period: 14
  });
  const avgVol = technicalIndicators.SMA.calculate({ period: 20, values: volumes });

  if (!ema20.length || !ema50.length || !adxArr.length || !avgVol.length) return null;

  const last = candles.at(-1);

  const trendUp = ema20.at(-1) >= ema50.at(-1);
  const trendDown = ema20.at(-1) <= ema50.at(-1);

  const strongADX = adxArr.at(-1).adx >= ADX_THRESHOLD;
  const volumeSpike = last.volume >= avgVol.at(-1) * VOLUME_MULTIPLIER;

  const buyBreak =
    last.close > orb.high * (1 + ORB_BUFFER) ||
    (last.close > ema20.at(-1) && last.close > ema50.at(-1));

  const sellBreak =
    last.close < orb.low * (1 - ORB_BUFFER) ||
    (last.close < ema20.at(-1) && last.close < ema50.at(-1));

  if (buyBreak && trendUp && (strongADX || volumeSpike))
    return "BUY";

  if (sellBreak && trendDown && (strongADX || volumeSpike))
    return "SELL";

  return null;
}

/* =====================================================
   MAIN
===================================================== */

async function runScanner() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();

  if (h < 9 || (h === 9 && m < 16) || h > 15) return;

  const universe = await yahooFinance.trendingSymbols("IN");
  const symbols = universe.quotes
    .filter(s => s.symbol.endsWith(".NS"))
    .slice(0, 40)
    .map(s => s.symbol);

  for (const symbol of symbols) {
    const data = await fetchData(symbol);
    if (!data) continue;

    if (!isMomentumStock(data.c5)) continue;

    const orb = { high: data.c15[0].high, low: data.c15[0].low };
    const signal = checkSignal(orb, data.c5);

    if (signal) {
      const msg = `
<b>${signal} SIGNAL</b>
<b>Stock:</b> ${symbol}
<b>Mode:</b> AGGRESSIVE
<b>Time:</b> ${now.toLocaleTimeString()}
      `;
      await sendTelegram(msg);
      await appendSheetRow([
        now.toLocaleString(), symbol, signal, "Aggressive Momentum"
      ]);
    }
  }
}

runScanner();
