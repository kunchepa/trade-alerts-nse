import YahooFinance from "yahoo-finance2";
import { EMA, RSI } from "technicalindicators";

const yahooFinance = new YahooFinance();

const SL_PCT = 0.7;
const TARGET_PCT = 1.4;
const MIN_CONFIDENCE = 60;
const COOLDOWN_MINUTES = 30;
const INTERVAL = "5m";
const LOOKBACK_DAYS = 5;

/* FULL NIFTY 100 */
const SYMBOLS = [
"ADANIENT.NS","ADANIPORTS.NS","APOLLOHOSP.NS","ASIANPAINT.NS","AXISBANK.NS",
"BAJAJ-AUTO.NS","BAJFINANCE.NS","BAJAJFINSV.NS","BPCL.NS","BHARTIARTL.NS",
"BRITANNIA.NS","CIPLA.NS","COALINDIA.NS","DIVISLAB.NS","DRREDDY.NS",
"EICHERMOT.NS","GRASIM.NS","HCLTECH.NS","HDFCBANK.NS","HDFCLIFE.NS",
"HEROMOTOCO.NS","HINDALCO.NS","HINDUNILVR.NS","ICICIBANK.NS","ITC.NS",
"IOC.NS","INDUSINDBK.NS","INFY.NS","JSWSTEEL.NS","KOTAKBANK.NS",
"LT.NS","M&M.NS","MARUTI.NS","NESTLEIND.NS","NTPC.NS",
"ONGC.NS","POWERGRID.NS","RELIANCE.NS","SBIN.NS","SBILIFE.NS",
"SHREECEM.NS","SUNPHARMA.NS","TATACONSUM.NS","TMCV.NS","TATASTEEL.NS",
"TCS.NS","TECHM.NS","TITAN.NS","ULTRACEMCO.NS","UPL.NS","WIPRO.NS",

"ABB.NS","ACC.NS","AMBUJACEM.NS","ASHOKLEY.NS","BANDHANBNK.NS","BEL.NS",
"BHEL.NS","BIOCON.NS","CANBK.NS","CHOLAFIN.NS","DLF.NS","GAIL.NS",
"HAL.NS","HAVELLS.NS","ICICIPRULI.NS","IDFCFIRSTB.NS","IGL.NS",
"IRCTC.NS","JINDALSTEL.NS","JSWENERGY.NS","LICHSGFIN.NS","MGL.NS",
"MUTHOOTFIN.NS","NAUKRI.NS","PEL.NS","PIDILITIND.NS","PNB.NS",
"POLYCAB.NS","SAIL.NS","SIEMENS.NS","TORNTPHARM.NS","TVSMOTOR.NS",
"UNIONBANK.NS","VEDL.NS","ETERNAL.NS"
];

const alertedStocks = new Map();

function calculateConfidence({ ema9, ema21, rsi }) {
  let score = 0;
  if (ema9 > ema21) score += 40;
  if (rsi > 55 && rsi < 70) score += 30;
  if (ema9 > ema21 && rsi > 50) score += 30;
  return Math.min(score, 100);
}

async function runScanner() {

  console.log("🚀 Scanner started");

  let processed = 0;

  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - LOOKBACK_DAYS * 24 * 60 * 60;

  for (const symbol of SYMBOLS) {

    processed++;

    let candles;

    try {
      const result = await yahooFinance.chart(symbol,{
        interval: INTERVAL,
        period1,
        period2
      });

      candles = result?.quotes;

    } catch (e) {
      console.log(`⚠️ ${symbol} yahoo failed`);
      continue;
    }

    if (!candles || candles.length < 50) continue;

    const closes = candles.map(c=>c.close).filter(Boolean);
    if (closes.length < 50) continue;

    const ema9 = EMA.calculate({period:9,values:closes}).at(-1);
    const ema21 = EMA.calculate({period:21,values:closes}).at(-1);
    const ema50 = EMA.calculate({period:50,values:closes}).at(-1);

    const prev9 = EMA.calculate({period:9,values:closes.slice(0,-1)}).at(-1);
    const prev21 = EMA.calculate({period:21,values:closes.slice(0,-1)}).at(-1);

    const rsi = RSI.calculate({period:14,values:closes}).at(-1);

    if(!ema9||!ema21||!ema50||!prev9||!prev21||!rsi) continue;

    const crossover = prev9<=prev21 && ema9>ema21;
    if(!crossover||rsi<=50) continue;

    const entry = closes.at(-1);

    const candle = candles.at(-1);
    const strength = ((candle.close-candle.open)/candle.open)*100;
    if(strength<0.15) continue;

    if(entry<ema50) continue;
    if(rsi>68) continue;

    const recentHigh=Math.max(...closes.slice(-14));
    const recentLow=Math.min(...closes.slice(-14));
    const atr=((recentHigh-recentLow)/entry)*100;
    if(atr>4) continue;

    const confidence=calculateConfidence({ema9,ema21,rsi});
    if(confidence<MIN_CONFIDENCE) continue;

    console.log(`✅ BUY FOUND ${symbol}`);

  }

  console.log(`🏁 Scanner completed. Symbols processed: ${processed}`);
}

await runScanner();
