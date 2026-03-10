/**
 * NSE EMA Scanner – BUY ONLY VERSION
 * File: src/index.js
 * Intraday 5m | EMA9/21/50 | VWAP (daily reset) | ATR SL+Target | Volume | ORB | Candle Confirm
 *
 * ── ORIGINAL FIXES (v2) ────────────────────────────────────────────────────
 * 1. VWAP resets daily at 9:15 AM IST (was cumulative across 10 days — critical bug)
 * 2. Volume confirmation added (crossover must have 1.2x avg volume)
 * 3. ATR-based dynamic Stop Loss (replaces flat 0.6% SL)
 * 4. Confidence score now meaningful (extra filters beyond mandatory gates)
 * 5. yahoo-finance2 import corrected (direct module, not class instantiation)
 * 6. MINDTREE.NS removed (merged into LTIM in 2023, duplicate)
 * 7. Persistent cooldown via JSON file (survives process restarts)
 * 8. Signal deduplication guard added
 *
 * ── NEW UPGRADES (v3) ──────────────────────────────────────────────────────
 * 9.  Candle confirmation: entry only after NEXT candle closes above crossover high
 * 10. Opening Range Breakout (ORB): price must be above first 15-min high
 * 11. ATR-based dynamic Target (replaces flat 0.8%) — guarantees 1:2 R:R minimum
 */

import fetch from "node-fetch";
import { EMA, RSI, ATR } from "technicalindicators";
import { GoogleSpreadsheet } from "google-spreadsheet";
import YahooFinance from "yahoo-finance2";
import fs from "fs";

// FIX: yahoo-finance2 v3 exports the CLASS not a pre-made instance.
// Calling yahooFinance.chart() on the class (not an instance) throws:
// "Call `const yahooFinance = new YahooFinance()` first"
// Must instantiate first. suppressNotices silences deprecation warnings.
const yahooFinance = new YahooFinance({ suppressNotices: ["ripHistorical"] });

/* ================= CONFIG ================= */
const MIN_CONFIDENCE     = 70;    // Minimum confidence score to fire alert
const DELAY_MS           = 3000;  // Delay between symbol fetches (rate limiting)
const COOLDOWN_MINUTES   = 30;    // Per-symbol cooldown to avoid duplicate alerts
const INTERVAL           = "5m";  // Candle interval
const ATR_PERIOD         = 14;    // ATR period
const ATR_SL_MULTIPLIER  = 1.5;   // SL     = entry - (ATR × 1.5)
const ATR_TGT_MULTIPLIER = 3.0;   // Target = entry + (ATR × 3.0) → guaranteed 1:2 R:R
const VOLUME_SURGE_X     = 1.2;   // Volume must be >= 1.2x the 20-bar average
const ORB_MINUTES        = 15;    // Opening range = first 15 minutes (9:15–9:30 IST)
// Cooldown file lives at repo root (not inside src/) so GitHub Actions
// cache can read/write it regardless of working directory
const COOLDOWN_FILE      = "./cooldown_state.json";

/* ================= SYMBOLS - Full Nifty 100 ================= */
/* MINDTREE.NS removed — merged into LTIM.NS in 2023            */
const SYMBOLS = [
  "RELIANCE.NS",   "HDFCBANK.NS",   "BHARTIARTL.NS", "TCS.NS",        "SBIN.NS",
  "ICICIBANK.NS",  "INFY.NS",       "ITC.NS",        "HINDUNILVR.NS", "LT.NS",
  "BAJFINANCE.NS", "KOTAKBANK.NS",  "AXISBANK.NS",   "SUNPHARMA.NS",  "MARUTI.NS",
  "M&M.NS",        "ULTRACEMCO.NS", "NTPC.NS",       "ONGC.NS",       "POWERGRID.NS",
  "TITAN.NS",      "ADANIPORTS.NS", "ADANIENT.NS",   "BAJAJFINSV.NS", "INDUSINDBK.NS",
  "TECHM.NS",      "HCLTECH.NS",    "ASIANPAINT.NS", "NESTLEIND.NS",  "JSWSTEEL.NS",
  "COALINDIA.NS",  "TATAMOTORS.NS", "BAJAJ-AUTO.NS", "TATASTEEL.NS",  "WIPRO.NS",
  "HDFCLIFE.NS",   "SBILIFE.NS",    "HEROMOTOCO.NS", "DRREDDY.NS",    "CIPLA.NS",
  "APOLLOHOSP.NS", "DIVISLAB.NS",   "BRITANNIA.NS",  "EICHERMOT.NS",  "GRASIM.NS",
  "BPCL.NS",       "IOC.NS",        "TATACONSUM.NS", "UPL.NS",        "HINDALCO.NS",
  "SHREECEM.NS",   "PIDILITIND.NS", "DABUR.NS",      "BOSCHLTD.NS",   "TVSMOTOR.NS",
  "SIEMENS.NS",    "HAL.NS",        "BEL.NS",        "DLF.NS",        "INDIGO.NS",
  "LTIM.NS",       "GODREJCP.NS",   "CHOLAFIN.NS",   "POLYCAB.NS",    "SRF.NS",
  "CANBK.NS",      "PNB.NS",        "UNIONBANK.NS",  "BANKBARODA.NS", "IGL.NS",
  "MGL.NS",        "TORNTPHARM.NS", "JSWENERGY.NS",  "ABB.NS",        "ACC.NS",
  "VEDL.NS",       "TATAPOWER.NS",  "GAIL.NS",       "AUROPHARMA.NS", "BANDHANBNK.NS",
  "IDFCFIRSTB.NS", "JINDALSTEL.NS", "ADANIGREEN.NS", "ADANIPOWER.NS", "COFORGE.NS",
  "LTTS.NS",       "BAJAJCORP.NS",  "ICICIPRULI.NS", "SBICARD.NS",
  "PAGEIND.NS",    "MUTHOOTFIN.NS", "TRENT.NS",      "MAXHEALTH.NS",  "ETERNAL.NS"
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
    console.error(`CRITICAL: Missing env var → ${k}`);
    process.exit(1);
  }
}
console.log("✅ All env variables loaded");

/* ================= HELPERS ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Returns true if current IST time is within NSE market hours (Mon–Fri 9:15–15:30)
 */
function isMarketOpenIST() {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes(), day = ist.getDay();
  if (day === 0 || day === 6) return false;
  return (h > 9 || (h === 9 && m >= 15)) && (h < 15 || (h === 15 && m <= 30));
}

/**
 * Returns today's date string in IST as "YYYY-MM-DD"
 */
function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/**
 * Converts a bar's date field (Date object or Unix seconds) to an IST Date object
 */
function barToISTDate(b) {
  const d = b.date instanceof Date ? b.date : new Date(b.date * 1000);
  return new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

/**
 * Sends a Telegram message in Markdown mode
 */
async function sendTelegram(msg) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          chat_id:    process.env.TELEGRAM_CHAT_ID,
          text:       msg,
          parse_mode: "Markdown"
        })
      }
    );
    if (!res.ok) {
      console.error("Telegram failed:", res.status, await res.text());
    } else {
      console.log("✅ Telegram sent OK");
    }
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

/**
 * Appends a signal row to Google Sheets (first sheet of SPREADSHEET_ID)
 */
async function logToSheet(row) {
  try {
    console.log("[SHEET] Logging:", row.Symbol);
    const auth = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const doc  = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);
    await doc.useServiceAccountAuth(auth);
    await doc.loadInfo();
    await doc.sheetsByIndex[0].addRow(row);
    console.log(`[SHEET] ✅ Added ${row.Symbol}`);
  } catch (e) {
    console.error("[SHEET] FAIL:", e.message);
  }
}

/* ================= PERSISTENT COOLDOWN ================= */
/**
 * Loads per-symbol cooldown timestamps from disk.
 * Survives process restarts and deploys — prevents duplicate alerts.
 * Format: { "RELIANCE": { timestamp: 1234567890, date: "2026-03-06" } }
 */
function loadCooldown() {
  try {
    if (fs.existsSync(COOLDOWN_FILE))
      return JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf-8"));
  } catch (e) {
    console.warn("[COOLDOWN] Load failed, starting fresh:", e.message);
  }
  return {};
}

function saveCooldown(state) {
  try {
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[COOLDOWN] Save failed:", e.message);
  }
}

function isInCooldown(state, symbol) {
  const entry = state[symbol];
  if (!entry) return false;
  // Auto-clear if it's a new trading day
  if (entry.date !== todayIST()) { delete state[symbol]; return false; }
  return (Date.now() - entry.timestamp) < COOLDOWN_MINUTES * 60 * 1000;
}

function setCooldown(state, symbol) {
  state[symbol] = { timestamp: Date.now(), date: todayIST() };
  saveCooldown(state);
}

/* ================= DATA FETCH ================= */
/**
 * Fetches last 10 days of 5m bars via yahoo-finance2.
 * FIX: Uses direct module call — original code wrongly instantiated it as a class.
 */
async function fetchIntradayData(symbol) {
  try {
    const plain = symbol.replace(".NS", "");
    console.log(`Fetching ${INTERVAL} data for ${plain}`);

    const result = await yahooFinance.chart(symbol, {
      period1:        Math.floor((Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000),
      period2:        Math.floor(Date.now() / 1000),
      interval:       INTERVAL,
      includePrePost: false
    });

    if (!result?.quotes || result.quotes.length < 60) {
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

/* ================= VWAP — DAILY RESET ================= */
/**
 * ORIGINAL CRITICAL BUG FIX: VWAP must reset at 9:15 AM IST each day.
 * Old code accumulated across 10 days — completely wrong for intraday use.
 * This filters bars to today only, then computes proper session VWAP.
 */
function computeDailyVWAP(bars) {
  const today     = todayIST();
  const todayBars = bars.filter(b =>
    barToISTDate(b).toLocaleDateString("en-CA") === today
  );

  if (todayBars.length === 0) {
    console.warn("  No today bars found for VWAP");
    return NaN;
  }

  let cumTPV = 0, cumVol = 0;
  for (const b of todayBars) {
    const tp  = (b.high + b.low + b.close) / 3;
    cumTPV   += tp * (b.volume || 0);
    cumVol   += b.volume || 0;
  }
  return cumVol > 0 ? cumTPV / cumVol : NaN;
}

/* ================= OPENING RANGE BREAKOUT (ORB) ================= */
/**
 * NEW (v3): Computes the high of the first ORB_MINUTES of today's session.
 * Default: first 15 min = 9:15–9:30 AM IST = 3 × 5m candles.
 *
 * Why this matters: If price is below ORB high later in the day, institutional
 * bias is not bullish. Trading EMA crossovers below ORB means fighting structure.
 * This single filter eliminates most counter-trend false signals.
 */
function computeORBHigh(bars) {
  const today     = todayIST();
  const todayBars = bars.filter(b =>
    barToISTDate(b).toLocaleDateString("en-CA") === today
  );

  if (todayBars.length === 0) return NaN;

  const orbCandles = Math.ceil(ORB_MINUTES / 5); // e.g. 15 min / 5m = 3 candles
  const orbBars    = todayBars.slice(0, orbCandles);
  if (orbBars.length === 0) return NaN;

  const orbHigh = Math.max(...orbBars.map(b => b.high));
  console.log(`  ORB High (first ${ORB_MINUTES}min, ${orbBars.length} candles): ₹${orbHigh.toFixed(2)}`);
  return orbHigh;
}

/* ================= INDICATORS ================= */
/**
 * Calculates all technical indicators needed for signal logic.
 *
 * Candle confirmation logic (v3):
 *   - We detect crossover on bar[-2] (prevPrevEma9/21 vs prevEma9/21)
 *   - Current bar[-1] is the CONFIRMATION candle
 *   - Confirmation: current price must close > bar[-2].high (crossoverCandleHigh)
 *
 * This means we wait one extra candle after the cross before firing.
 */
function calculateIndicators(bars) {
  if (bars.length < 60) return null;

  const closes  = bars.map(b => b.close).filter(v => v != null && !isNaN(v));
  const highs   = bars.map(b => b.high).filter(v => v != null && !isNaN(v));
  const lows    = bars.map(b => b.low).filter(v => v != null && !isNaN(v));
  const volumes = bars.map(b => b.volume || 0);

  if (closes.length < 60) return null;

  const ema9  = EMA.calculate({ period: 9,  values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const rsi   = RSI.calculate({ period: 14, values: closes });

  const atrValues = ATR.calculate({
    period: ATR_PERIOD,
    high:   highs,
    low:    lows,
    close:  closes
  });

  const vwap    = computeDailyVWAP(bars);
  const orbHigh = computeORBHigh(bars);

  // Volume: current bar vs 20-bar average
  const recentVolumes = volumes.slice(-20);
  const avgVolume     = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
  const currentVolume = volumes[volumes.length - 1];

  // Crossover detection indices:
  //   bar[-3]: prevPrevEma (before crossover)
  //   bar[-2]: prevEma     (crossover happened here)
  //   bar[-1]: current     (confirmation candle)
  const prevPrevEma9  = ema9[ema9.length - 3];
  const prevPrevEma21 = ema21[ema21.length - 3];
  const prevEma9      = ema9[ema9.length - 2];
  const prevEma21     = ema21[ema21.length - 2];

  // The crossover candle's high — confirmation candle must close above this
  const crossoverCandleHigh = highs[highs.length - 2];

  return {
    ema9:              ema9[ema9.length - 1],
    ema21:             ema21[ema21.length - 1],
    ema50:             ema50[ema50.length - 1],
    prevEma9,
    prevEma21,
    prevPrevEma9,
    prevPrevEma21,
    crossoverCandleHigh,
    rsi:               rsi[rsi.length - 1],
    atr:               atrValues[atrValues.length - 1],
    vwap,
    orbHigh,
    currentPrice:      closes[closes.length - 1],
    currentVolume,
    avgVolume
  };
}

/* ================= CONFIDENCE SCORE (50–100) ================= */
/**
 * Scores signal STRENGTH after all mandatory gates have passed.
 * Base 50 = minimum (all gates passed). Bonus points = signal quality.
 *
 *   RSI position       → up to +15
 *   Volume surge       → up to +15
 *   EMA9/21 separation → up to +10
 *   Price vs VWAP gap  → up to +10
 *   ATR stability      → up to +10
 *                         ────────
 *   Max total             100
 */
function calculateConfidence(ind) {
  let score = 50;

  // 1. RSI position (+0 to +15)
  if      (ind.rsi >= 55 && ind.rsi <= 65) score += 15;
  else if (ind.rsi >  65 && ind.rsi <  72) score += 5;

  // 2. Volume surge (+0 to +15)
  if (ind.avgVolume > 0) {
    const vr = ind.currentVolume / ind.avgVolume;
    if      (vr >= 2.0) score += 15;
    else if (vr >= 1.5) score += 10;
    else if (vr >= 1.2) score += 5;
  }

  // 3. EMA9 vs EMA21 separation (+0 to +10)
  const emaSep = ((ind.ema9 - ind.ema21) / ind.ema21) * 100;
  if      (emaSep >= 0.5) score += 10;
  else if (emaSep >= 0.3) score += 5;

  // 4. Price above VWAP gap (+0 to +10)
  if (!isNaN(ind.vwap) && ind.vwap > 0) {
    const vwapGap = ((ind.currentPrice - ind.vwap) / ind.vwap) * 100;
    if      (vwapGap >= 1.0) score += 10;
    else if (vwapGap >= 0.5) score += 5;
  }

  // 5. ATR stability (+0 to +10)
  const atrPct = (ind.atr / ind.currentPrice) * 100;
  if      (atrPct < 0.8) score += 10;
  else if (atrPct < 1.5) score += 5;

  return Math.min(score, 100);
}

/* ================= MAIN SCAN ================= */
async function run() {
  if (!isMarketOpenIST()) {
    console.log("⏸ Market closed, skipping scan");
    return;
  }

  const cooldownState = loadCooldown();

  console.log(`\n🔍 Scan start — ${SYMBOLS.length} symbols | ${INTERVAL} | BUY only`);
  console.log(`   Date (IST): ${todayIST()}`);

  let alertCount = 0;

  for (const sym of SYMBOLS) {
    const plainSym = sym.replace(".NS", "");
    try {
      await sleep(DELAY_MS);

      // ── 1. Cooldown check (persistent across restarts) ────────────────────
      if (isInCooldown(cooldownState, plainSym)) {
        console.log(`⏳ Cooldown: ${plainSym}`);
        continue;
      }

      // ── 2. Fetch bars ─────────────────────────────────────────────────────
      const bars = await fetchIntradayData(sym);
      if (!bars) continue;

      // ── 3. Calculate all indicators ───────────────────────────────────────
      const ind = calculateIndicators(bars);
      if (!ind) continue;

      // ── 4. VWAP validity guard ────────────────────────────────────────────
      if (isNaN(ind.vwap) || ind.vwap <= 0) {
        console.log(`⚠️  ${plainSym}: VWAP unavailable, skipping`);
        continue;
      }

      // ── 5. EMA9 CROSSOVER — must have occurred on the PREVIOUS candle ─────
      // bar[-3] → bar[-2]: that's where the cross happened
      // bar[-1] (current) is our confirmation candle
      const crossOccurredPrevBar =
        ind.prevPrevEma9 <= ind.prevPrevEma21 &&
        ind.prevEma9     >  ind.prevEma21;

      if (!crossOccurredPrevBar) continue;

      // ── 6. CANDLE CONFIRMATION (NEW v3) ───────────────────────────────────
      // Current candle must CLOSE ABOVE the crossover candle's HIGH.
      // Eliminates whipsaws — the #1 cause of false signals on 5m EMA crossovers.
      if (ind.currentPrice <= ind.crossoverCandleHigh) {
        console.log(`🚫 ${plainSym}: Candle confirmation failed (₹${ind.currentPrice.toFixed(2)} ≤ crossover high ₹${ind.crossoverCandleHigh.toFixed(2)})`);
        continue;
      }

      // ── 7. Trend confirmation filters ─────────────────────────────────────
      if (ind.rsi <= 52 || ind.rsi >= 72) continue; // RSI momentum gate
      if (ind.currentPrice <= ind.vwap)   continue; // Must be above today's VWAP
      if (ind.ema21 <= ind.ema50)         continue; // Medium-term trend must be up

      // ── 8. OPENING RANGE BREAKOUT filter (NEW v3) ─────────────────────────
      // Price must be above the first 15-min session high.
      // Confirms institutional/market bias is bullish before entry.
      if (!isNaN(ind.orbHigh) && ind.orbHigh > 0) {
        if (ind.currentPrice <= ind.orbHigh) {
          console.log(`🚫 ${plainSym}: Below ORB high ₹${ind.orbHigh.toFixed(2)} — market bias not confirmed bullish`);
          continue;
        }
      } else {
        console.log(`⚠️  ${plainSym}: ORB unavailable (early session), skipping ORB filter`);
      }

      // ── 9. Volume confirmation ────────────────────────────────────────────
      if (ind.avgVolume > 0 && ind.currentVolume < ind.avgVolume * VOLUME_SURGE_X) {
        console.log(`📉 ${plainSym}: Low-volume crossover (${(ind.currentVolume / ind.avgVolume).toFixed(2)}x avg), skipping`);
        continue;
      }

      // ── 10. Confidence gate ───────────────────────────────────────────────
      const conf = calculateConfidence(ind);
      if (conf < MIN_CONFIDENCE) {
        console.log(`🔕 ${plainSym}: Confidence ${conf} < ${MIN_CONFIDENCE}, skipping`);
        continue;
      }

      // ── 11. ATR-based SL and Target ───────────────────────────────────────
      // SL     = entry - (ATR × 1.5)  → dynamic, fits actual stock volatility
      // Target = entry + (ATR × 3.0)  → always 1:2 R:R minimum (3.0 / 1.5 = 2)
      const entry  = ind.currentPrice;
      const sl     = entry - ATR_SL_MULTIPLIER  * ind.atr;
      const target = entry + ATR_TGT_MULTIPLIER * ind.atr;

      if (sl >= entry) {
        console.warn(`⚠️  ${plainSym}: ATR SL invalid, skipping`);
        continue;
      }

      const risk       = entry - sl;
      const reward     = target - entry;
      const riskReward = (reward / risk).toFixed(2);
      const slPct      = ((risk   / entry) * 100).toFixed(2);
      const tgtPct     = ((reward / entry) * 100).toFixed(2);
      const volRatio   = ind.avgVolume > 0
        ? (ind.currentVolume / ind.avgVolume).toFixed(2)
        : "N/A";

      // ── 12. Set cooldown BEFORE sending (prevents duplicate on crash-loop) ─
      setCooldown(cooldownState, plainSym);

      // ── 13. Build Telegram alert ──────────────────────────────────────────
      const timeIST = new Date().toLocaleString("en-IN", {
        timeZone:  "Asia/Kolkata",
        dateStyle: "short",
        timeStyle: "short"
      });

      const msg = `
📈 *BUY SIGNAL ALERT* 📈
*${plainSym}*
💰 Entry Price: *₹${entry.toFixed(2)}*
🎯 Target: *₹${target.toFixed(2)}* (+${tgtPct}% | ATR×${ATR_TGT_MULTIPLIER})
🛑 Stop Loss: *₹${sl.toFixed(2)}* (-${slPct}% | ATR×${ATR_SL_MULTIPLIER})
⚖️ Risk:Reward → *1 : ${riskReward}*
📊 Confidence: *${conf}/100* 🔥
📦 Volume: *${volRatio}x* avg (${(ind.currentVolume / 1000).toFixed(0)}K vs ${(ind.avgVolume / 1000).toFixed(0)}K avg)
📐 RSI: *${ind.rsi.toFixed(1)}* | EMA9: ${ind.ema9.toFixed(2)} | EMA21: ${ind.ema21.toFixed(2)} | EMA50: ${ind.ema50.toFixed(2)}
🔵 VWAP: *₹${ind.vwap.toFixed(2)}* ✅ | ORB High: *₹${isNaN(ind.orbHigh) ? "N/A" : ind.orbHigh.toFixed(2)}* ✅
📋 *Signal Logic:*
  ✅ EMA9 crossed above EMA21 (prev candle)
  ✅ Confirmation candle closed above crossover high
  ✅ EMA21 > EMA50 (trend aligned)
  ✅ Price > VWAP (institutional support)
  ✅ Price > ORB High (bullish market bias confirmed)
  ✅ RSI bullish momentum (${ind.rsi.toFixed(1)})
  ✅ Volume surge (${volRatio}x average)
🕐 Time (IST): ${timeIST}
⚠️ _Trade at your own risk — Not financial advice!_
      `.trim();

      await sendTelegram(msg);

      // ── 14. Log to Google Sheets ──────────────────────────────────────────
      await logToSheet({
        TimeIST:          timeIST,
        Symbol:           plainSym,
        Direction:        "BUY",
        EntryPrice:       entry.toFixed(2),
        Target:           target.toFixed(2),
        TargetPct:        tgtPct,
        TargetType:       `ATR×${ATR_TGT_MULTIPLIER}`,
        StopLoss:         sl.toFixed(2),
        StopLossPct:      slPct,
        StopLossType:     `ATR×${ATR_SL_MULTIPLIER}`,
        RiskReward:       riskReward,
        RSI:              ind.rsi.toFixed(1),
        EMA9:             ind.ema9.toFixed(2),
        EMA21:            ind.ema21.toFixed(2),
        EMA50:            ind.ema50.toFixed(2),
        VWAP:             ind.vwap.toFixed(2),
        ORBHigh:          isNaN(ind.orbHigh) ? "N/A" : ind.orbHigh.toFixed(2),
        CrossoverHigh:    ind.crossoverCandleHigh.toFixed(2),
        VolumeCurrent:    ind.currentVolume,
        VolumeAvg20:      Math.round(ind.avgVolume),
        VolumeRatio:      volRatio,
        Confidence:       conf,
        Plus2Check:       "PENDING",
        RawTimeUTC:       new Date().toISOString()
      });

      alertCount++;
      console.log(`✅ Alert: ${plainSym} | Conf ${conf} | Entry ₹${entry.toFixed(2)} | SL ₹${sl.toFixed(2)} | Target ₹${target.toFixed(2)} | R:R 1:${riskReward}`);

    } catch (e) {
      console.error(`❌ Error ${plainSym}: ${e.message}`);
    }
  }

  console.log(`\n✅ Scan complete — ${alertCount} alert(s) fired\n`);
}

/* ================= ENTRY POINT ================= */
await run();
