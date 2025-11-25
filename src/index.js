import yahooFinance from "yahoo-finance2";
import axios from "axios";

// ================================
// CONFIG (Editable)
// ================================
const symbols = [
  "RELIANCE",
  "HDFCBANK",
  "ICICIBANK",
  "INFY",
  "TCS",
  "AXISBANK",
  "SBIN",
  "KOTAKBANK"
];

// Telegram notification
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(msg) {
  try {
    const url =
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: msg,
      parse_mode: "HTML"
    });
  } catch (err) {
    console.log("Telegram error:", err.message);
  }
}

// ================================
// FETCH QUOTE
// ================================
async function getQuote(symbol) {
  try {
    const res = await yahooFinance.quote(symbol + ".NS");
    return res;
  } catch (err) {
    console.log(`❌ Quote failed for ${symbol}: ${err.message}`);
    return null;
  }
}

// ================================
// FETCH CHART (for EMA / trend logic)
// ================================
async function getChart(symbol) {
  try {
    const data = await yahooFinance.chart(symbol + ".NS", {
      period1: "1d",
      interval: "5m"
    });
    return data;
  } catch (err) {
    console.log(`❌ Chart failed for ${symbol}: ${err.message}`);
    return null;
  }
}

// ================================
// SIMPLE STRATEGY (Customisable)
// ================================
function checkBuySellConditions(chart) {
  if (!chart || !chart.quotes || chart.quotes.length < 20) return null;

  const prices = chart.quotes.map(q => q.close);

  const sma20 = prices.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const last = prices[prices.length - 1];

  if (last > sma20) return "BUY";
  if (last < sma20) return "SELL";

  return null;
}

// ================================
// MAIN SCAN LOOP
// ================================
async function runScanner() {
  console.log("🚀 Starting Trade Alerts Scanner...");

  for (const symbol of symbols) {
    console.log(`📡 Fetching → ${symbol}`);

    const quote = await getQuote(symbol);
    if (!quote) continue;

    const chart = await getChart(symbol);
    if (!chart) continue;

    const signal = checkBuySellConditions(chart);
    if (!signal) continue;

    const price = quote.regularMarketPrice;

    const msg =
      `📈 <b>${signal} SIGNAL</b>\n` +
      `Symbol: <b>${symbol}</b>\n` +
      `Price: <b>${price}</b>\n` +
      `Time: ${new Date().toLocaleTimeString()}`;

    console.log(msg);
    await sendTelegram(msg);
  }

  console.log("✅ Scan complete.");
}

runScanner();
