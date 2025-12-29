import fetch from "node-fetch";
import { EMA, ADX } from "technicalindicators";

/* =========================
   CONFIG
========================= */

const INTERVAL = "5min";
const MAX_SIGNALS_PER_RUN = 4;
const API_KEY = process.env.ALPHA_VANTAGE_KEY;

if (!API_KEY) {
  throw new Error("❌ ALPHA_VANTAGE_KEY is missing in GitHub Secrets");
}

/* =========================
   NSE STOCK UNIVERSE
   (kept small for free API)
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

/* =========================
   TELEGRAM
========================= */

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message
    })
  });
}

/* =========================
   FETCH INTRADAY CANDLES
========================= */

async function getCandles(symbol) {
  try {
    const url =
      `https://www.alphavantage.co/query?` +
      `function=TIME_SERIES_INTRADAY` +
      `&symbol=${symbol}.NSE` +
      `&interval=${INTERVAL}` +
      `&outputsize=compact` +
      `&apikey=${API_KEY}`;

    const res = await fetch(url);
    const data = await res.json();

    const key = `Time Series (${INTERVAL})`;
    if (!data[key]) {
      console.log(`⏭ ${symbol} skipped: no candle data`);
      return null;
    }

    const candles = Object.entries(data[key])
      .map(([time, v]) => ({
        time,
        open: +v["1. open"],
        high: +v["2. high"],
        low: +v["3. low"],
        close: +v["4. close"]
      }))
      .reverse();

    return candles.length >= 50 ? candles : null;
  } catch (err) {
    console.log(`❌ Error fetching ${symbol}: ${err.message}`);
    return null;
  }
}

/* =========================
   SIGNAL LOGIC
========================= */

function checkSignal(symbol, candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const ema9 = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });
  const adx = ADX.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14
  });

  if (!ema9.length || !ema21.length || !adx.length) {
    console.log(`⏭ ${symbol} skipped: indicator not ready`);
    return null;
  }

  const price = closes.at(-1);
  const trendUp = ema9.at(-1) > ema21.at(-1);
  const strongTrend = adx.at(-1).adx > 20;

  if (!strongTrend) {
    console.log(`⏭ ${symbol} skipped: weak trend (ADX < 20)`);
    return null;
  }

  const side = trendUp ? "BUY" : "SELL";

  const sl = trendUp
    ? Math.min(...lows.slice(-10))
    : Math.max(...highs.slice(-10));

  const risk = Math.abs(price - sl);
  if (risk === 0) {
    console.log(`⏭ ${symbol} skipped: zero risk`);
    return null;
  }

  return {
    symbol,
    side,
    price,
    sl,
    t1: trendUp ? price + risk : price - risk,
    t2: trendUp ? price + risk * 2 : price - risk * 2
  };
}

/* =========================
   MAIN SCANNER
========================= */

async function runScanner() {
  let signals = 0;

  for (const symbol of SYMBOLS) {
    if (signals >= MAX_SIGNALS_PER_RUN) break;

    const candles = await getCandles(symbol);
    if (!candles) continue;

    const trade = checkSignal(symbol, candles);
    if (!trade) continue;

    signals++;

    const message = `
📢 ${trade.side} ${trade.symbol}
⏰ ${new Date().toLocaleTimeString("en-IN")}

💰 Entry: ${trade.price.toFixed(2)}
🛑 SL: ${trade.sl.toFixed(2)}

🎯 Target 1: ${trade.t1.toFixed(2)}
🎯 Target 2: ${trade.t2.toFixed(2)}

📊 R:R = 1 : 2
Confidence: HIGH
    `;

    await sendTelegram(message);
  }

  console.log(`✅ Scan completed. Trades found: ${signals}`);
}

runScanner();
