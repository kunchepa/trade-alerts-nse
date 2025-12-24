import yahooFinance from "yahoo-finance2";
import { EMA, RSI, ADX } from "technicalindicators";
import fetch from "node-fetch";
import { google } from "googleapis";

/* =========================
   CONFIG
========================= */

const INTERVAL = "5m";
const LOOKBACK_DAYS = 10;
const MIN_VOLUME_SPIKE = 1.2;
const COOLDOWN_HOURS = 6;
const MAX_SIGNALS_PER_RUN = 4;

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
   GOOGLE SHEETS
========================= */

async function appendSheet(row) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: "Alerts!A1",
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

/* =========================
   DATA FETCH
========================= */

async function getDynamicUniverse() {
  try {
    const res = await yahooFinance.trendingSymbols("IN");
    const symbols = res?.quotes?.map(q => q.symbol + ".NS") || [];
    if (symbols.length > 0) return symbols;
  } catch (e) {
    console.log("⚠️ trendingSymbols failed – using fallback universe");
  }
  return FALLBACK_SYMBOLS;
}

async function getHistorical(symbol) {
  try {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - LOOKBACK_DAYS);

    const candles = await yahooFinance.historical(symbol, {
      period1: from,
      period2: to,
      interval: INTERVAL
    });

    if (!candles || candles.length < 60) return null;
    return candles;
  } catch (e) {
    console.log(`❌ Historical failed for ${symbol}`);
    return null;
  }
}

/* =========================
   STRATEGY LOGIC
========================= */

function isMomentum(candles) {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const ema9 = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });
  const rsi = RSI.calculate({ period: 14, values: closes });

  const last = closes.length - 1;
  const volAvg = volumes.slice(-20).reduce((a,b)=>a+b,0)/20;

  let score = 0;
  if (ema9[last-8] > ema21[last-8]) score++;
  if (rsi[rsi.length-1] > 50) score++;
  if (volumes[last] > volAvg * MIN_VOLUME_SPIKE) score++;

  return score >= 1; // BALANCED → ACTIVE
}

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

  const last = closes.length - 1;
  const price = closes[last];
  const trendUp = ema9[last-8] > ema21[last-8];
  const strongTrend = adx[adx.length-1]?.adx > 18;

  if (!strongTrend) return null;

  if (trendUp && price > ema9[last-8]) {
    const sl = Math.min(...lows.slice(-10));
    return buildTrade("BUY", price, sl, symbol);
  }

  if (!trendUp && price < ema9[last-8]) {
    const sl = Math.max(...highs.slice(-10));
    return buildTrade("SELL", price, sl, symbol);
  }

  return null;
}

function buildTrade(side, price, sl, symbol) {
  const risk = Math.abs(price - sl);
  return {
    symbol,
    side,
    price: price.toFixed(2),
    sl: sl.toFixed(2),
    t1: (side==="BUY"?price+risk:price-risk).toFixed(2),
    t2: (side==="BUY"?price+2*risk:price-2*risk).toFixed(2),
    reason: "EMA trend + ADX strength",
    time: new Date().toLocaleTimeString("en-IN")
  };
}

/* =========================
   MAIN SCANNER
========================= */

async function runScanner() {
  console.log("🚀 Scanner started");

  const symbols = await getDynamicUniverse();
  console.log(`📊 Symbols fetched: ${symbols.length}`);

  let signals = 0;

  for (const symbol of symbols) {
    if (signals >= MAX_SIGNALS_PER_RUN) break;

    const candles = await getHistorical(symbol);
    if (!candles) continue;

    const momentum = isMomentum(candles);
    console.log(`🔍 ${symbol} momentum = ${momentum}`);
    if (!momentum) continue;

    const trade = checkSignal(symbol, candles);
    console.log(`📈 ${symbol} signal = ${trade ? trade.side : "NO"}`);

    if (!trade) continue;

    signals++;

    const msg = `
📢 ${trade.side} ${trade.symbol}
⏰ ${trade.time}
💰 CMP: ${trade.price}
🎯 T1: ${trade.t1}
🎯 T2: ${trade.t2}
🛑 SL: ${trade.sl}
📌 ${trade.reason}
`;

    await sendTelegram(msg);
    await appendSheet([
      trade.time, trade.symbol, trade.side,
      trade.price, trade.sl, trade.t1, trade.t2, trade.reason
    ]);

    console.log("✅ TRADE SENT:", trade.symbol);
  }

  console.log(`🏁 Scanner completed | Signals: ${signals}`);
}

/* =========================
   START
========================= */

runScanner().catch(err => {
  console.error("🔥 Scanner crashed", err);
  process.exit(1);
});
