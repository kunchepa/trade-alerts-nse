import yahooFinance from "yahoo-finance2";
import { EMA, ADX } from "technicalindicators";
import fetch from "node-fetch";

/* =========================
   CONFIG
========================= */

const INTERVAL = "5m";
const LOOKBACK_DAYS = 10;
const MAX_SIGNALS_PER_RUN = 4;
const MARKET_CLOSE_HOUR = 15;
const MARKET_CLOSE_MIN = 20;

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
   STATE (IN-MEMORY)
========================= */

let allCalls = [];   // {symbol, side, confidence}

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
    body: JSON.stringify({ chat_id: chatId, text: message })
  });
}

/* =========================
   MARKET TREND (NIFTY)
========================= */

async function getMarketTrend() {
  try {
    const data = await yahooFinance.historical("^NSEI", {
      period1: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      period2: new Date(),
      interval: "15m"
    });

    const closes = data.map(c => c.close);
    const ema20 = EMA.calculate({ period: 20, values: closes });

    return closes.at(-1) > ema20.at(-1)
      ? "BULLISH"
      : "BEARISH";
  } catch {
    return "SIDEWAYS";
  }
}

/* =========================
   UNIVERSE
========================= */

async function getDynamicUniverse() {
  try {
    const res = await yahooFinance.trendingSymbols("IN");
    return res.quotes
      .map(q => q.symbol)
      .filter(s => s.endsWith(".NS"))
      .slice(0, 20);
  } catch {
    return FALLBACK_SYMBOLS;
  }
}

/* =========================
   DATA
========================= */

async function getHistorical(symbol) {
  try {
    const from = new Date();
    from.setDate(from.getDate() - LOOKBACK_DAYS);

    const candles = await yahooFinance.historical(symbol, {
      period1: from,
      period2: new Date(),
      interval: INTERVAL
    });

    return candles?.length > 50 ? candles : null;
  } catch {
    return null;
  }
}

/* =========================
   SIGNAL LOGIC
========================= */

function checkSignal(symbol, candles, marketTrend) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const ema9 = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });
  const adx = ADX.calculate({
    high: highs, low: lows, close: closes, period: 14
  });

  const last = closes.length - 1;
  const price = closes[last];
  const trendUp = ema9.at(-1) > ema21.at(-1);
  const strongTrend = adx.at(-1)?.adx > 20;

  let confidencePoints = 0;
  if (trendUp) confidencePoints++;
  if (strongTrend) confidencePoints++;
  if (
    (trendUp && marketTrend === "BULLISH") ||
    (!trendUp && marketTrend === "BEARISH")
  ) confidencePoints++;

  const confidence = confidencePoints >= 3 ? "HIGH" : "MEDIUM";
  if (confidencePoints < 2) return null;

  const side = trendUp ? "BUY" : "SELL";
  const sl = side === "BUY"
    ? Math.min(...lows.slice(-10))
    : Math.max(...highs.slice(-10));

  const risk = Math.abs(price - sl);

  return {
    symbol,
    side,
    price,
    sl,
    t1: side === "BUY" ? price + risk : price - risk,
    t2: side === "BUY" ? price + risk * 2 : price - risk * 2,
    confidence
  };
}

/* =========================
   END-OF-DAY SUMMARY
========================= */

async function sendEODSummary(marketTrend) {
  if (allCalls.length === 0) return;

  const passed = allCalls.filter(c => c.confidence === "HIGH");
  const failed = allCalls.filter(c => c.confidence === "MEDIUM");

  let msg = `📊 END OF DAY SUMMARY\n\n`;
  msg += `Total Calls: ${allCalls.length}\n`;
  msg += `✅ PASSED: ${passed.length}\n`;
  msg += `❌ FAILED: ${failed.length}\n\n`;

  msg += `🟢 PASSED CALLS:\n`;
  passed.forEach(c => msg += `• ${c.symbol} – ${c.side}\n`);

  msg += `\n🟡 FAILED CALLS:\n`;
  failed.forEach(c => msg += `• ${c.symbol} – ${c.side}\n`);

  msg += `\n📈 Market Trend: NIFTY ${marketTrend}\n`;
  msg += `🤖 Scanner Status: STABLE`;

  await sendTelegram(msg);
}

/* =========================
   MAIN
========================= */

async function runScanner() {
  const now = new Date();
  const marketTrend = await getMarketTrend();
  const symbols = await getDynamicUniverse();

  let signals = 0;

  for (const symbol of symbols) {
    if (signals >= MAX_SIGNALS_PER_RUN) break;

    const candles = await getHistorical(symbol);
    if (!candles) continue;

    const trade = checkSignal(symbol, candles, marketTrend);
    if (!trade) continue;

    signals++;
    allCalls.push({ symbol: trade.symbol, side: trade.side, confidence: trade.confidence });

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
