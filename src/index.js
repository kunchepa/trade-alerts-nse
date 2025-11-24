// ========================================
//      TRADE ALERT SYSTEM – LIVE SIGNALS
// ========================================

import fetch from "node-fetch";
import technicalIndicators from "technicalindicators";
import { google } from "googleapis";

// ---------- CONFIG ----------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const GOOGLE_SERVICE_ACCOUNT_JSON = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const SHEET_NAME = "Alerts";

// ---------- SYMBOL LIST (20 for speed) ----------
const symbols = [
  "RELIANCE", "INFY", "TCS", "HDFCBANK", "ICICIBANK", "LT", "SBIN", "HINDUNILVR",
  "BHARTIARTL", "ITC", "KOTAKBANK", "ASIANPAINT", "AXISBANK", "MARUTI", "SUNPHARMA",
  "BAJFINANCE", "HCLTECH", "WIPRO", "NTPC", "TECHM"
];

// ----------------------------------------------
// FETCH NSE DATA (LIVE QUOTES)
// ----------------------------------------------
async function fetchQuote(symbol) {
  try {
    const url = `https://www.nseindia.com/api/quote-equity?symbol=${symbol}`;
    
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "*/*"
      }
    });

    return await response.json();
  } catch (err) {
    console.error(`❌ Error fetching quote for ${symbol}`, err);
    return null;
  }
}

// ----------------------------------------------
// FETCH HISTORICAL DATA FOR INDICATORS
// ----------------------------------------------
async function fetchHistory(symbol) {
  try {
    const url = `https://www.nseindia.com/api/chart-databyindex?index=${symbol}`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const data = await response.json();

    const prices = data.grapthData.map((p) => ({
      close: p[1],
      volume: p[2]
    }));

    return prices.slice(-200);
  } catch (e) {
    console.error(`❌ History fetch failed: ${symbol}`);
    return null;
  }
}

// ----------------------------------------------
// CALCULATE INDICATORS
// ----------------------------------------------
function calcIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const ema20 = technicalIndicators.EMA.calculate({ period: 20, values: closes });
  const ema50 = technicalIndicators.EMA.calculate({ period: 50, values: closes });
  const ema200 = technicalIndicators.EMA.calculate({ period: 200, values: closes });

  const adx = technicalIndicators.ADX.calculate({
    close: closes,
    high: closes,
    low: closes,
    period: 14
  });

  const atr = technicalIndicators.ATR.calculate({
    high: closes,
    low: closes,
    close: closes,
    period: 14
  });

  const vol20dma = technicalIndicators.SMA.calculate({ period: 20, values: volumes });

  return {
    ema20: ema20.at(-1),
    ema50: ema50.at(-1),
    ema200: ema200.at(-1),
    adx: adx.at(-1)?.adx,
    atr: atr.at(-1),
    volume: volumes.at(-1),
    vol20dma: vol20dma.at(-1)
  };
}

// ----------------------------------------------
// SIGNAL LOGIC  (BUY / SELL)
// ----------------------------------------------
function generateSignal(symbol, price, ind) {
  if (!ind.ema20 || !ind.ema50 || !ind.ema200) return null;

  // BUY Condition
  if (price > ind.ema20 && ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200 && ind.adx > 25) {
    return {
      direction: "BUY",
      reason: "Strong Uptrend + ADX",
    };
  }

  // SELL Condition
  if (price < ind.ema20 && ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200 && ind.adx > 25) {
    return {
      direction: "SELL",
      reason: "Strong Downtrend + ADX",
    };
  }

  return null;
}

// ----------------------------------------------
// SEND ALERT TO TELEGRAM
// ----------------------------------------------
async function sendTelegram(message) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML"
      })
    });
  } catch (e) {
    console.error("❌ Telegram error:", e);
  }
}

// ----------------------------------------------
// WRITE TO GOOGLE SHEETS
// ----------------------------------------------
async function writeToSheet(row) {
  const auth = new google.auth.JWT(
    GOOGLE_SERVICE_ACCOUNT_JSON.client_email,
    null,
    GOOGLE_SERVICE_ACCOUNT_JSON.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );

  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:Z`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [row] }
  });
}

// ----------------------------------------------
// MAIN EXECUTION LOOP
// ----------------------------------------------
async function run() {
  console.log("🚀 Trade Signal Engine Running...");

  for (const symbol of symbols) {
    console.log(`🔍 Checking ${symbol}...`);

    const quote = await fetchQuote(symbol);
    if (!quote?.priceInfo?.lastPrice) continue;

    const price = quote.priceInfo.lastPrice;
    const history = await fetchHistory(symbol);
    if (!history) continue;

    const indicators = calcIndicators(history);
    const signal = generateSignal(symbol, price, indicators);

    if (!signal) continue;

    // Format Telegram Message
    const msg = `
📢 <b>TRADE SIGNAL</b>
🔹 <b>${symbol}</b>
🔹 Direction: <b>${signal.direction}</b>
🔹 Price: ₹${price}
🔹 Reason: ${signal.reason}

📊 Indicators
EMA20: ${indicators.ema20}
EMA50: ${indicators.ema50}
EMA200: ${indicators.ema200}
ADX: ${indicators.adx}
Volume: ${indicators.volume}
20DMA Vol: ${indicators.vol20dma}
    `;

    await sendTelegram(msg);

    // Write to Sheet
    const row = [
      new Date().toLocaleString("en-IN"),
      symbol,
      signal.direction,
      price,
      signal.reason,
      indicators.ema20,
      indicators.ema50,
      indicators.ema200,
      indicators.adx,
      indicators.atr,
      indicators.volume,
      indicators.vol20dma,
      "" // winrate placeholder
    ];

    await writeToSheet(row);

    console.log(`✅ Signal sent for ${symbol}`);
  }
}

run();
