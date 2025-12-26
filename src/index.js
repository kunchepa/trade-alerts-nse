import yahooFinance from "yahoo-finance2";
import { EMA, ADX } from "technicalindicators";
import fetch from "node-fetch";

/* =========================
   CONFIG
========================= */

const INTERVAL = "5m";
const RANGE = "5d";
const MAX_SIGNALS_PER_RUN = 4;

const MARKET_CLOSE_HOUR = 15;
const MARKET_CLOSE_MIN = 20;

/* =========================
   FALLBACK UNIVERSE
========================= */

const FALLBACK_SYMBOLS = [
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
   STATE (PER DAY)
========================= */

let allCalls = [];   // { symbol, side, confidence }

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
   MARKET TREND (NIFTY)
========================= */

async function getMarketTrend() {
  try {
    const chart = await yahooFinance.chart("^NSEI", {
      interval: "15m",
      range: "5d"
    });

    const closes = chart.quotes.map(q => q.close);
    const ema20 = EMA.calculate({ period: 20, values: closes });

    return closes.at(-1) > ema20.at(-1)
      ? "BULLISH"
      : "BEARISH";
  } catch {
    return "SIDEWAYS";
  }
}

/* =========================
   SYMBOL UNIVERSE
========================= */

async function getUniverse() {
  try {
    const res = await yahooFinance.trendingSymbols("IN");
    return res.quotes
      .map(q => q.symbol)
      .filter(s => s.endsWith(".NS"))
      .slice(0, 25);
  } catch {
    return FALLBACK_SYMBOLS;
  }
}

/* =========================
   CANDLES
========================= */

async function getCandles(symbol) {
  try {
    const chart = await yahooFinance.chart(symbol, {
      interval: INTERVAL,
      range: RANGE
    });

    return chart.quotes && chart.quotes.length > 60
      ? chart.quotes
      : null;
  } catch {
    return null;
  }
}

/* =========================
   SIGNAL LOGIC
========================= */

function checkSignal(symbol, candles, marketTrend) {
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);

  const ema9  = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });
  const adx   = ADX.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14
  });

  const price = closes.at(-1);
  const trendUp = ema9.at(-1) > ema21.at(-1);
  const strongTrend = adx.at(-1)?.adx > 18;

  let score = 0;
  if (trendUp) score++;
  if (strongTrend) score++;
  if (
    (trendUp && marketTrend === "BULLISH") ||
    (!trendUp && marketTrend === "BEARISH")
  ) score++;

  if (score < 2) return null;

  const confidence = score === 3 ? "HIGH" : "MEDIUM";
  const side = trendUp ? "BUY" : "SELL";

  const sl = side === "BUY"
    ? Math.min(...lows.slice(-10))
    : Math.max(...highs.slice(-10));

  const risk = Math.abs(price - sl);
  if (risk === 0) return null;

  return {
    symbol,
    side,
    confidence,
    price,
    sl,
    t1: side === "BUY" ? price + risk : price - risk,
    t2: side === "BUY" ? price + risk * 2 : price - risk * 2
  };
}

/* =========================
   END OF DAY SUMMARY
========================= */

async function sendEODSummary(marketTrend) {
  if (allCalls.length === 0) return;

  const high = allCalls.filter(c => c.confidence === "HIGH");
  const medium = allCalls.filter(c => c.confidence === "MEDIUM");

  let msg = `📊 END OF DAY SUMMARY\n\n`;
  msg += `Total Calls: ${allCalls.length}\n`;
  msg += `✅ High Confidence: ${high.length}\n`;
  msg += `⚠️ Medium Confidence: ${medium.length}\n\n`;

  if (high.length) {
    msg += `🟢 HIGH CONFIDENCE\n`;
    high.forEach(c => msg += `• ${c.symbol} (${c.side})\n`);
  }

  if (medium.length) {
    msg += `\n🟡 MEDIUM CONFIDENCE\n`;
    medium.forEach(c => msg += `• ${c.symbol} (${c.side})\n`);
  }

  msg += `\n📈 NIFTY Trend: ${marketTrend}`;
  await sendTelegram(msg);
}

/* =========================
   MAIN
========================= */

async function runScanner() {
  const now = new Date();
  const marketTrend = await getMarketTrend();
  const symbols = await getUniverse();

  let signals = 0;

  for (const symbol of symbols) {
    if (signals >= MAX_SIGNALS_PER_RUN) break;

    const candles = await getCandles(symbol);
    if (!candles) continue;

    const trade = checkSignal(symbol, candles, marketTrend);
    if (!trade) continue;

    signals++;
    allCalls.push({
      symbol: trade.symbol,
      side: trade.side,
      confidence: trade.confidence
    });

    const msg = `
📢 ${trade.side} ${trade.symbol}
⏰ ${new Date().toLocaleTimeString("en-IN")}

💰 Entry: ${trade.price.toFixed(2)}
🛑 SL: ${trade.sl.toFixed(2)}

🎯 T1: ${trade.t1.toFixed(2)}
🎯 T2: ${trade.t2.toFixed(2)}

📊 R:R = 1 : 2
📈 Market: NIFTY ${marketTrend}
${trade.confidence === "HIGH" ? "✅" : "⚠️"} Confidence: ${trade.confidence}
    `;

    await sendTelegram(msg);
  }

  if (
    now.getHours() === MARKET_CLOSE_HOUR &&
    now.getMinutes() >= MARKET_CLOSE_MIN
  ) {
    await sendEODSummary(marketTrend);
  }
}

runScanner();
