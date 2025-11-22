import axios from "axios";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import { EMA, ADX, ATR } from "technicalindicators";

// Load environment variables
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  SPREADSHEET_ID,
} = process.env;

if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
  console.error("❌ GOOGLE_SERVICE_ACCOUNT_JSON missing");
  process.exit(1);
}

const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

const auth = new GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

// Send telegram alert
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("Telegram error:", err?.response?.data || err.message);
  }
}

// Write to Google Sheets
async function writeToSheet(row) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Alerts!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
  } catch (err) {
    console.error("Sheet error:", err.message);
  }
}

// ORB + EMA + ADX + Volume Strategy
function applyStrategy(data) {
  const close = data.map(d => d.close);
  const high = data.map(d => d.high);
  const low = data.map(d => d.low);
  const volume = data.map(d => d.volume);

  const ema = EMA.calculate({ period: 20, values: close });
  const adx = ADX.calculate({ close, high, low, period: 14 });

  if (ema.length < 5 || adx.length < 5) return false;

  const latest = data[data.length - 1];
  const prev = data[data.length - 2];

  const orbBreakout = latest.high > prev.high && latest.low > prev.low;
  const volumeSpike = latest.volume > 1.5 * prev.volume;
  const emaSupport = latest.close > ema[ema.length - 1];
  const strongTrend = adx[adx.length - 1]?.adx > 25;

  return orbBreakout && volumeSpike && emaSupport && strongTrend;
}

// NSE symbols
const symbols = [
  "RELIANCE", "INFY", "TCS", "HDFCBANK", "ICICIBANK", "LT", "SBIN",
  "HINDUNILVR", "BHARTIARTL", "ITC", "KOTAKBANK", "ASIANPAINT", "AXISBANK",
  "MARUTI", "SUNPHARMA", "BAJFINANCE", "HCLTECH", "WIPRO", "NTPC", "TECHM",
  "POWERGRID", "ULTRACEMCO", "NESTLEIND", "TITAN", "ADANIENT", "COALINDIA",
  "ONGC", "BAJAJFINSV", "GRASIM", "CIPLA", "HDFCLIFE", "SBILIFE", "DRREDDY",
  "BRITANNIA", "DIVISLAB", "EICHERMOT", "HEROMOTOCO", "BPCL", "INDUSINDBK",
  "BAJAJ-AUTO", "TATAMOTORS", "ICICIPRULI", "SHREECEM", "DLF", "PIDILITIND",
  "TATACONSUM", "ADANIPORTS", "M&M"
];

// Main execution
async function run() {
  for (const symbol of symbols) {
    try {
      const url = `https://www.nseindia.com/api/chart-databyindex?index=${symbol}`;
      const res = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      const candles = res.data?.grapthData?.map(
        ([timestamp, open, high, low, close, volume]) => ({
          time: new Date(timestamp),
          open,
          high,
          low,
          close,
          volume,
        })
      );

      if (!candles || candles.length < 30) continue;

      if (applyStrategy(candles)) {
        const message = `📈 *Trade Alert*: ${symbol}\nORB + EMA + ADX + Volume breakout.\nTime: ${new Date().toLocaleString()}`;
        await sendTelegram(message);
        await writeToSheet([symbol, new Date().toISOString(), "Alert Triggered"]);
      }
    } catch (err) {
      console.error(`Error for ${symbol}: ${err.message}`);
    }
  }
}

run();
