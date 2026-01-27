/**
 * trade-alerts-nse
 * FINAL PRODUCTION VERSION
 */

import YahooFinance from "yahoo-finance2";
import { EMA, RSI, ATR } from "technicalindicators";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const yahoo = new YahooFinance();

const SL_PCT = 0.7;
const TARGET_PCT = 1.4;
const MIN_CONFIDENCE = 60;
const INTERVAL = "5m";
const LOOKBACK_DAYS = 5;
const ATR_PCT_MAX = 8;
const CANDLE_STRENGTH_MIN = 0.05;
const RSI_UPPER = 72;

const REQUIRED = ["TELEGRAM_BOT_TOKEN","TELEGRAM_CHAT_ID","SPREADSHEET_ID","GOOGLE_SERVICE_ACCOUNT_JSON"];
for(const k of REQUIRED) if(!process.env[k]) throw new Error(`Missing ${k}`);

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

async function telegram(msg){
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:process.env.TELEGRAM_CHAT_ID,text:msg})
  });
}

async function sheet(row){
  const c=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth=new JWT({email:c.client_email,key:c.private_key,scopes:["https://www.googleapis.com/auth/spreadsheets"]});
  const doc=new GoogleSpreadsheet(process.env.SPREADSHEET_ID,auth);
  await doc.loadInfo();
  await doc.sheetsByTitle["Alerts"].addRow(row);
}

function confidence(e9,e21,r){ return (e9>e21?40:0)+(r>55&&r<RSI_UPPER?30:0)+(r>50?30:0); }

async function run(){

  const p2=Math.floor(Date.now()/1000);
  const p1=p2-LOOKBACK_DAYS*86400;

  const ist=new Date(Date.now()+5.5*3600000);
  const hr=ist.getHours(), min=ist.getMinutes();

  console.log("🚀 Started",ist.toLocaleString("en-IN"));

  for(const s of SYMBOLS){
    try{

      const r=await yahoo.chart(s,{interval:INTERVAL,period1:p1,period2:p2});
      const q=r?.quotes;
      if(!q||q.length<60) continue;

      const close=q.map(x=>x.close), high=q.map(x=>x.high), low=q.map(x=>x.low);

      const e9=EMA.calculate({period:9,values:close}).at(-1);
      const e21=EMA.calculate({period:21,values:close}).at(-1);
      const e50=EMA.calculate({period:50,values:close}).at(-1);
      const p9=EMA.calculate({period:9,values:close.slice(0,-1)}).at(-1);
      const p21=EMA.calculate({period:21,values:close.slice(0,-1)}).at(-1);
      const rsi=RSI.calculate({period:14,values:close}).at(-1);
      const atr=ATR.calculate({period:14,high,low,close}).at(-1);

      if(p9>p21||e9<=e21) continue;
      if(rsi<=50||rsi>RSI_UPPER) continue;
      if(close.at(-1)<e50) continue;

      const candle=((q.at(-1).close-q.at(-1).open)/q.at(-1).open)*100;
      if(candle<CANDLE_STRENGTH_MIN) continue;

      const atrPct=(atr/close.at(-1))*100;
      if(atrPct>ATR_PCT_MAX) continue;

      if(hr<9||(hr==9&&min<15)||hr>15||(hr==15&&min>30)) continue;

      const conf=confidence(e9,e21,rsi);
      if(conf<MIN_CONFIDENCE) continue;

      const entry=close.at(-1);
      const sl=entry*(1-SL_PCT/100);
      const tgt=entry*(1+TARGET_PCT/100);

      await telegram(`BUY ${s}\nEntry ${entry.toFixed(2)}\nSL ${sl.toFixed(2)}\nTarget ${tgt.toFixed(2)}`);
      await sheet([ist.toLocaleString("en-IN"),s,"BUY",entry.toFixed(2),tgt.toFixed(2),sl.toFixed(2),"PENDING",conf]);

      console.log("✅",s);

    }catch{ console.log(`${s} yahoo fail`); }
  }

  console.log("🏁 Done");
}

await run();
