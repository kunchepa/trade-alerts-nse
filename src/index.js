/**
 * trade-alerts-nse
 * FINAL STABLE VERSION
 */

import YahooFinance from "yahoo-finance2";
import { EMA, RSI, ATR } from "technicalindicators";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

/* ========================= */
const yahooFinance = new YahooFinance();
/* ========================= */

const SL_PCT = 0.7;
const TARGET_PCT = 1.4;
const MIN_CONFIDENCE = 60;
const COOLDOWN_MINUTES = 30;
const INTERVAL = "5m";
const LOOKBACK_DAYS = 5;
const ATR_PCT_MAX = 8;
const CANDLE_STRENGTH_MIN = 0.05;
const RSI_UPPER = 72;

const alertedStocks = new Map();

/* ENV */

const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "SPREADSHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON"
];

for (const k of REQUIRED_ENV) {
  if (!process.env[k]) throw new Error(`Missing env ${k}`);
}

console.log("✅ ENV loaded");

/* SYMBOLS */

const SYMBOLS = [
"RELIANCE.NS","TCS.NS","HDFCBANK.NS","INFY.NS","ICICIBANK.NS","KOTAKBANK.NS","LT.NS",
"SBIN.NS","AXISBANK.NS","BAJFINANCE.NS","BHARTIARTL.NS","ITC.NS","HINDUNILVR.NS","MARUTI.NS",
"SUNPHARMA.NS","BAJAJFINSV.NS","ASIANPAINT.NS","NESTLEIND.NS","TITAN.NS","ONGC.NS",
"POWERGRID.NS","ULTRACEMCO.NS","NTPC.NS","DRREDDY.NS","HCLTECH.NS","INDUSINDBK.NS",
"DIVISLAB.NS","ADANIPORTS.NS","JSWSTEEL.NS","COALINDIA.NS","ADANIENT.NS","M&M.NS",
"TATASTEEL.NS","GRASIM.NS","WIPRO.NS","HDFCLIFE.NS","TECHM.NS","SBILIFE.NS",
"BRITANNIA.NS","CIPLA.NS","EICHERMOT.NS","HINDALCO.NS","HEROMOTOCO.NS","BPCL.NS",
"SHREECEM.NS","IOC.NS","TATACONSUM.NS","UPL.NS","VEDL.NS","DLF.NS","PIDILITIND.NS",
"ICICIPRULI.NS","JSWENERGY.NS","BANKBARODA.NS","CANBK.NS","PNB.NS","UNIONBANK.NS",
"BANDHANBNK.NS","IDFCFIRSTB.NS","GAIL.NS","TATAPOWER.NS","TORNTPHARM.NS",
"ABB.NS","SIEMENS.NS","MUTHOOTFIN.NS","BAJAJ-AUTO.NS","AMBUJACEM.NS","ACC.NS",
"BEL.NS","HAL.NS","IRCTC.NS","POLYCAB.NS","ETERNAL.NS","NAUKRI.NS","ASHOKLEY.NS",
"TVSMOTOR.NS","CHOLAFIN.NS","MGL.NS","IGL.NS","APOLLOHOSP.NS","TMCV.NS"
];

/* TELEGRAM */

async function sendTelegram(msg) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: msg })
  });
}

/* SHEETS */

async function logToSheet(row) {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, auth);
  await doc.loadInfo();
  await doc.sheetsByTitle["Alerts"].addRow(row);
}

/* CONFIDENCE */

function confidence(ema9, ema21, rsi) {
  let s = 0;
  if (ema9 > ema21) s += 40;
  if (rsi > 55 && rsi < RSI_UPPER) s += 30;
  if (rsi > 50) s += 30;
  return s;
}

/* MAIN */

async function run() {

  const p2 = Math.floor(Date.now()/1000);
  const p1 = p2 - LOOKBACK_DAYS*86400;
  const now = Date.now();

  const ist = new Date(now + 5.5*3600000);
  const hr = ist.getHours();
  const min = ist.getMinutes();

  console.log(`🚀 Started IST ${ist}`);

  for (const s of SYMBOLS) {

    try {

      const res = await yahooFinance.chart(s,{interval:INTERVAL,period1:p1,period2:p2});
      const c = res?.quotes;
      if(!c || c.length<60) continue;

      const close=c.map(x=>x.close), high=c.map(x=>x.high), low=c.map(x=>x.low);

      const ema9=EMA.calculate({period:9,values:close}).at(-1);
      const ema21=EMA.calculate({period:21,values:close}).at(-1);
      const ema50=EMA.calculate({period:50,values:close}).at(-1);
      const p9=EMA.calculate({period:9,values:close.slice(0,-1)}).at(-1);
      const p21=EMA.calculate({period:21,values:close.slice(0,-1)}).at(-1);
      const rsi=RSI.calculate({period:14,values:close}).at(-1);
      const atr=ATR.calculate({period:14,high,low,close}).at(-1);

      if(p9>p21 || ema9<=ema21) continue;
      if(rsi<=50||rsi>RSI_UPPER) continue;
      if(close.at(-1)<ema50) continue;

      const candle=((c.at(-1).close-c.at(-1).open)/c.at(-1).open)*100;
      if(candle<CANDLE_STRENGTH_MIN) continue;

      const atrPct=(atr/close.at(-1))*100;
      if(atrPct>ATR_PCT_MAX) continue;

      if(hr<9||(hr==9&&min<15)||hr>15||(hr==15&&min>30)) continue;

      const conf=confidence(ema9,ema21,rsi);
      if(conf<MIN_CONFIDENCE) continue;

      const entry=close.at(-1);
      const sl=entry*(1-SL_PCT/100);
      const tgt=entry*(1+TARGET_PCT/100);

      await sendTelegram(`BUY ${s}\nEntry ${entry.toFixed(2)}\nSL ${sl.toFixed(2)}\nTarget ${tgt.toFixed(2)}`);

      await logToSheet([ist.toLocaleString("en-IN"),s,"BUY",entry.toFixed(2),tgt.toFixed(2),sl.toFixed(2),"PENDING",conf]);

      console.log(`✅ ${s}`);

    } catch(e){ console.log(`${s} fail`); }

  }

  console.log("🏁 Done");
}

await run();
