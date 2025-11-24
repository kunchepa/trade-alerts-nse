/**
 * src/index.js
 *
 * Option A — Yahoo Finance (fixed)
 *
 * env vars required (set as GitHub secrets in Actions):
 *  TELEGRAM_BOT_TOKEN
 *  TELEGRAM_CHAT_ID
 *  GOOGLE_SERVICE_ACCOUNT_JSON  (stringified JSON)
 *  SPREADSHEET_ID
 *
 * optional:
 *  ACCOUNT_CAPITAL (default 100000)
 *  RISK_PCT (default 0.01)
 *  SL_ATR_MULTIPLIER (default 1.5)
 *  TP_ATR_MULTIPLIER (default 3.0)
 *
 * Install:
 *  npm install
 * Run:
 *  node src/index.js
 */

import fetch from "node-fetch";
import yahooFinance from "yahoo-finance2";
import technical from "technicalindicators";
import { google } from "googleapis";

// ---------- CONFIG ----------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const GOOGLE_SERVICE_ACCOUNT_JSON = (() => {
  try {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}");
  } catch (e) {
    console.error("Failed parsing GOOGLE_SERVICE_ACCOUNT_JSON:", e.message);
    return {};
  }
})();
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = "Alerts";

const ACCOUNT_CAPITAL = Number(process.env.ACCOUNT_CAPITAL || 100000);
const RISK_PCT = Number(process.env.RISK_PCT || 0.01); // 1% default
const SL_ATR_MULTIPLIER = Number(process.env.SL_ATR_MULTIPLIER || 1.5);
const TP_ATR_MULTIPLIER = Number(process.env.TP_ATR_MULTIPLIER || 3.0);
const WINRATE_LOOKBACK_DAYS = 60;

// ---------- SYMBOL LIST ----------
const symbols = [
  // default 75+ tickers (NSE names). Add/remove as needed.
  "RELIANCE.NS","HDFCBANK.NS","ICICIBANK.NS","INFY.NS","TCS.NS","AXISBANK.NS","SBIN.NS","KOTAKBANK.NS","LT.NS",
  "BHARTIARTL.NS","ITC.NS","HINDUNILVR.NS","HCLTECH.NS","WIPRO.NS","ASIANPAINT.NS","SUNPHARMA.NS","ULTRACEMCO.NS",
  "NESTLEIND.NS","BAJFINANCE.NS","BAJAJFINSV.NS","POWERGRID.NS","JSWSTEEL.NS","TITAN.NS","MARUTI.NS","TATASTEEL.NS",
  "ADANIENT.NS","ADANIPORTS.NS","TECHM.NS","CIPLA.NS","DRREDDY.NS","DIVISLAB.NS","ONGC.NS","COALINDIA.NS","BPCL.NS","IOC.NS",
  "GRASIM.NS","HEROMOTOCO.NS","BRITANNIA.NS","SHREECEM.NS","EICHERMOT.NS","APOLLOHOSP.NS","HDFCLIFE.NS","SBILIFE.NS",
  "ICICIPRULI.NS","INDUSINDBK.NS","BAJAJ-AUTO.NS","M&M.NS","TATAMOTORS.NS","UPL.NS","VEDL.NS","NTPC.NS","HINDALCO.NS",
  "LTIM.NS","LTTS.NS","DABUR.NS","PIDILITIND.NS","PEL.NS","JINDALSTEL.NS","SRF.NS","SIEMENS.NS","TORNTPHARM.NS",
  "AMBUJACEM.NS","BANDHANBNK.NS","GAIL.NS","BOSCHLTD.NS","COLPAL.NS","GLAND.NS","HAL.NS","MPHASIS.NS",
  "PAGEIND.NS","PIIND.NS","RECLTD.NS","SAIL.NS","TATACOMM.NS","TRENT.NS","UBL.NS","VOLTAS.NS","ZEEL.NS"
];

// ------------------------- Helper: sleep (rate limit) -------------------------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ------------------------- Yahoo helpers -------------------------
// suppress noisy yahoo notices
try {
  if (typeof yahooFinance.suppressNotices === "function") {
    yahooFinance.suppressNotices(["yahooSurvey", "ripHistorical"]);
  }
} catch (e) {
  // ignore if not available
}

/**
 * Fetch live quote for a symbol using yahooFinance.quoteSummary / quote
 * returns { price, raw }
 */
async function fetchQuote(symbol) {
  try {
    // yahoo-finance2 uses e.g. "RELIANCE.NS"
    const q = await yahooFinance.quote(symbol);
    const price = q?.regularMarketPrice ?? q?.price?.regularMarketPrice ?? null;
    return { price, raw: q };
  } catch (err) {
    console.warn(`Quote failed for ${symbol}:`, err?.message || err);
    return null;
  }
}

/**
 * Fetch daily OHLCV history using yahooFinance.chart()
 * returns array ordered oldest -> newest: [{date, open, high, low, close, volume}, ...]
 */
async function fetchDailyHistory(symbol, years = 2) {
  try {
    // range: '2y' gives roughly ~500 trading days; interval '1d'
    const opts = { range: `${years}y`, interval: "1d" };
    const chart = await yahooFinance.chart(symbol, opts);

    const r = chart?.chart?.result?.[0];
    if (!r) throw new Error("no chart result");

    const timestamps = r.timestamp || [];
    const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
    const opens = q.open || [];
    const highs = q.high || [];
    const lows = q.low || [];
    const closes = q.close || [];
    const volumes = q.volume || [];

    const out = [];
    for (let i = 0; i < timestamps.length; i++) {
      // yahoo timestamps are seconds
      const ts = timestamps[i] * 1000;
      const open = opens[i];
      const high = highs[i];
      const low = lows[i];
      const close = closes[i];
      const vol = volumes[i];

      // filter nulls
      if (close == null || isNaN(close)) continue;
      out.push({
        date: new Date(ts).toISOString().slice(0, 10),
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(vol || 0)
      });
    }

    // oldest -> newest
    return out;
  } catch (err) {
    console.warn(`History failed for ${symbol}:`, err?.message || err);
    return null;
  }
}

// ------------------------- Indicators -------------------------
function computeIndicatorsFromHistory(hist) {
  const closes = hist.map((d) => d.close);
  const highs = hist.map((d) => d.high ?? d.close);
  const lows = hist.map((d) => d.low ?? d.close);
  const vols = hist.map((d) => d.volume ?? 0);

  const ema20 = technical.EMA.calculate({ period: 20, values: closes });
  const ema50 = technical.EMA.calculate({ period: 50, values: closes });
  const ema200 = technical.EMA.calculate({ period: 200, values: closes });

  let adxVal;
  try {
    const adx = technical.ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    adxVal = adx?.length ? adx[adx.length - 1].adx : undefined;
  } catch (e) {
    adxVal = undefined;
  }

  const atrArr = technical.ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const atrVal = atrArr?.length ? atrArr[atrArr.length - 1] : undefined;

  const vol20arr = technical.SMA.calculate({ period: 20, values: vols });
  const vol20 = vol20arr?.length ? vol20arr[vol20arr.length - 1] : undefined;

  return {
    ema20: ema20.length ? ema20[ema20.length - 1] : undefined,
    ema50: ema50.length ? ema50[ema50.length - 1] : undefined,
    ema200: ema200.length ? ema200[ema200.length - 1] : undefined,
    adx: adxVal,
    atr: atrVal,
    volume: vols.length ? vols[vols.length - 1] : undefined,
    vol20
  };
}

// ------------------------- Signal rules -------------------------
function generateSignalFromIndicators(price, ind) {
  if (!ind || !ind.ema20 || !ind.ema50 || !ind.ema200 || ind.adx == null) return null;
  if (price > ind.ema20 && ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200 && ind.adx > 25) {
    return { direction: "BUY", reason: "Trend+ADX" };
  }
  if (price < ind.ema20 && ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200 && ind.adx > 25) {
    return { direction: "SELL", reason: "Trend+ADX" };
  }
  return null;
}

// ------------------------- Build trade plan -------------------------
function buildTradePlan(symbol, price, ind) {
  const slDistance = (ind.atr || 0.01) * SL_ATR_MULTIPLIER;
  const tpDistance = (ind.atr || 0.01) * TP_ATR_MULTIPLIER;

  const riskPerShare = slDistance;
  const positionSizeShares = Math.max(0, Math.floor((ACCOUNT_CAPITAL * RISK_PCT) / Math.max(riskPerShare, 1e-6)));
  const lotSize = 1;
  const qty = Math.floor(positionSizeShares / lotSize) * lotSize;

  const direction = price > ind.ema20 && ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200 && ind.adx > 25
    ? "BUY"
    : price < ind.ema20 && ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200 && ind.adx > 25
      ? "SELL"
      : null;

  if (!direction || qty <= 0) return null;

  const sl = direction === "BUY" ? price - slDistance : price + slDistance;
  const tp = direction === "BUY" ? price + tpDistance : price - tpDistance;
  const riskAmount = qty * riskPerShare;
  const riskPctActual = (riskAmount / ACCOUNT_CAPITAL) * 100;

  return {
    symbol,
    direction,
    price,
    sl,
    tp,
    atr: ind.atr,
    qty,
    lotSize,
    riskAmount,
    riskPctActual,
    ema20: ind.ema20,
    ema50: ind.ema50,
    ema200: ind.ema200,
    adx: ind.adx,
    volume: ind.volume,
    vol20: ind.vol20
  };
}

// ------------------------- WinRate heuristic -------------------------
function estimateWinRate(hist, lookbackDays = WINRATE_LOOKBACK_DAYS) {
  const n = hist.length;
  if (n < 120) return null;

  let wins = 0;
  let totalSignals = 0;

  for (let idx = n - lookbackDays - 7; idx < n - 6; idx++) {
    if (idx < 60) continue;
    const slice = hist.slice(0, idx + 1);
    const ind = computeIndicatorsFromHistory(slice);
    const priceToday = slice[slice.length - 1].close;
    const sig = generateSignalFromIndicators(priceToday, ind);
    if (!sig) continue;
    totalSignals++;

    const futureWindow = hist.slice(idx + 1, idx + 6); // next 5 days
    const atr = ind.atr || 0.01;
    const slPrice = sig.direction === "BUY" ? priceToday - SL_ATR_MULTIPLIER * atr : priceToday + SL_ATR_MULTIPLIER * atr;
    const tpPrice = sig.direction === "BUY" ? priceToday + TP_ATR_MULTIPLIER * atr : priceToday - TP_ATR_MULTIPLIER * atr;

    let outcome = null;
    for (const f of futureWindow) {
      if (sig.direction === "BUY") {
        if (f.low <= slPrice) { outcome = "loss"; break; }
        if (f.high >= tpPrice) { outcome = "win"; break; }
      } else {
        if (f.high >= slPrice) { outcome = "loss"; break; }
        if (f.low <= tpPrice) { outcome = "win"; break; }
      }
    }
    if (outcome === "win") wins++;
  }

  if (totalSignals === 0) return null;
  return (wins / totalSignals) * 100;
}

// ------------------------- Telegram + Sheets -------------------------
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("Telegram credentials missing; skipping send");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
  } catch (e) {
    console.error("Telegram send error:", e.message || e);
  }
}

async function appendSheetRow(row) {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON.client_email || !GOOGLE_SERVICE_ACCOUNT_JSON.private_key || !SPREADSHEET_ID) {
    console.warn("Google Sheets credentials missing; skipping append");
    return;
  }
  try {
    const auth = new google.auth.JWT(
      GOOGLE_SERVICE_ACCOUNT_JSON.client_email,
      null,
      GOOGLE_SERVICE_ACCOUNT_JSON.private_key,
      ["https://www.googleapis.com/auth/spreadsheets"]
    );
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:Z`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  } catch (e) {
    console.error("Sheets append error:", e.message || e);
  }
}

// ------------------------- Main -------------------------
async function run() {
  console.log("🚀 Starting Trade Alerts...");
  for (const symbol of symbols) {
    try {
      console.log(`📡 Fetching: ${symbol}`);

      const q = await fetchQuote(symbol);
      if (!q || q.price == null) {
        console.warn(`Quote failed or missing for ${symbol}`);
        // small delay and continue
        await sleep(400);
        continue;
      }
      const price = Number(q.price);

      const hist = await fetchDailyHistory(symbol, 2);
      if (!hist || hist.length < 120) {
        console.warn(`Insufficient history for ${symbol}`);
        await sleep(500);
        continue;
      }

      const ind = computeIndicatorsFromHistory(hist);

      const plan = buildTradePlan(symbol, price, ind);
      if (!plan) {
        console.log(`${symbol} -> no trade signal`);
        await sleep(350);
        continue;
      }

      const winRate = estimateWinRate(hist, WINRATE_LOOKBACK_DAYS);
      const winRateText = winRate ? `${winRate.toFixed(1)}%` : "N/A";

      const tg = [
        `📢 <b>TRADE SIGNAL</b>`,
        `🔸 Symbol: <b>${symbol.replace(".NS","")}</b>`,
        `🔸 Direction: <b>${plan.direction}</b>`,
        `🔸 Price: ₹${plan.price}`,
        `🔸 SL: ₹${plan.sl.toFixed(2)} | TP: ₹${plan.tp.toFixed(2)}`,
        `🔸 Qty: ${plan.qty} (lot ${plan.lotSize})`,
        `🔸 RiskAmt: ₹${plan.riskAmount.toFixed(2)} (~${plan.riskPctActual.toFixed(2)}% of capital)`,
        `🔸 ATR: ${plan.atr?.toFixed(4) || "NA"} | ADX: ${plan.adx?.toFixed(1) || "NA"}`,
        `🔸 WinRate(60d estimate): ${winRateText}`,
        `\nReason: Trend with strength (EMA & ADX)`
      ].join("\n");

      await sendTelegram(tg);

      const row = [
        new Date().toLocaleString("en-IN"),
        plan.symbol,
        plan.direction,
        plan.price,
        "Trend+ADX",
        plan.ema20,
        plan.ema50,
        plan.ema200,
        plan.adx,
        plan.atr,
        plan.volume,
        plan.vol20,
        winRate ? winRate.toFixed(2) : "",
        plan.sl,
        plan.tp,
        plan.qty,
        plan.riskAmount.toFixed(2),
        plan.riskPctActual.toFixed(4)
      ];
      await appendSheetRow(row);

      console.log(`✅ Signal: ${plan.symbol} ${plan.direction} @ ${plan.price} (qty ${plan.qty})`);
      // polite delay between symbols to reduce rate-limit issues
      await sleep(500);
    } catch (err) {
      console.error("Error processing", symbol, err?.message || err);
      // small delay on error
      await sleep(500);
    }
  }

  console.log("🏁 Completed scan.");
}

// Run
run().catch((e) => {
  console.error("Fatal error:", e?.message || e);
  process.exit(1);
});
