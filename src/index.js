import { CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";

// ======================================================
// 📊 GLOBAL SIMULATION TRACKER
// ======================================================
let simStats = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  lastMarketId: null,
  activeTrade: null // { side: 'UP'|'DOWN', priceToBeat: 0, marketId: '' }
};

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

applyGlobalProxyFromEnv();

function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  lightRed: "\x1b[91m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m",
  bold: "\x1b[1m"
};

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

function sepLine(ch = "─") {
  const w = screenWidth();
  return `${ANSI.white}${ch.repeat(w)}${ANSI.reset}`;
}

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch {
    // ignore
  }
  process.stdout.write(text);
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function padLabel(label, width) {
  const visible = stripAnsi(label).length;
  if (visible >= width) return label;
  return label + " ".repeat(width - visible);
}

function centerText(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

const LABEL_W = 16;
function kv(label, value) {
  const l = padLabel(String(label), LABEL_W);
  return `${l}${value}`;
}

function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }

  const p = Number(price);
  const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);

  let color = ANSI.reset;
  let arrow = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    if (p > prev) {
      color = ANSI.green;
      arrow = " ↑";
    } else {
      color = ANSI.red;
      arrow = " ↓";
    }
  }

  const formatted = `${prefix}${formatNumber(p, decimals)}`;
  return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}

function formatSignedDelta(delta, base) {
  if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const pct = (Math.abs(delta) / Math.abs(base)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`;
}

function colorByNarrative(text, narrative) {
  if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
  if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

function formatNarrativeValue(label, value, narrative) {
  return `${label}: ${colorByNarrative(value, narrative)}`;
}

function narrativeFromSign(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return "NEUTRAL";
  return Number(x) > 0 ? "LONG" : "SHORT";
}

function narrativeFromSlope(slope) {
  if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL";
  return Number(slope) > 0 ? "LONG" : "SHORT";
}

function formatProbPct(p, digits = 0) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-";
  return `${(Number(p) * 100).toFixed(digits)}%`;
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  } catch {
    return "-";
  }
}

function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;

  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

function parsePriceToBeat(market) {
  const text = String(market?.question ?? market?.title ?? "");
  if (!text) return null;
  const m = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const dumpedMarkets = new Set();

function safeFileSlug(x) {
  return String(x ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

function extractNumericFromMarket(market) {
  const directKeys = [
    "priceToBeat", "price_to_beat", "strikePrice", "strike_price", "strike", "threshold", 
    "thresholdPrice", "threshold_price", "targetPrice", "target_price", "referencePrice", "reference_price"
  ];

  for (const k of directKeys) {
    const v = market?.[k];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  if (!CONFIG.polymarket.autoSelectLatest) return null;
  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  return pickLatestLiveMarket(flattenEventMarkets(events));
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtc15mMarket();
  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

  return {
    ok: true,
    market,
    prices: {
      up: Number(outcomePrices[0]) || null,
      down: Number(outcomePrices[1]) || null
    }
  };
}

async function main() {
  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});

  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };

  const header = [
    "timestamp", "entry_minute", "time_left_min", "regime", "signal",
    "model_up", "model_down", "mkt_up", "mkt_down", "edge_up", "edge_down", "recommendation"
  ];

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    const wsTick = binanceStream.getLast();
    const wsPrice = wsTick?.price ?? null;
    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;
    const chainlinkWsTick = chainlinkStream.getLast();
    const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

    try {
      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const [klines1m, klines5m, lastPrice, chainlink, poly] = await Promise.all([
        fetchKlines({ interval: "1m", limit: 240 }),
        fetchKlines({ interval: "5m", limit: 200 }),
        fetchLastPrice(),
        chainlinkPromise,
        fetchPolymarketSnapshot()
      ]);

      const currentPrice = chainlink?.price ?? null;
      const spotPrice = wsPrice ?? lastPrice;
      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      const candles = klines1m;
      const closes = candles.map((c) => c.close);

      // Indicators
      const vwapNow = computeVwapSeries(candles).slice(-1)[0];
      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = closes.map((_, i) => computeRsi(closes.slice(0, i + 1), CONFIG.rsiPeriod)).filter(x => x !== null);
      const rsiSlope = slopeLast(rsiSeries, 3);
      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);
      const ha = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const lastClose = closes[closes.length - 1];
      const delta1m = lastClose - closes[closes.length - 2];
      const delta3m = lastClose - closes[closes.length - 4];

      const scored = scoreDirection({
        price: lastPrice, vwap: vwapNow, rsi: rsiNow, rsiSlope, macd,
        heikenColor: consec.color, heikenCount: consec.count
      });

      const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);
      const marketUp = poly.ok ? poly.prices.up : null;
      const marketDown = poly.ok ? poly.prices.down : null;
      const rec = decide({ remainingMinutes: timeLeftMin, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown });
      const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });

      // --- SIMULATION LOGIC ---
      const currentMarketId = poly.ok ? (poly.market?.id || poly.market?.slug) : null;
      if (simStats.lastMarketId && currentMarketId !== simStats.lastMarketId) {
          if (simStats.activeTrade) {
              const won = simStats.activeTrade.side === "UP" 
                  ? (currentPrice > simStats.activeTrade.priceToBeat)
                  : (currentPrice < simStats.activeTrade.priceToBeat);
              if (won) simStats.wins++; else simStats.losses++;
              simStats.activeTrade = null;
          }
          simStats.lastMarketId = currentMarketId;
      }

      // --- STRATEGY ENGINE CALL ---
      const aiRec = getStrategyAction(rsiNow, delta1m, delta3m, consec.color, timeLeftMin, timeAware.adjustedUp, timeAware.adjustedDown, marketUp, marketDown, spotPrice, currentPrice);

      // Record sim entry
      if (!simStats.activeTrade && currentMarketId && priceToBeatState.value !== null) {
          if (aiRec.includes("STRONG LONG")) {
              simStats.activeTrade = { side: "UP", priceToBeat: priceToBeatState.value, marketId: currentMarketId };
              simStats.totalTrades++;
          } else if (aiRec.includes("STRONG SHORT")) {
              simStats.activeTrade = { side: "DOWN", priceToBeat: priceToBeatState.value, marketId: currentMarketId };
              simStats.totalTrades++;
          }
      }
      const winRate = simStats.totalTrades > 0 ? ((simStats.wins / (simStats.wins + simStats.losses || 1)) * 100).toFixed(1) : "0.0";

      // Narratives
      const haNarrative = (consec.color ?? "").toLowerCase() === "green" ? "LONG" : "SHORT";
      const predictValue = `${ANSI.green}LONG ${formatProbPct(timeAware.adjustedUp)}${ANSI.reset} / ${ANSI.red}SHORT ${formatProbPct(timeAware.adjustedDown)}${ANSI.reset}`;
      const heikenLine = formatNarrativeValue("Heiken Ashi", `${consec.color} x${consec.count}`, haNarrative);
      const rsiLine = formatNarrativeValue("RSI", `${formatNumber(rsiNow, 1)}`, narrativeFromSlope(rsiSlope));

      // Market Management
      const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";
      if (marketSlug && priceToBeatState.slug !== marketSlug) priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
      if (priceToBeatState.slug && priceToBeatState.value === null && currentPrice !== null) {
          priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: Date.now() };
      }
      const priceToBeat = priceToBeatState.value;

      // Current Price Delta logic
      const ptbDelta = (currentPrice !== null && priceToBeat !== null) ? currentPrice - priceToBeat : null;
      const ptbDeltaText = ptbDelta === null ? "-" : `${ptbDelta > 0 ? "+" : ""}$${ptbDelta.toFixed(2)}`;
      
      const binanceSpotBaseLine = colorPriceLine({ label: "BTC (Binance)", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" });
      const polyHeaderValue = `${ANSI.green}↑ UP ${marketUp ?? "-"}¢${ANSI.reset}  |  ${ANSI.red}↓ DOWN ${marketDown ?? "-"}¢${ANSI.reset}`;

      // --- UI RENDERING ---
      const lines = [
        centerText(`${ANSI.white}${ANSI.bold}🚀 POLYBOT PRO TERMINAL${ANSI.reset}`, screenWidth()),
        sepLine("="),
        kv("Market:", poly.ok ? (poly.market?.slug ?? "-") : "-"),
        kv("Time left:", `${timeLeftMin >= 5 ? ANSI.green : ANSI.red}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`),
        "",
        centerText(`${ANSI.white}${ANSI.bold}📊 SIMULATION PERFORMANCE${ANSI.reset}`, screenWidth()),
        kv("Win Rate:", `${ANSI.green}${winRate}%${ANSI.reset} (${simStats.wins}W - ${simStats.losses}L)`),
        kv("Status:", simStats.activeTrade ? `${ANSI.green}IN TRADE (${simStats.activeTrade.side})${ANSI.reset}` : `${ANSI.gray}SCANNING...${ANSI.reset}`),
        sepLine(),
        kv("AI ACTION:", aiRec),
        kv("TA Predict:", predictValue),
        kv("Heiken Ashi:", heikenLine.split(": ")[1]),
        kv("RSI:", rsiLine.split(": ")[1]),
        kv("Delta 1/3:", `${formatSignedDelta(delta1m, lastClose)} | ${formatSignedDelta(delta3m, lastClose)}`),
        sepLine(),
        kv("POLYMARKET:", polyHeaderValue),
        kv("PRICE TO BEAT:", `$${formatNumber(priceToBeat, 0)}`),
        kv("CURRENT PRICE:", `$${formatNumber(currentPrice, 2)} (${ptbDeltaText})`),
        sepLine(),
        kv("BTC Binance:", `$${formatNumber(spotPrice, 0)}`),
        kv("Price Gap:", `${(spotPrice - currentPrice).toFixed(2)} USD`),
        sepLine(),
        kv("ET Time:", `${fmtEtTime()} | ${getBtcSession()}`),
        centerText(`${ANSI.dim}created by @krajekis${ANSI.reset}`, screenWidth())
      ];

      renderScreen(lines.join("\n") + "\n");

      prevSpotPrice = spotPrice;
      prevCurrentPrice = currentPrice;

      appendCsvRow("./logs/signals.csv", header, [
        new Date().toISOString(), timing.elapsedMinutes.toFixed(3), timeLeftMin.toFixed(3),
        detectRegime({price: lastPrice, vwap: vwapNow}).regime,
        rec.action === "ENTER" ? `${rec.side}` : "NO_TRADE",
        timeAware.adjustedUp, timeAware.adjustedDown, marketUp, marketDown, edge.edgeUp, edge.edgeDown,
        rec.action === "ENTER" ? `${rec.side}:${rec.phase}` : "NO_TRADE"
      ]);
    } catch (err) {
      console.log(`Error: ${err?.message ?? String(err)}`);
    }
    await sleep(CONFIG.pollIntervalMs);
  }
}

// ======================================================
// 🧠 AI STRATEGY ENGINE 
// ======================================================
function getStrategyAction(rsi, delta1, delta3, haColor, timeLeft, pUp, pDown, mktUp, mktDown, spot, clPrice) {
    const RED = "\x1b[31m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m";
    const CYAN = "\x1b[36m", RESET = "\x1b[0m", BOLD = "\x1b[1m";

    const gap = spot - clPrice;

    // 1. LOCK-IN DETECTION
    if (timeLeft !== null && timeLeft <= 2.0) {
        if (pUp >= 0.98 || mktUp >= 0.98) return `${GREEN}${BOLD}🔒 LOCKED: UP (UNSTOPPABLE)${RESET}`;
        if (pDown >= 0.98 || mktDown >= 0.98) return `${RED}${BOLD}🔒 LOCKED: DOWN (UNSTOPPABLE)${RESET}`;
        if (timeLeft <= 0.5 && (mktUp > 0.95 || mktDown > 0.95)) return `${YELLOW}${BOLD}🏁 FINALIZED${RESET}`;
    }

    // 2. ARBITRAGE SIGNAL
    if (gap > 25) return `${GREEN}${BOLD}💰 ARB: LONG (Binance Lead)${RESET}`;
    if (gap < -25) return `${RED}${BOLD}💰 ARB: SHORT (Binance Lead)${RESET}`;

    const d1 = Number(delta1) || 0;
    const d3 = Number(delta3) || 0;
    const haGreen = String(haColor).toLowerCase().includes('green');
    const haRed = String(haColor).toLowerCase().includes('red');

    // 3. TREND FOLLOWING
    if (d1 > 0 && d3 > 0 && haGreen && rsi < 70) return `${GREEN}${BOLD}🚀 STRONG LONG (Trend)${RESET}`;
    if (d1 < 0 && d3 < 0 && haRed && rsi > 30) return `${RED}${BOLD}🩸 STRONG SHORT (Trend)${RESET}`;

    // 4. SNIPER REVERSALS
    if (rsi > 70 && d1 < 0 && haRed) return `${RED}${BOLD}🎯 SNIPER SHORT (Top)${RESET}`;
    if (rsi < 30 && d1 > 0 && haGreen) return `${GREEN}${BOLD}🎯 SNIPER LONG (Bottom)${RESET}`;

    // 5. CHOPPY
    if ((d1 > 0 && d3 < 0) || (d1 < 0 && d3 > 0)) return `${YELLOW}✋ WAIT (Choppy/Mixed)${RESET}`;
    
    return `${CYAN}💤 MONITORING...${RESET}`;
}

main();