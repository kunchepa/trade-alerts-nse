import axios from "axios";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import { EMA, ADX, ATR } from "technicalindicators";

// Load secrets from environment
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  SPREADSHEET_ID,
} = process.env;

// Parse service account JSON
const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

// Setup Google Sheets API
const auth = new GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// Utility: Send Telegram alert
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: "Markdown",
  });
}

// Utility: Write row to Google Sheet
async function writeToSheet(row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Alerts!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

// Strategy: Apply filters to stock data
function applyStrategy(data) {
  const close = data.map(d => d.close);
  const high = data.map(d => d.high);
  const low = data.map(d => d.low);
  const volume = data.map(d => d.volume);

  const ema = EMA.calculate({ period: 20, values: close });
  const adx = ADX.calculate({ close, high, low, period: 14 });
  const atr = ATR.calculate({ high, low, close, period: 14 });

  const latest = data[data.length - 1];
  const prev = data[data.length - 2];

  const orbBreakout = latest.high > prev.high && latest.low > prev.low;
  const volumeSpike = latest.volume > 1.5 * prev.volume;
  const emaSupport = latest.close > ema[ema.length - 1];
  const strongTrend = adx[adx.length - 1]?.adx > 25;

  return orbBreakout && volumeSpike && emaSupport && strongTrend;
}

// NSE100 stock list
const symbols = [
  "RELIANCE", "INFY", "TCS", "HDFCBANK", "ICICIBANK", "LT", "SBIN", "HINDUNILVR", "BHARTIARTL", "ITC",
  "KOTAKBANK", "ASIANPAINT", "AXISBANK", "MARUTI", "SUNPHARMA", "BAJFINANCE", "HCLTECH", "WIPRO", "NTPC", "TECHM",
  "POWERGRID", "ULTRACEMCO", "NESTLEIND", "TITAN", "ADANIENT", "COALINDIA", "ONGC", "BAJAJFINSV", "GRASIM", "CIPLA",
  "HDFCLIFE", "SBILIFE", "DRREDDY", "BRITANNIA", "DIVISLAB", "EICHERMOT", "HEROMOTOCO", "BPCL", "INDUSINDBK", "BAJAJ-AUTO",
  "TATAMOTORS", "ICICIPRULI", "SHREECEM", "DLF", "PIDILITIND", "TATACONSUM", "ADANIPORTS", "M&M", "SIEMENS", "AMBUJACEM",
  "GAIL", "VARUNBEV", "HAL", "TRENT", "TVSMOTOR", "BEL", "PNB", "BANKBARODA", "ATGL", "ADANIGREEN", "ADANITRANS", "DMART",
  "PAYTM", "ZOMATO", "NYKAA", "IRCTC", "INDIGO", "JIOFIN", "JIO", "BANDHANBNK", "CANBK", "IDFCFIRSTB", "CHOLAFIN", "AUBANK",
  "MUTHOOTFIN", "LIC", "POLYCAB", "ABB", "CROMPTON", "DIXON", "HAVELLS", "VOLTAS", "BERGEPAINT", "VARROC", "TATAELXSI",
  "NAUKRI", "LTIM", "LTI", "MPHASIS", "COFORGE", "PERSISTENT", "BOSCHLTD", "INDIAMART", "IRFC", "NHPC", "NLCINDIA", "SJVN",
  "NBCC", "RVNL", "RITES", "BHEL", "IOCL", "SAIL"
];

// Main: Run alerts
async function run() {
  for (const symbol of symbols) {
    try {
      const url = `https://www.nseindia.com/api/chart-databyindex?index=${symbol}`;
      const res = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      const candles = res.data?.grapthData?.map(([timestamp, open, high, low, close, volume]) => ({
        time: new Date(timestamp),
        open, high, low, close, volume,
      }));

      if (!candles || candles.length < 30) continue;

      const valid = applyStrategy(candles);
      if (valid) {
        const message = `📈 *Trade Alert*: ${symbol}\nORB + EMA + ADX + Volume breakout confirmed.\nTime: ${new Date().toLocaleString()}`;
        await sendTelegram(message);
        await writeToSheet([symbol, new Date().toISOString(), "Alert Triggered"]);
      }
    } catch (err) {
      console.error(`Error for ${symbol}:`, err.message);
    }
  }
}

run();
