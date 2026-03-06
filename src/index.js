/**
 * NSE EMA Scanner – BUY ONLY VERSION (SELL signals removed)
 * Intraday 5m, EMA9/21/50, VWAP (daily reset), ATR-based SL, Volume confirmation
 * Full Nifty 100 Symbols (Feb 2026)
 *
 * FIXES APPLIED:
 * 1. VWAP now resets daily at 9:15 AM IST (was cumulative across 10 days - critical bug)
 * 2. Volume confirmation added (crossover must have 1.2x avg volume)
 * 3. ATR-based dynamic Stop Loss (replaces flat 0.6% SL)
 * 4. Confidence score now meaningful (checks extra filters beyond signal conditions)
 * 5. yahoo-finance2 import corrected (no default class instantiation)
 * 6. MINDTREE.NS removed (merged into LTIM in 2023, duplicate)
 * 7. Persistent cooldown via JSON file (survives process restarts)
 * 8. Signal deduplication guard added
 */

import fetch from "node-fetch";
import { EMA, RSI, ATR } from "technicalindicators";
import { GoogleSpreadsheet } from "google-spreadsheet";
import yahooFinance from "yahoo-finance2";
import fs from "fs";
import path from "path";

/* ================= CONFIG ================= */
const TARGET_PCT       = 0.8;       // Target % above entry (kept from original)
const MIN_CONFIDENCE   = 70;        // Minimum confidence score to fire alert
const DELAY_MS         = 3000;      // Delay between symbol fetches (rate limit)
const COOLDOWN_MINUTES = 30;        // Cooldown per symbol to avoid duplicate alerts
const INTERVAL         = "5m";      // Candle interval
const ATR_PERIOD       = 14;        // ATR period for dynamic SL
const ATR_MULTIPLIER   = 1.5;       // ATR multiplier for Stop Loss
const VOLUME_SURGE_X   = 1.2;       // Volume must be 1.2x the 20-bar average
const COOLDOWN_FILE    = "./cooldown_state.json"; // Persistent cooldown storage

/* ================= SYMBOLS - Full Nifty 100 (MINDTREE removed, was merged into LTIM) ================= */
const SYMBOLS = [
  "RELIANCE.NS",    "HDFCBANK.NS",   "BHARTIARTL.NS", "TCS.NS",        "SBIN.NS",
  "ICICIBANK.NS",   "INFY.NS",       "ITC.NS",        "HINDUNILVR.NS", "LT.NS",
  "BAJFINANCE.NS",  "KOTAKBANK.NS",  "AXISBANK.NS",   "SUNPHARMA.NS",  "MARUTI.NS",
  "M&M.NS",         "ULTRACEMCO.NS", "NTPC.NS",       "ONGC.NS",       "POWERGRID.NS",
  "TITAN.NS",       "ADANIPORTS.NS", "ADANIENT.NS",   "BAJAJFINSV.NS", "INDUSINDBK.NS",
  "TECHM.NS",       "HCLTECH.NS",    "ASIANPAINT.NS", "NESTLEIND.NS",  "JSWSTEEL.NS",
  "COALINDIA.NS",   "TATAMOTORS.NS", "BAJAJ-AUTO.NS", "TATASTEEL.NS",  "WIPRO.NS",
  "HDFCLIFE.NS",    "SBILIFE.NS",    "HEROMOTOCO.NS", "DRREDDY.NS",    "CIPLA.NS",
  "APOLLOHOSP.NS",  "DIVISLAB.NS",   "BRITANNIA.NS",  "EICHERMOT.NS",  "GRASIM.NS",
  "BPCL.NS",        "IOC.NS",        "TATACONSUM.NS", "UPL.NS",        "HINDALCO.NS",
  "SHREECEM.NS",    "PIDILITIND.NS", "DABUR.NS",      "BOSCHLTD.NS",   "TVSMOTOR.NS",
  "SIEMENS.NS",     "HAL.NS",        "BEL.NS",        "DLF.NS",        "INDIGO.NS",
  "LTIM.NS",        "GODREJCP.NS",   "CHOLAFIN.NS",   "POLYCAB.NS",    "SRF.NS",
  "CANBK.NS",       "PNB.NS",        "UNIONBANK.NS",  "BANKBARODA.NS", "IGL.NS",
  "MGL.NS",         "TORNTPHARM.NS", "JSWENERGY.NS",  "ABB.NS",        "ACC.NS",
  "VEDL.NS",        "TATAPOWER.NS",  "GAIL.NS",       "AUROPHARMA.NS", "BANDHANBNK.NS",
  "IDFCFIRSTB.NS",  "JINDALSTEL.NS", "ADANIGREEN.NS", "ADANIPOWER.NS", "COFORGE.NS",
  "LTTS.NS",        "BAJAJCORP.NS",  "ICICIPRULI.NS", "SBICARD.NS",
  "PAGEIND.NS",     "MUTHOOTFIN.NS", "TRENT.NS",      "MAXHEALTH.NS",  "ETERNAL.NS"
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

/**
 * Returns true if current IST time is within NSE market hours (Mon-Fri 9:15–15:30)
 */
function isMarketOpenIST() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h   = ist.getHours();
  const m   = ist.getMinutes();
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  return (h > 9 || (h === 9 && m >= 15)) && (h < 15 || (h === 15 && m <= 30));
}

/**
 * Returns today's date string in IST (YYYY-MM-DD)
 */
function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // "2026-03-06"
}

/**
 * Sends a Telegram message (Markdown mode)
 */
async function sendTelegram(msg) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id:    process.env.TELEGRAM_CHAT_ID,
          text:       msg,
          parse_mode: "Markdown"
        })
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      console.error("Telegram failed:", res.status, errText);
    } else {
      console.log("✅ Telegram sent OK");
    }
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

/**
 * Appends a row to the first sheet of the configured Google Spreadsheet
 */
async function logToSheet(row) {
  try {
    console.log("[SHEET] Logging row for:", row.Symbol);
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const auth          = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const doc           = new GoogleSpreadsheet(spreadsheetId);
    await doc.useServiceAccountAuth(auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow(row);
    console.log(`[SHEET] SUCCESS: Added ${row.Symbol}`);
  } catch (e) {
    console.error("[SHEET] FAIL:", e.message);
  }
}

/* ================= PERSISTENT COOLDOWN ================= */
/**
 * Loads cooldown state from disk (survives process restarts/crashes)
 * Format: { "RELIANCE": { timestamp: 1234567890, date: "2026-03-06" }, ... }
 */
function loadCooldown() {
  try {
    if (fs.existsSync(COOLDOWN_FILE)) {
      return JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf-8"));
    }
  } catch (e) {
    console.warn("[COOLDOWN] Failed to load state, starting fresh:", e.message);
  }
  return {};
}

/**
 * Saves cooldown state to disk
 */
function saveCooldown(state) {
  try {
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[COOLDOWN] Failed to save state:", e.message);
  }
}

/**
 * Returns true if symbol is still in cooldown period.
 * Also auto-clears stale entries from previous trading days.
 */
function isInCooldown(state, symbol) {
  const entry = state[symbol];
  if (!entry) return false;
  // Clear if it's a different trading day
  if (entry.date !== todayIST()) {
    delete state[symbol];
    return false;
  }
  return (Date.now() - entry.timestamp) < COOLDOWN_MINUTES * 60 * 1000;
}

/**
 * Marks a symbol as alerted (updates cooldown state)
 */
function setCooldown(state, symbol) {
  state[symbol] = { timestamp: Date.now(), date: todayIST() };
  saveCooldown(state);
}

/* ================= DATA FETCH ================= */
/**
 * Fetches last 10 days of 5m intraday bars for a symbol via yahoo-finance2.
 * Returns raw quotes array or null on failure.
 *
 * FIX: yahoo-finance2 is used directly as a module (not instantiated as a class)
 */
async function fetchIntradayData(symbol) {
  try {
    const plain = symbol.replace(".NS", "");
    console.log(`Fetching intraday ${INTERVAL} for ${plain}`);

    const queryOptions = {
      period1:        Math.floor((Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000),
      period2:        Math.floor(Date.now() / 1000),
      interval:       INTERVAL,
      includePrePost: false
    };

    const result = await yahooFinance.chart(symbol, queryOptions);

    if (!result || !result.quotes || result.quotes.length < 60) {
      console.log(`Insufficient data for ${plain} (${result?.quotes?.length || 0} bars)`);
      return null;
    }

    console.log(`Got ${result.quotes.length} bars for ${plain}`);
    return result.quotes;
  } catch (e) {
    console.error(`Fetch fail ${symbol}: ${e.message}`);
    return null;
  }
}

/* ================= VWAP (DAILY RESET) ================= */
/**
 * FIX (Critical): VWAP must reset at 9:15 AM IST each day.
 * Previous code accumulated VWAP across 10 days of bars, which is incorrect.
 * This function filters bars to today only, then computes intraday VWAP.
 *
 * @param {Array} bars - All fetched bars (multi-day)
 * @returns {number} VWAP value for today, or NaN if no today bars
 */
function computeDailyVWAP(bars) {
  const today = todayIST(); // e.g. "2026-03-06"

  const todayBars = bars.filter(b => {
    if (!b.date) return false;
    // b.date can be a Date object or a Unix timestamp (seconds)
    const d   = b.date instanceof Date ? b.date : new Date(b.date * 1000);
    const ist = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    return ist.toLocaleDateString("en-CA") === today;
  });

  if (todayBars.length === 0) {
    console.warn("  No today bars found for VWAP — market may not have opened yet");
    return NaN;
  }

  let cumTPV = 0;
  let cumVol = 0;
  for (const b of todayBars) {
    const tp    = (b.high + b.low + b.close) / 3;
    const vol   = b.volume || 0;
    cumTPV     += tp * vol;
    cumVol     += vol;
  }

  return cumVol > 0 ? cumTPV / cumVol : NaN;
}

/* ================= INDICATORS ================= */
/**
 * Calculates all technical indicators from raw bars.
 *
 * FIX: currentVolume is now compared to 20-bar average (volume confirmation)
 * FIX: ATR added for dynamic stop loss calculation
 * FIX: VWAP uses daily reset function above
 *
 * @param {Array} bars - Raw quote bars from Yahoo Finance
 * @returns {Object|null} Indicator values, or null if insufficient data
 */
function calculateIndicators(bars) {
  if (bars.length < 60) return null;

  const closes  = bars.map(b => b.close).filter(v => v != null && !isNaN(v));
  const highs   = bars.map(b => b.high).filter(v => v != null && !isNaN(v));
  const lows    = bars.map(b => b.low).filter(v => v != null && !isNaN(v));
  const volumes = bars.map(b => b.volume || 0);

  if (closes.length < 60) return null;

  // EMAs
  const ema9  = EMA.calculate({ period: 9,  values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });

  // RSI
  const rsi = RSI.calculate({ period: 14, values: closes });

  // ATR (dynamic stop loss)
  const atrValues = ATR.calculate({
    period: ATR_PERIOD,
    high:   highs,
    low:    lows,
    close:  closes
  });

  // VWAP — daily reset (critical fix)
  const vwap = computeDailyVWAP(bars);

  // Volume: current vs 20-bar average
  const recentVolumes = volumes.slice(-20);
  const avgVolume     = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
  const currentVolume = volumes[volumes.length - 1];

  return {
    ema9:          ema9[ema9.length - 1],
    ema21:         ema21[ema21.length - 1],
    ema50:         ema50[ema50.length - 1],
    prevEma9:      ema9[ema9.length - 2],
    prevEma21:     ema21[ema21.length - 2],
    rsi:           rsi[rsi.length - 1],
    vwap,
    atr:           atrValues[atrValues.length - 1],
    currentPrice:  closes[closes.length - 1],
    currentVolume,
    avgVolume
  };
}

/* ================= CONFIDENCE SCORE ================= */
/**
 * FIX: Confidence score is now meaningful — it measures *strength* of the signal
 * beyond the minimum conditions already checked (EMA cross, VWAP, RSI).
 *
 * Base conditions (already gated): EMA9>EMA21 cross, EMA21>EMA50, Price>VWAP, RSI 52-72
 * Bonus points for:
 *   - RSI in sweet spot (55–65): stronger momentum without overbought risk
 *   - Volume surge >= 1.5x average: institutional participation
 *   - EMA9 well above EMA21 (>0.3%): strong separation, not a weak cross
 *   - Price above VWAP by >0.5%: committed buying pressure
 *   - ATR/Price < 1.5%: lower volatility = cleaner setup
 *
 * Score: 0–100
 */
function calculateConfidence(ind) {
  let score = 50; // Base score (all mandatory conditions already passed)

  // RSI sweet spot bonus (up to +15)
  if (ind.rsi >= 55 && ind.rsi <= 65) score += 15;
  else if (ind.rsi > 65 && ind.rsi < 72) score += 5;

  // Volume surge bonus (up to +15)
  if (ind.avgVolume > 0) {
    const volRatio = ind.currentVolume / ind.avgVolume;
    if (volRatio >= 2.0)      score += 15;
    else if (volRatio >= 1.5) score += 10;
    else if (volRatio >= 1.2) score += 5;
  }

  // EMA9 vs EMA21 separation bonus (up to +10)
  const emaSeparation = ((ind.ema9 - ind.ema21) / ind.ema21) * 100;
  if (emaSeparation >= 0.5)      score += 10;
  else if (emaSeparation >= 0.3) score += 5;

  // Price above VWAP strength bonus (up to +10)
  if (!isNaN(ind.vwap) && ind.vwap > 0) {
    const vwapGap = ((ind.currentPrice - ind.vwap) / ind.vwap) * 100;
    if (vwapGap >= 1.0)      score += 10;
    else if (vwapGap >= 0.5) score += 5;
  }

  // ATR stability bonus (up to +10)
  const atrPct = (ind.atr / ind.currentPrice) * 100;
  if (atrPct < 0.8)      score += 10;
  else if (atrPct < 1.5) score += 5;

  return Math.min(score, 100); // Cap at 100
}

/* ================= MAIN SCAN ================= */
async function run() {
  if (!isMarketOpenIST()) {
    console.log("⏸ Market closed, skipping scan");
    return;
  }

  // Load persistent cooldown state (survives restarts)
  const cooldownState = loadCooldown();

  console.log(`\n🔍 Scan start — ${SYMBOLS.length} symbols | ${INTERVAL} intraday | BUY only`);
  console.log(`   Date (IST): ${todayIST()}`);

  let alertCount = 0;

  for (const sym of SYMBOLS) {
    const plainSym = sym.replace(".NS", "");
    try {
      await sleep(DELAY_MS);

      // ── 1. Cooldown check (persistent across restarts) ──
      if (isInCooldown(cooldownState, plainSym)) {
        console.log(`⏳ Cooldown active: ${plainSym}`);
        continue;
      }

      // ── 2. Fetch data ──
      const bars = await fetchIntradayData(sym);
      if (!bars) continue;

      // ── 3. Calculate indicators ──
      const ind = calculateIndicators(bars);
      if (!ind) continue;

      // ── 4. VWAP validity guard ──
      if (isNaN(ind.vwap) || ind.vwap <= 0) {
        console.log(`⚠️  ${plainSym}: VWAP unavailable (no today bars), skipping`);
        continue;
      }

      // ── 5. EMA9 crossover above EMA21 (primary signal trigger) ──
      const buyCross = ind.prevEma9 <= ind.prevEma21 && ind.ema9 > ind.ema21;
      if (!buyCross) continue;

      // ── 6. Trend confirmation filters ──
      if (ind.rsi <= 52 || ind.rsi >= 72)           continue; // RSI momentum gate
      if (ind.currentPrice <= ind.vwap)              continue; // Must be above VWAP
      if (ind.ema21 <= ind.ema50)                    continue; // Medium-term trend up

      // ── 7. Volume confirmation (NEW FIX) ──
      // Crossover must occur on above-average volume to be reliable
      if (ind.avgVolume > 0 && ind.currentVolume < ind.avgVolume * VOLUME_SURGE_X) {
        console.log(`📉 ${plainSym}: Low-volume crossover rejected (${(ind.currentVolume / ind.avgVolume).toFixed(2)}x avg)`);
        continue;
      }

      // ── 8. Confidence score ──
      const conf = calculateConfidence(ind);
      if (conf < MIN_CONFIDENCE) {
        console.log(`🔕 ${plainSym}: Confidence too low (${conf})`);
        continue;
      }

      // ── 9. ATR-based dynamic Stop Loss (NEW FIX) ──
      // Instead of flat 0.6%, SL is set 1.5x ATR below entry
      const entry  = ind.currentPrice;
      const sl     = entry - ATR_MULTIPLIER * ind.atr;
      const target = entry * (1 + TARGET_PCT / 100);

      // Validate SL makes sense (should never be above entry)
      if (sl >= entry) {
        console.warn(`⚠️  ${plainSym}: ATR-based SL invalid, skipping`);
        continue;
      }

      const riskReward = ((target - entry) / (entry - sl)).toFixed(2);
      const slPct      = (((entry - sl) / entry) * 100).toFixed(2);
      const volRatio   = ind.avgVolume > 0
        ? (ind.currentVolume / ind.avgVolume).toFixed(2)
        : "N/A";

      // ── 10. Mark cooldown BEFORE sending (prevents duplicate on crash-loop) ──
      setCooldown(cooldownState, plainSym);

      // ── 11. Build alert message ──
      const timeIST = new Date().toLocaleString("en-IN", {
        timeZone:  "Asia/Kolkata",
        dateStyle: "short",
        timeStyle: "short"
      });

      const msg = `
📈 *BUY SIGNAL ALERT* 📈
*${plainSym}*
Current Price: *₹${entry.toFixed(2)}*
🎯 Target: *₹${target.toFixed(2)}* (+${TARGET_PCT}%)
🛑 Stop Loss: *₹${sl.toFixed(2)}* (-${slPct}% | ATR-based)
⚖️ Risk:Reward → *1 : ${riskReward}*
📊 Confidence: *${conf}/100* 🔥
📦 Volume: *${volRatio}x* avg (${(ind.currentVolume / 1000).toFixed(0)}K)
📐 RSI: *${ind.rsi.toFixed(1)}* | EMA9: ${ind.ema9.toFixed(2)} | EMA21: ${ind.ema21.toFixed(2)}
🔵 VWAP: *${ind.vwap.toFixed(2)}* | Price above VWAP ✅
📋 Reason: EMA9 crossed above EMA21 | EMA21 > EMA50 | Price > VWAP | RSI bullish | Volume surge
🕐 Time (IST): ${timeIST}
⚠️ _Trade at your own risk — Not financial advice!_
      `.trim();

      await sendTelegram(msg);

      // ── 12. Log to Google Sheets ──
      await logToSheet({
        TimeIST:       timeIST,
        Symbol:        plainSym,
        Direction:     "BUY",
        EntryPrice:    entry.toFixed(2),
        Target:        target.toFixed(2),
        StopLoss:      sl.toFixed(2),
        SLType:        `ATR x${ATR_MULTIPLIER}`,
        SLPct:         slPct,
        RiskReward:    riskReward,
        RSI:           ind.rsi.toFixed(1),
        EMA9:          ind.ema9.toFixed(2),
        EMA21:         ind.ema21.toFixed(2),
        EMA50:         ind.ema50.toFixed(2),
        VWAP:          ind.vwap.toFixed(2),
        VolumeCurrent: ind.currentVolume,
        VolumeAvg:     Math.round(ind.avgVolume),
        VolumeRatio:   volRatio,
        Plus2Check:    "PENDING",
        Confidence:    conf,
        RawTimeUTC:    new Date().toISOString()
      });

      alertCount++;
      console.log(`✅ Alert sent: ${plainSym} BUY | Conf ${conf} | SL ₹${sl.toFixed(2)} | Target ₹${target.toFixed(2)}`);

    } catch (e) {
      console.error(`❌ Error ${plainSym}: ${e.message}`);
    }
  }

  console.log(`\n✅ Scan complete — ${alertCount} alert(s) fired\n`);
}

/* ================= ENTRY POINT ================= */
await run();
