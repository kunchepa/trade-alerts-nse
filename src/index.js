/**
 * trade-alerts-nse
 * FULL WORKING CODE
 * Compatible with GitHub Actions + Cron
 */

import yahooFinance from "yahoo-finance2";
import { EMA, RSI } from "technicalindicators";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";

/* =========================
   ENV VALIDATION
========================= */

const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "SPREADSHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "ALPHA_VANTAGE_KEY" // present, not crashing
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`❌ Missing env variable: ${key}`);
  }
}

console.log("✅ All environment variables loaded");

/* =========================
   CONFIG
========================= */

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

const INTERVAL = "5m";
const RANGE_DAYS = 5;

/* =========================
   HELPERS
========================= */

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown"
    })
  });
}

async function logToSheet(row) {
  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();

  const sheet = doc.sheetsByTitle["Alerts"];
  await sheet.addRow(row);
}

/* =========================
   INDICATORS
========================= */

function calculateIndicators(closes) {
  const ema9 = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });
  const rsi = RSI.calculate({ period: 14, values: closes });

  return {
    ema9: ema9.at(-1),
    ema21: ema21.at(-1),
    rsi: rsi.at(-1)
  };
}

/* =========================
   MAIN SCANNER
========================= */

yahooFinance.suppressNotices(["ripHistorical", "validation"]);

async function runScanner() {
  for (const symbol of SYMBOLS) {
    try {
      console.log(`🔍 Scanning ${symbol}`);

      const candles = await yahooFinance.historical(symbol, {
        period1: `${RANGE_DAYS}d`,
        interval: INTERVAL
      });

      if (!candles || candles.length < 30) {
        console.log(`⚠️ Not enough data for ${symbol}`);
        continue;
      }

      const closes = candles.map(c => c.close);
      const lastClose = closes.at(-1);

      const { ema9, ema21, rsi } = calculateIndicators(closes);

      /* =========================
         STRATEGY (SAFE & SIMPLE)
      ========================= */

      const buySignal =
        ema9 > ema21 &&
        rsi > 50 &&
        rsi < 70;

      if (!buySignal) {
        console.log(`⏭️ No signal for ${symbol}`);
        continue;
      }

      const timeIST = new Date().toLocaleString("en-IN");

      const message = `
📈 *BUY SIGNAL*
━━━━━━━━━━━━
Stock: *${symbol}*
Price: *₹${lastClose.toFixed(2)}*

EMA 9: ${ema9.toFixed(2)}
EMA 21: ${ema21.toFixed(2)}
RSI: ${rsi.toFixed(2)}

🕒 ${timeIST}
      `;

      await sendTelegram(message);

      await logToSheet({
        Symbol: symbol,
        Price: lastClose,
        EMA9: ema9,
        EMA21: ema21,
        RSI: rsi,
        Time: timeIST
      });

      console.log(`✅ Alert sent for ${symbol}`);

    } catch (err) {
      console.error(`❌ Error scanning ${symbol}:`, err.message);
    }
  }
}

/* =========================
   START
========================= */

console.log("🚀 Trade Alerts Scanner Started");
await runScanner();
console.log("✅ Scan Completed");
