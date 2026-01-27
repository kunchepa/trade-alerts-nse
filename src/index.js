import yahooFinance from "yahoo-finance2";
import { EMA, RSI, ATR } from "technicalindicators";
import fetch from "node-fetch";

console.log("🚀 Scanner started");

const SYMBOLS = [
"RELIANCE.NS","TCS.NS","HDFCBANK.NS","INFY.NS","ICICIBANK.NS","LT.NS","SBIN.NS",
"AXISBANK.NS","KOTAKBANK.NS","BAJFINANCE.NS","BHARTIARTL.NS","ITC.NS","HINDUNILVR.NS",
"MARUTI.NS","SUNPHARMA.NS","BAJAJFINSV.NS","ASIANPAINT.NS","NESTLEIND.NS","TITAN.NS",
"ONGC.NS","POWERGRID.NS","ULTRACEMCO.NS","NTPC.NS","DRREDDY.NS","HCLTECH.NS",
"INDUSINDBK.NS","DIVISLAB.NS","ADANIPORTS.NS","JSWSTEEL.NS","COALINDIA.NS",
"ADANIENT.NS","M&M.NS","TATASTEEL.NS","GRASIM.NS","WIPRO.NS","HDFCLIFE.NS","TECHM.NS",
"SBILIFE.NS","BRITANNIA.NS","CIPLA.NS","EICHERMOT.NS","HINDALCO.NS","HEROMOTOCO.NS",
"BPCL.NS","SHREECEM.NS","IOC.NS","TATACONSUM.NS","UPL.NS","VEDL.NS","DLF.NS",
"PIDILITIND.NS","ICICIPRULI.NS","JSWENERGY.NS","BANKBARODA.NS","CANBK.NS","PNB.NS",
"UNIONBANK.NS","BANDHANBNK.NS","IDFCFIRSTB.NS","GAIL.NS","TATAPOWER.NS","TORNTPHARM.NS",
"ABB.NS","SIEMENS.NS","MUTHOOTFIN.NS","BAJAJ-AUTO.NS","AMBUJACEM.NS","ACC.NS","BEL.NS",
"HAL.NS","IRCTC.NS","POLYCAB.NS","ETERNAL.NS","NAUKRI.NS","ASHOKLEY.NS","TVSMOTOR.NS",
"CHOLAFIN.NS","MGL.NS","IGL.NS","APOLLOHOSP.NS",

// custom replacements
"TMCV.NS"
];


const INTERVAL = "5m";
const LOOKBACK_DAYS = 5;

async function sendTelegram(msg) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: msg
    })
  });
}

function inMarket() {
  const ist = new Date(Date.now() + 19800000);
  const h = ist.getHours();
  const m = ist.getMinutes();

  return !(h < 9 || (h === 12) || (h === 13) || h > 15 || (h === 15 && m > 30));
}

async function scan() {
  if (!inMarket()) {
    console.log("⏱ Outside market hours");
    return;
  }

  const p2 = Math.floor(Date.now() / 1000);
  const p1 = p2 - LOOKBACK_DAYS * 86400;

  for (const sym of SYMBOLS) {
    try {
      const r = await yahooFinance.chart(sym, { interval: INTERVAL, period1: p1, period2: p2 });
      const q = r.quotes;

      if (!q || q.length < 60) continue;

      const close = q.map(x => x.close);
      const high = q.map(x => x.high);
      const low = q.map(x => x.low);

      const ema9 = EMA.calculate({ period: 9, values: close }).at(-1);
      const ema21 = EMA.calculate({ period: 21, values: close }).at(-1);
      const ema50 = EMA.calculate({ period: 50, values: close }).at(-1);
      const rsi = RSI.calculate({ period: 14, values: close }).at(-1);
      const atr = ATR.calculate({ period: 14, high, low, close }).at(-1);

      if (!ema9 || !ema21 || !ema50 || !rsi || !atr) continue;

      if (ema9 <= ema21) continue;
      if (close.at(-1) < ema50) continue;
      if (rsi > 72 || rsi < 50) continue;

      const atrPct = atr / close.at(-1) * 100;
      if (atrPct > 3) continue;

      const msg = `📈 BUY ${sym}\nPrice: ${close.at(-1).toFixed(2)}\nRSI: ${rsi.toFixed(1)}\nATR%: ${atrPct.toFixed(2)}`;
      await sendTelegram(msg);

      console.log("✅ Alert:", sym);
    } catch {
      console.log(`⚠️ ${sym} yahoo failed`);
    }
  }

  console.log("🏁 Scanner completed");
}

await scan();
