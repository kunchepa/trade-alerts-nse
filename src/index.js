import yahooFinance from "yahoo-finance2";
import technicalIndicators from "technicalindicators";
import fetch from "node-fetch";
import { google } from "googleapis";

// ------------------------------------
// NSE STOCKS
// ------------------------------------
const SYMBOLS = [
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

// ------------------------------------
// ENV VARIABLES
// ------------------------------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Alerts";

// ------------------------------------
// PARAMETERS (REALISTIC)
// ------------------------------------
const ADX_MIN = 18;
const VOLUME_MULTIPLIER = 0.9;

// ------------------------------------
// TELEGRAM
// ------------------------------------
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
  });
}

// ------------------------------------
// GOOGLE SHEETS
// ------------------------------------
async function appendSheetRow(row) {
  try {
    const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });

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

// ------------------------------------
// SIGNAL LOGIC (ALIGNED WITH TV)
// ------------------------------------
function checkSignal(symbol, candles) {
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
  const avgVol20 = technicalIndicators.SMA.calculate({ period: 20, values: volumes });

  const last = candles.at(-1);
  const adxNow = adxArr.at(-1)?.adx;
  const adxPrev = adxArr.at(-2)?.adx;

  if (!adxNow || !adxPrev) return null;

  const trendUp = ema20.at(-1) > ema50.at(-1);
  const trendDown = ema20.at(-1) < ema50.at(-1);
  const adxRising = adxNow > ADX_MIN && adxNow > adxPrev;
  const volumeOk = last.volume > avgVol20.at(-1) * VOLUME_MULTIPLIER;

  // LONG
  if (trendUp && adxRising && volumeOk && last.close > ema20.at(-1)) {
    return { type: "BUY", reason: "EMA Trend + ADX Rising" };
  }

  // SHORT
  if (trendDown && adxRising && volumeOk && last.close < ema20.at(-1)) {
    return { type: "SELL", reason: "EMA Trend + ADX Rising" };
  }

  return null;
}

// ------------------------------------
// FETCH DATA
// ------------------------------------
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

// ------------------------------------
// MAIN SCANNER
// ------------------------------------
async function runScanner() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();

  // NSE market timing
  if (h < 9 || (h === 9 && m < 20) || h > 15 || (h === 15 && m > 10)) {
    console.log("Market closed");
    return;
  }

  for (const symbol of SYMBOLS) {
    const candles = await fetchData(symbol);
    if (!candles) continue;

    const signal = checkSignal(symbol, candles);
    if (!signal) continue;

    const msg = `<b>${signal.type} ALERT</b>
Symbol: <b>${symbol}</b>
Logic: ${signal.reason}
Time: ${now.toLocaleTimeString()}`;

    sendTelegram(msg);
    appendSheetRow([now.toLocaleString(), symbol, signal.type, signal.reason]);
  }
}

// ------------------------------------
// RUN EVERY 5 MINUTES
// ------------------------------------
runScanner();
setInterval(runScanner, 5 * 60 * 1000);
