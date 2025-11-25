/**
 * src/updateSymbols.js
 * Tries to fetch NSE F&O list and writes to data/symbols.json
 * Run daily in CI if desired (fails safe).
 */

import axios from "axios";
import fs from "fs";
import path from "path";

const out = path.join(process.cwd(), "data", "symbols.json");

const fallback = [
  "RELIANCE","TCS","HDFCBANK","INFY","HDFC","ICICIBANK","KOTAKBANK","LT","SBIN","AXISBANK",
  "BAJFINANCE","BHARTIARTL","ITC","HINDUNILVR","MARUTI","SUNPHARMA","BAJAJFINSV","ASIANPAINT",
  "NESTLEIND","TITAN","ONGC","POWERGRID","ULTRACEMCO","NTPC","DRREDDY","HCLTECH","INDUSINDBK"
];

async function fetchNse(){
  try {
    const url = "https://www.nseindia.com/api/equity-stockIndices?index=SECURITIES%20IN%20F&O";
    const res = await axios.get(url, { headers: { "User-Agent":"Mozilla/5.0" }, timeout: 15000 });
    if (res.data && Array.isArray(res.data)) {
      const syms = res.data.map(i=>i.symbol).filter(Boolean).slice(0,100);
      if (syms.length) return syms;
    }
  } catch (e) {
    // ignore and fallback
  }
  return null;
}

(async ()=>{
  const list = await fetchNse() || fallback;
  try {
    fs.writeFileSync(out, JSON.stringify(list, null, 2));
    console.log("Wrote symbols.json", out);
  } catch (e) {
    console.error("Failed to write symbols.json", e.message || e);
  }
})();
