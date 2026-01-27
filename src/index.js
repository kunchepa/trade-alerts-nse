import YahooFinance from "yahoo-finance2";
import { EMA, RSI, ATR } from "technicalindicators";

const yahooFinance = new YahooFinance();

/* ================= CONFIG ================= */
const SL_PCT = 0.7;
const TARGET_PCT = 1.4;
const MIN_CONFIDENCE = 60;
const COOLDOWN_MINUTES = 30;
const INTERVAL = "5m";
const LOOKBACK_DAYS = 5;
const CANDLE_STRENGTH_MIN = 0.00;

/* SYMBOLS same as before */
const SYMBOLS = [
  "ADANIENT.NS", "ADANIPORTS.NS", "APOLLOHOSP.NS", "ASIANPAINT.NS", "AXISBANK.NS",
  "BAJAJ-AUTO.NS", "BAJFINANCE.NS", "BAJAJFINSV.NS", "BPCL.NS", "BHARTIARTL.NS",
  "BRITANNIA.NS", "CIPLA.NS", "COALINDIA.NS", "DIVISLAB.NS", "DRREDDY.NS",
  "EICHERMOT.NS", "GRASIM.NS", "HCLTECH.NS", "HDFCBANK.NS", "HDFCLIFE.NS",
  "HEROMOTOCO.NS", "HINDALCO.NS", "HINDUNILVR.NS", "ICICIBANK.NS", "ITC.NS",
  "IOC.NS", "INDUSINDBK.NS", "INFY.NS", "JSWSTEEL.NS", "KOTAKBANK.NS",
  "LT.NS", "M&M.NS", "MARUTI.NS", "NESTLEIND.NS", "NTPC.NS",
  "ONGC.NS", "POWERGRID.NS", "RELIANCE.NS", "SBIN.NS", "SBILIFE.NS",
  "SHREECEM.NS", "SUNPHARMA.NS", "TATACONSUM.NS", "TMCV.NS", "TATASTEEL.NS",
  "TCS.NS", "TECHM.NS", "TITAN.NS", "ULTRACEMCO.NS", "UPL.NS", "WIPRO.NS",
  "ABB.NS", "ACC.NS", "AMBUJACEM.NS", "ASHOKLEY.NS", "BANDHANBNK.NS", "BEL.NS",
  "BHEL.NS", "BIOCON.NS", "CANBK.NS", "CHOLAFIN.NS", "DLF.NS", "GAIL.NS",
  "HAL.NS", "HAVELLS.NS", "ICICIPRULI.NS", "IDFCFIRSTB.NS", "IGL.NS",
  "IRCTC.NS", "JINDALSTEL.NS", "JSWENERGY.NS", "LICHSGFIN.NS", "MGL.NS",
  "MUTHOOTFIN.NS", "NAUKRI.NS", "PEL.NS", "PIDILITIND.NS", "PNB.NS",
  "POLYCAB.NS", "SAIL.NS", "SIEMENS.NS", "TORNTPHARM.NS", "TVSMOTOR.NS",
  "UNIONBANK.NS", "VEDL.NS"
];

/* CONFIDENCE same */
function calculateConfidence({ ema9, ema21, rsi }) {
  let score = 0;
  if (ema9 > ema21) score += 40;
  if (rsi > 55 && rsi < 72) score += 30;
  if (ema9 > ema21 && rsi > 50) score += 30;
  return Math.min(score, 100);
}

/* MAIN */
async function runScanner() {
  const now = new Date();
  const istDate = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  console.log(`🚀 Scanner started at UTC: ${now.toISOString()} | IST: ${istDate.toLocaleString('en-IN')}`);

  let processed = 0;
  const unixNow = Math.floor(Date.now() / 1000);
  const period1 = unixNow - LOOKBACK_DAYS * 24 * 60 * 60;
  const period2 = unixNow;

  for (const symbol of SYMBOLS) {
    processed++;
    let candles;
    try {
      const result = await yahooFinance.chart(symbol, {
        interval: INTERVAL,
        period1,
        period2,
      });
      candles = result?.quotes?.filter(c => c && c.close && c.high && c.low && c.open);
    } catch (err) {
      console.log(`⚠️ ${symbol} yahoo fetch failed: ${err.message}`);
      continue;
    }

    if (!candles || candles.length < 60) continue;

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    const ema9 = EMA.calculate({ period: 9, values: closes }).at(-1);
    const ema21 = EMA.calculate({ period: 21, values: closes }).at(-1);
    const ema50 = EMA.calculate({ period: 50, values: closes }).at(-1);
    const rsi = RSI.calculate({ period: 14, values: closes }).at(-1);
    const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes }).at(-1);

    if (!ema9 || !ema21 || !ema50 || !rsi || !atr) continue;

    const entry = closes.at(-1);
    const candle = candles.at(-1);
    const candleStrength = ((candle.close - candle.open) / candle.open) * 100;

    const emaBullish = ema9 > ema21;

    // Debug
    console.log(`${symbol} | EMA9:${ema9.toFixed(2)} > EMA21:${ema21.toFixed(2)} | RSI:${rsi.toFixed(2)} | Close:${entry.toFixed(2)} > EMA50:${ema50.toFixed(2)} | Candle:${candleStrength.toFixed(2)}% | ATR%:${(atr/entry*100).toFixed(2)} | EMA Bullish:${emaBullish}`);

    if (!emaBullish) {
      console.log(`${symbol} skipped: EMA9 not above EMA21`);
      continue;
    }
    if (rsi <= 50) {
      console.log(`${symbol} skipped: RSI <=50 (${rsi.toFixed(2)})`);
      continue;
    }
    // Relaxed: allow doji/flat bullish candle
    if (candleStrength < CANDLE_STRENGTH_MIN) {
      console.log(`${symbol} skipped: candle too weak (${candleStrength.toFixed(2)}%)`);
      continue;
    }
    // Comment out bearish check for now to allow doji
    // if (candle.close <= candle.open) {
    //   console.log(`${symbol} skipped: bearish/doji candle`);
    //   continue;
    // }
    if (entry < ema50) {
      console.log(`${symbol} skipped: below EMA50`);
      continue;
    }
    if (rsi > 72) {
      console.log(`${symbol} skipped: RSI >72 (${rsi.toFixed(2)})`);
      continue;
    }

    const hr = istDate.getHours();
    const min = istDate.getMinutes();
    if (hr < 9 || (hr === 9 && min < 15) || hr > 15 || (hr === 15 && min > 30)) {
      console.log(`${symbol} skipped: out of trading hours`);
      continue;
    }

    const atrPct = (atr / entry) * 100;
    if (atrPct > ATR_PCT_MAX) {
      console.log(`${symbol} skipped: ATR% ${atrPct.toFixed(2)} > ${ATR_PCT_MAX}`);
      continue;
    }

    const confidence = calculateConfidence({ ema9, ema21, rsi });
    if (confidence < MIN_CONFIDENCE) {
      console.log(`${symbol} skipped: confidence ${confidence} < ${MIN_CONFIDENCE}`);
      continue;
    }

    console.log(`✅ BUY FOUND ${symbol} | Confidence ${confidence} | RSI ${rsi.toFixed(2)} | ATR% ${atrPct.toFixed(2)} | Candle ${candleStrength.toFixed(2)}%`);
  }

  console.log(`🏁 Scanner completed. Symbols processed: ${processed}`);
}

await runScanner();
