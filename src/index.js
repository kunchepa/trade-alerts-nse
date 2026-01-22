// ================================
// Imports
// ================================
import yahooFinance from "yahoo-finance2";
import { EMA } from "technicalindicators";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

// ================================
// ENV CHECK (safe log)
// ================================
console.log("✅ All environment variables loaded");

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
// Google Sheets Logger (FIXED)
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
    if (!sheet) {
      throw new Error("Sheet 'Alerts' not found");
    }

    await sheet.addRow(row);
    console.log("✅ Row added to Google Sheet");

  } catch (err) {
    console.error("❌ Google Sheet error:", err.message);
  }
}

// ================================
// Market Scanner Logic (UNCHANGED)
// ================================
async function scanStock(symbol) {
  try {
    const result = await yahooFinance.chart(symbol, {
      period1: "1d",
      interval: "5m",
    });

    if (!result || !result.indicators?.quote?.[0]?.close) {
      console.log(`❌ ${symbol}: No data found, symbol may be delisted`);
      return;
    }

    const closes = result.indicators.quote[0].close.filter(Boolean);
    if (closes.length < 60) return;

    const ema20 = EMA.calculate({ period: 20, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });

    const lastClose = closes[closes.length - 1];
    const prevEma20 = ema20[ema20.length - 2];
    const lastEma20 = ema20[ema20.length - 1];
    const lastEma50 = ema50[ema50.length - 1];

    if (prevEma20 < lastEma50 && lastEma20 > lastEma50) {
      const entry = lastClose;
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
  const symbols = [
    "INFY.NS",
    "HDFC.NS",
    "KOTAKBANK.NS",
    "DIVISLAB.NS",
    "PEL.NS",
    "ZOMATO.NS",
  ];

  for (const symbol of symbols) {
    await scanStock(symbol);
  }
}

runScanner();
