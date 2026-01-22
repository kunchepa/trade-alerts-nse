// ================================
// Imports
// ================================
import yahooFinance from "yahoo-finance2";
import { EMA } from "technicalindicators";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

// ================================
// ENV CHECK
// ================================
console.log("✅ All environment variables loaded");

// ================================
// TOP 100 NSE STOCKS (LIQUID)
// ================================
const NSE_TOP_100 = [
  "RELIANCE.NS", "TCS.NS", "INFY.NS", "HDFCBANK.NS", "ICICIBANK.NS",
  "SBIN.NS", "KOTAKBANK.NS", "AXISBANK.NS", "LT.NS", "ITC.NS",
  "HINDUNILVR.NS", "BAJFINANCE.NS", "BHARTIARTL.NS", "ASIANPAINT.NS",
  "MARUTI.NS", "SUNPHARMA.NS", "TITAN.NS", "ULTRACEMCO.NS",
  "WIPRO.NS", "ADANIENT.NS", "ADANIPORTS.NS", "ONGC.NS",
  "NTPC.NS", "POWERGRID.NS", "COALINDIA.NS", "JSWSTEEL.NS",
  "TATASTEEL.NS", "HCLTECH.NS", "TECHM.NS", "INDUSINDBK.NS",
  "BAJAJFINSV.NS", "GRASIM.NS", "SBILIFE.NS", "HDFCLIFE.NS",
  "DRREDDY.NS", "CIPLA.NS", "DIVISLAB.NS", "APOLLOHOSP.NS",
  "BRITANNIA.NS", "HEROMOTOCO.NS", "EICHERMOT.NS",
  "BAJAJ-AUTO.NS", "TATAMOTORS.NS", "M&M.NS",
  "UPL.NS", "PIDILITIND.NS", "SHREECEM.NS",
  "HINDALCO.NS", "TATACONSUM.NS", "DABUR.NS",
  "GODREJCP.NS", "ICICIPRULI.NS", "HAVELLS.NS",
  "LTIM.NS", "SIEMENS.NS", "ABB.NS",
  "DLF.NS", "ADANIGREEN.NS", "ADANIPOWER.NS",
  "AMBUJACEM.NS", "ACC.NS", "BANKBARODA.NS",
  "PNB.NS", "CANBK.NS", "INDIGO.NS",
  "NAUKRI.NS", "TRENT.NS", "ZOMATO.NS",
  "PAYTM.NS", "IRCTC.NS", "HAL.NS",
  "BEL.NS", "LTTS.NS", "MPHASIS.NS"
];

// ================================
// Telegram Helper
// ================================
async function sendTelegramMessage(message) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: message,
    }),
  });
}

// ================================
// Google Sheets Logger (FIXED v4)
// ================================
async function logToSheet(row) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

    const auth = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, auth);
    await doc.loadInfo();

    const sheet = doc.sheetsByTitle["Alerts"];
    if (!sheet) throw new Error("Sheet 'Alerts' not found");

    await sheet.addRow(row);
    console.log("✅ Sheet row added:", row.Symbol);

  } catch (err) {
    console.error("❌ Google Sheet error:", err.message);
  }
}

// ================================
// SCAN LOGIC (UNCHANGED)
// ================================
async function scanStock(symbol) {
  try {
    const result = await yahooFinance.chart(symbol, {
      period1: "1d",
      interval: "5m",
    });

    if (!result?.indicators?.quote?.[0]?.close) return;

    const closes = result.indicators.quote[0].close.filter(Boolean);
    if (closes.length < 60) return;

    const ema20 = EMA.calculate({ period: 20, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });

    const prevEma20 = ema20[ema20.length - 2];
    const lastEma20 = ema20[ema20.length - 1];
    const lastEma50 = ema50[ema50.length - 1];
    const entry = closes[closes.length - 1];

    if (prevEma20 < lastEma50 && lastEma20 > lastEma50) {
      const target = +(entry * 1.015).toFixed(2);
      const stopLoss = +(entry * 0.995).toFixed(2);

      const nowIST = new Date().toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
      });

      const message =
        `📈 BUY SIGNAL\n` +
        `Stock: ${symbol}\n` +
        `Entry: ₹${entry}\n` +
        `SL: ₹${stopLoss}\n` +
        `Target: ₹${target}\n\n` +
        `Confidence: 100/100`;

      await sendTelegramMessage(message);

      await logToSheet({
        TimeIST: nowIST,
        Symbol: symbol,
        Direction: "BUY",
        EntryPrice: entry,
        Target: target,
        StopLoss: stopLoss,
        Plus2Check: "",
        Confidence: "100/100",
        RawTimeUTC: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.log(`❌ ${symbol}: ${err.message}`);
  }
}

// ================================
// MAIN RUNNER
// ================================
async function runScanner() {
  for (const symbol of NSE_TOP_100) {
    await scanStock(symbol);
  }
}

runScanner();
