/**
 * NSE EMA Scanner – BUY ONLY VERSION (SELL signals removed)
 * Intraday 5m, EMA50, VWAP, Full Nifty 100 Symbols (Feb 2026)
 */
import fetch from "node-fetch";
import { EMA, RSI } from "technicalindicators";
import { GoogleSpreadsheet } from "google-spreadsheet";
import YahooFinance from "yahoo-finance2";

const yahoo = new YahooFinance({
  suppressNotices: ['ripHistorical']
});

/* ================= CONFIG ================= */
const SL_PCT = 0.7;
const TARGET_PCT = 1.8;
const MIN_CONFIDENCE = 70;
const DELAY_MS = 3000;
const COOLDOWN_MINUTES = 30;
const INTERVAL = "5m";

/* ================= SYMBOLS - Full Nifty 100 ================= */
const SYMBOLS = [
  "RELIANCE.NS", "HDFCBANK.NS", "BHARTIARTL.NS", "TCS.NS", "SBIN.NS",
  "ICICIBANK.NS", "INFY.NS", "ITC.NS", "HINDUNILVR.NS", "LT.NS",
  "BAJFINANCE.NS", "KOTAKBANK.NS", "AXISBANK.NS", "SUNPHARMA.NS", "MARUTI.NS",
  "M&M.NS", "ULTRACEMCO.NS", "NTPC.NS", "ONGC.NS", "POWERGRID.NS",
  "TITAN.NS", "ADANIPORTS.NS", "ADANIENT.NS", "BAJAJFINSV.NS", "INDUSINDBK.NS",
  "TECHM.NS", "HCLTECH.NS", "ASIANPAINT.NS", "NESTLEIND.NS", "JSWSTEEL.NS",
  "COALINDIA.NS", "TATAMOTORS.NS", "BAJAJ-AUTO.NS", "TATASTEEL.NS", "WIPRO.NS",
  "ADANIGREEN.NS", "HDFCLIFE.NS", "SBILIFE.NS", "HEROMOTOCO.NS", "DRREDDY.NS",
  "CIPLA.NS", "APOLLOHOSP.NS", "DIVISLAB.NS", "BRITANNIA.NS", "EICHERMOT.NS",
  "GRASIM.NS", "BPCL.NS", "IOC.NS", "TATACONSUM.NS", "UPL.NS",
  "HINDALCO.NS", "SHREECEM.NS", "PIDILITIND.NS", "DABUR.NS", "BOSCHLTD.NS",
  "TVSMOTOR.NS", "SIEMENS.NS", "HAL.NS", "BEL.NS", "DLF.NS",
  "INDIGO.NS", "ZOMATO.NS", "IRCTC.NS", "NAUKRI.NS", "LTIM.NS",
  "GODREJCP.NS", "MUTHOOTFIN.NS", "CHOLAFIN.NS", "POLYCAB.NS", "SRF.NS",
  "BAJAJHLDNG.NS", "CANBK.NS", "PNB.NS", "UNIONBANK.NS", "BANKBARODA.NS",
  "IGL.NS", "MGL.NS", "TORNTPHARM.NS", "JSWENERGY.NS", "RECLTD.NS",
  "PFC.NS", "MAXHEALTH.NS", "FORTIS.NS", "BIOCON.NS", "LUPIN.NS",
  "ABB.NS", "AMBUJACEM.NS", "ACC.NS", "VEDL.NS", "TATAPOWER.NS",
  "GAIL.NS", "PAYTM.NS", "TRENT.NS", "SHRIRAMFIN.NS", "MOTHERSON.NS",
  "BANDHANBNK.NS", "IDFCFIRSTB.NS", "JINDALSTEL.NS"
];

/* ================= ENV CHECK ================= */
const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "SPREADSHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON"
];
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`CRITICAL: Missing env ${k}`);
    process.exit(1);
  }
}
console.log("✅ All env variables loaded");

/* ================= HELPERS ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isMarketOpenIST() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours();
  const m = ist.getMinutes();
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  return (h > 8 || (h === 8 && m >= 30)) && (h < 15 || (h === 15 && m <= 30));
}

async function sendTelegram(msg) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: msg, parse_mode: "Markdown" })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("Telegram failed:", res.status, errText);
    } else {
      console.log("Telegram sent OK");
    }
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

async function logToSheet(row) {
  try {
    console.log("[SHEET] Logging row for:", row.Symbol);
    const spreadsheetId = process.env.SPREADSHEET_ID;
    let auth = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const doc = new GoogleSpreadsheet(spreadsheetId);
    await doc.useServiceAccountAuth(auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow(row);
    console.log(`[SHEET] SUCCESS: Added ${row.Symbol}`);
  } catch (e) {
    console.error("[SHEET] FAIL:", e.message);
  }
}

/* ================= DATA FETCH - Intraday ================= */
async function fetchIntradayData(symbol) {
  try {
    const plain = symbol.replace('.NS', '');
    console.log(`Fetching intraday 5m for ${plain}`);
    
    const queryOptions = {
      period1: Math.floor((Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000),
      period2: Math.floor(Date.now() / 1000),
      interval: INTERVAL,
      includePrePost: false
    };
    
    const result = await yahoo.chart(symbol, queryOptions);
    if (!result || !result.quotes || result.quotes.length < 50) {
      console.log(`Insufficient data for ${plain} (${result?.quotes?.length || 0})`);
      return null;
    }
    
    console.log(`Got ${result.quotes.length} bars for ${plain}`);
    return result.quotes;
  } catch (e) {
    console.error(`Fetch fail ${symbol}: ${e.message}`);
    return null;
  }
}

/* ================= INDICATORS ================= */
function calculateIndicators(bars) {
  if (bars.length < 50) return null;
  
  const closes = bars.map(b => b.close).filter(v => !isNaN(v));
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume || 0);
  
  const ema9 = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  
  const rsi = RSI.calculate({ period: 14, values: closes });
  
  let cumTPV = 0;
  let cumVol = 0;
  const vwapValues = [];
  for (let i = 0; i < bars.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumTPV += tp * volumes[i];
    cumVol += volumes[i];
    vwapValues.push(cumVol > 0 ? cumTPV / cumVol : closes[i]);
  }
  
  return {
    ema9: ema9[ema9.length - 1],
    ema21: ema21[ema21.length - 1],
    ema50: ema50[ema50.length - 1],
    prevEma9: ema9[ema9.length - 2],
    prevEma21: ema21[ema21.length - 2],
    rsi: rsi[rsi.length - 1],
    vwap: vwapValues[vwapValues.length - 1],
    currentPrice: closes[closes.length - 1],
    currentVolume: volumes[volumes.length - 1]
  };
}

/* ================= CONFIDENCE (BUY only) ================= */
function calculateConfidence(ind) {
  let score = 0;
  if (ind.ema9 > ind.ema21) score += 30;
  if (ind.ema21 > ind.ema50) score += 20;
  if (ind.currentPrice > ind.vwap) score += 25;
  if (ind.rsi > 52 && ind.rsi < 72) score += 25;
  return score;
}

/* ================= MAIN ================= */
const cooldown = new Map();

async function run() {
  if (!isMarketOpenIST()) {
    console.log("Market closed, skipping");
    return;
  }
  
  console.log(`Scan start - ${SYMBOLS.length} symbols (5m intraday - BUY only)`);
  
  for (const sym of SYMBOLS) {
    const plainSym = sym.replace('.NS', '');
    try {
      await sleep(DELAY_MS);
      
      const bars = await fetchIntradayData(sym);
      if (!bars) continue;
      
      const ind = calculateIndicators(bars);
      if (!ind) continue;
      
      const buyCross = ind.prevEma9 <= ind.prevEma21 && ind.ema9 > ind.ema21;
      
      if (!buyCross) continue;
      if (ind.rsi <= 52 || ind.currentPrice <= ind.vwap || ind.ema21 <= ind.ema50) continue;
      
      const conf = calculateConfidence(ind);
      if (conf < MIN_CONFIDENCE) continue;
      
      if (cooldown.has(plainSym) && Date.now() - cooldown.get(plainSym) < COOLDOWN_MINUTES * 60000) {
        console.log(`Cooldown: ${plainSym}`);
        continue;
      }
      
      cooldown.set(plainSym, Date.now());
      
      const entry = ind.currentPrice;
      const sl = entry * (1 - SL_PCT / 100);
      const target = entry * (1 + TARGET_PCT / 100);
      const riskReward = ((target - entry) / (entry - sl)).toFixed(2);
      
      const msg = `
📈 *BUY SIGNAL ALERT* 📈
**${plainSym}**
Current Price: *${entry.toFixed(2)}*
🎯 Target: *${target.toFixed(2)}*
🛑 Stop Loss: *${sl.toFixed(2)}*
Risk:Reward → **1 : ${riskReward}**
Confidence: **${conf}/100** 🔥
Reason: EMA9 crossed above EMA21 | EMA21 > EMA50 | Price > VWAP | RSI bullish momentum
Time (IST): ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" })}
⚠️ Trade at your own risk – Not financial advice!
      `.trim();
      
      await sendTelegram(msg);
      
      await logToSheet({
        TimeIST: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" }),
        Symbol: plainSym,
        Direction: "BUY",
        EntryPrice: entry,
        Target: target,
        StopLoss: sl,
        Plus2Check: "PENDING",
        Confidence: conf,
        RawTimeUTC: new Date().toISOString()
      });
      
      console.log(`Alert sent: ${plainSym} BUY (Conf ${conf})`);
    } catch (e) {
      console.error(`Error ${plainSym}: ${e.message}`);
    }
  }
  console.log("Scan complete!");
}

await run();
