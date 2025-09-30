// index.ts
import "dotenv/config";
import { Client, GatewayIntentBits, TextChannel } from "discord.js";
import cron from "node-cron";
import { breakdownEmbed } from "./embeds.js";
import { BybitPublicTradesWS } from "./bybit-ws.js";
import { FiveMinAggregator, FiveMinResult } from "./helpers/aggregator-5m.js";
import { fetchBybitKline5mVolume } from "./helpers/bybit-kline.js";

// Redis utils
import {
  redisClient,
  listReplaceHeadIfSameTs,
  listLen,
  setJSON,
  getJSON,
  CAPACITY,
} from "./helpers/redis.js";
import {
  closeAlertsCsv,
  initAlertsCsv,
  logAlertCsv,
} from "./helpers/csv-logger.js";

import { getPOILevels, ingestCandlePOI } from "./helpers/poi-tracker.js";
import {
  loadPOIFromRedis,
  loadPOIFromREST,
  savePOIToRedis,
} from "./helpers/poi-redis.js";
import {
  atrGateOk,
  atrStopKeyTf,
  AtrStopState,
  loadAtrState,
  saveAtrState,
  updateAtrTrailingStop,
  updateAtrWithTrBuffer,
} from "./helpers/atr-redis.js";
import { classifyCandle } from "./helpers/candle-identifier.js";

const TOKEN = process.env.DISCORD_TOKEN!;
const CHANNEL_IDS = (process.env.CHANNEL_IDS ?? process.env.CHANNEL_ID ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CURRENCY = (process.env.CURRENCY || "usdt").toLowerCase();

// TIER B RATIO
const RVOL_RATIO_TIER_B = Number(process.env.RVOL_RATIO_TIER_B ?? 1.5);
const RDELTA_RATIO_TIER_B = Number(process.env.RDELTA_RATIO_TIER_B ?? 1.5);
const OI_CHANGE_RATIO_TIER_B = Number(
  process.env.OI_CHANGE_RATIO_TIER_B ?? 1.5
);

// TIER A RATIO
const RVOL_RATIO_TIER_A = Number(process.env.RVOL_RATIO_TIER_A ?? 2.5);
const RDELTA_RATIO_TIER_A = Number(process.env.RDELTA_RATIO_TIER_A ?? 2);
const OI_CHANGE_RATIO_TIER_A = Number(
  process.env.OI_CHANGE_RATIO_TIER_A ?? 2.5
);

// TIER S RATIO
const RVOL_RATIO_TIER_S = Number(process.env.RVOL_RATIO_TIER_S ?? 3.5);
const RDELTA_RATIO_TIER_S = Number(process.env.RDELTA_RATIO_TIER_S ?? 3);
const OI_CHANGE_RATIO_TIER_S = Number(process.env.OI_CHANGE_RATIO_TIER_S ?? 3);

// HISTORY & COOLDOWN
const ALERT_MIN_COUNT = Number(process.env.ALERT_MIN_COUNT ?? 20);
const ALERT_COOLDOWN_SEC = Number(process.env.ALERT_COOLDOWN_SEC ?? 300);

// NEAR-LEVEL THRESHOLD (persen)
const NEAR_LEVEL_PCT = Number(process.env.NEAR_LEVEL_PCT ?? 0.4);

//ATR
const ATR_PERIOD = Number(process.env.ATR_PERIOD ?? 5);

const symbols = (process.env.SYMBOLS?.split(",").map((s) =>
  s.trim().toUpperCase()
) || ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "FARTCOINUSDT"]) as string[];

const TIMEFRAMES = (process.env.TIMEFRAMES?.split(",").map((s) =>
  Number(s.trim())
) || [5, 15, 30]) as number[]; // menit

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN in .env");
if (!CHANNEL_IDS) throw new Error("Missing CHANNEL_ID in .env");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function fetchTextChannels(ids: string[]) {
  const channels: TextChannel[] = [];
  for (const id of ids) {
    const ch = await client.channels.fetch(id);
    if (!ch || !ch.isTextBased()) {
      throw new Error(`Channel ${id} bukan text channel`);
    }
    channels.push(ch as TextChannel);
  }
  return channels;
}

// cache lokal buat embed rutin
const lastAgg = new Map<string, FiveMinResult>();

// cooldown gabungan (satu map untuk rule AND)
const lastAlertAt = new Map<string, number>();

type Direction = "bullish" | "bearish";
type Tier = "B" | "A" | "S";

const tfLabel = (tf: number) => `${tf}M`;
const aggKeyTf = (symbol: string, tf: number) => `agg:${tf}m:${symbol}`;
const aggAvgKeyTf = (symbol: string, tf: number) => `aggavg:${tf}m:${symbol}`;

// helper: kirim embed alert gabungan (DITAMBAH poi) — ATR dihapus
async function sendCombinedAlert(
  channels: TextChannel[],
  tf: number,
  symbol: string,
  snapshot: FiveMinResult,
  ratios: { rvol: number; rdelta: number; roi: number },
  dir: Direction,
  tier: Tier,
  poi?: { label: string; price: number; distancePct: number },
  priceATR?: number,
  atrMode?: "long" | "short",
  candleType?:
    | "Green Pinbar"
    | "Red Pinbar"
    | "Green Inverted Pinbar"
    | "Red Inverted Pinbar"
) {
  const currentVol =
    (snapshot.tradeVolume ?? 0) ||
    (snapshot.buyVol ?? 0) + (snapshot.sellVol ?? 0);

  const oiNote = inferOiNote(snapshot.delta, snapshot.oiChange);
  const liqNote = inferLiqNote(
    snapshot.open,
    snapshot.close ?? snapshot.lastPrice,
    snapshot.liquidationBuyVol,
    snapshot.liquidationSellVol
  );

  const embed = breakdownEmbed(
    {
      symbol,
      timeframe: tfLabel(tf),
      price: snapshot.lastPrice ?? 0,

      rvol: ratios.rvol,
      currentVol,

      delta: snapshot.delta ?? 0,
      rdelta: ratios.rdelta,

      oi: snapshot.oiChange ?? 0,
      roi: ratios.roi,

      liq: snapshot.liquidationVol ?? 0,

      direction: dir,
      tier,
      oiNote,
      liqNote,
      interpretation: tierInterpretation(dir, tier),

      poiLabel: poi?.label,
      poiPrice: poi?.price,
      poiDistancePct: poi?.distancePct,

      priceATR,
      atrMode,
      candleType,
    },
    CURRENCY
  );

  await Promise.allSettled(channels.map((ch) => ch.send({ embeds: [embed] })));
}

function pickTier(rvol: number, rdelta: number, roi: number): Tier | null {
  if (
    rvol >= RVOL_RATIO_TIER_S &&
    rdelta >= RDELTA_RATIO_TIER_S &&
    roi >= OI_CHANGE_RATIO_TIER_S
  )
    return "S";
  if (
    rvol >= RVOL_RATIO_TIER_A &&
    rdelta >= RDELTA_RATIO_TIER_A &&
    roi >= OI_CHANGE_RATIO_TIER_A
  )
    return "A";
  if (
    rvol >= RVOL_RATIO_TIER_B &&
    rdelta >= RDELTA_RATIO_TIER_B &&
    roi >= OI_CHANGE_RATIO_TIER_B
  )
    return "B";
  return null;
}

function tierInterpretation(dir: Direction, tier: Tier): string {
  if (dir === "bullish") {
    return tier === "S"
      ? "Decisive breakout — high probability continuation"
      : tier === "A"
      ? "Strong breakout — watch for continuation"
      : "Early breakout — confirmation required";
  } else {
    return tier === "S"
      ? "Decisive breakdown — high probability continuation"
      : tier === "A"
      ? "Strong breakdown — watch for continuation"
      : "Early breakdown — confirmation required";
  }
}

function inferDirection(delta: number): Direction {
  return (delta ?? 0) >= 0 ? "bullish" : "bearish";
}

// OI note (new/closing) — pakai delta signed & oiChange signed
function inferOiNote(
  delta: number | undefined,
  oiChange: number | undefined
): string {
  const d = delta ?? 0;
  const oi = oiChange ?? 0;

  if (d > 0 && oi > 0) return "new longs";
  if (d > 0 && oi < 0) return "short closing";
  if (d < 0 && oi > 0) return "new shorts";
  if (d < 0 && oi < 0) return "long closing";
  return "—";
}

// Liquidation note — lihat arah harga candle & side liquidation
function inferLiqNote(
  open: number | undefined,
  close: number | undefined,
  liqBuy: number | undefined,
  liqSell: number | undefined
): string {
  const o = open ?? 0;
  const c = close ?? o;
  const up = c >= o;

  const lb = Math.max(0, liqBuy ?? 0);
  const ls = Math.max(0, liqSell ?? 0);

  const margin = 1.1;
  if (up && ls > lb * margin) return "Shorts liquidated";
  if (!up && lb > ls * margin) return "Longs liquidated";

  if (ls > lb) return "Shorts liquidated";
  if (lb > ls) return "Longs liquidated";
  return "";
}

// market session
function inferSession(dateMs: number): "Asia" | "London" | "NY" | "" {
  const h = new Date(dateMs).getUTCHours();
  if (h >= 13 && h < 22) return "NY";
  if (h >= 7 && h < 16) return "London";
  return "Asia";
}

// event untuk csv
function toEvent(dir: Direction): "Breakout" | "Breakdown" {
  return dir === "bullish" ? "Breakout" : "Breakdown";
}

// Inisialisasi CSV logger (rotate harian otomatis)
initAlertsCsv({
  dir: "./logs",
  filePrefix: "alerts",
  flushEvery: 1000,
  enabled: true,
});

// state lokal: prevClose per symbol+tf
const prevCloseMap = new Map<string, number>();
const pcKey = (symbol: string, tf: number) => `${symbol}:${tf}`;

// Tutup rapi saat proses dihentikan
process.on("SIGINT", closeAlertsCsv);
process.on("SIGTERM", closeAlertsCsv);
process.on("beforeExit", closeAlertsCsv);

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);

  // 1) redis client
  await redisClient();

  // 2) load POI lama dari redis
  await Promise.all(symbols.map((s) => loadPOIFromRedis(s)));
  console.log("📌 POI state loaded from redis");

  // 3) Seed dari REST: monday/prevWeek/prevDay
  await Promise.all(symbols.map((s) => loadPOIFromREST(s, "linear")));
  console.log("📌 POI state seeded from REST (monday/prevWeek/prevDay)");

  // fetch semua channel
  const alertChannels = await fetchTextChannels(CHANNEL_IDS);
  console.log(
    `🔔 Alert channels: ${alertChannels.map((c) => c.id).join(", ")}`
  );

  // === Buat aggregator per TF
  const aggregators = TIMEFRAMES.map((tf) => ({
    tf,
    agg: new FiveMinAggregator({
      intervalMs: tf * 60 * 1000,
      useOiOhlc: false,
      flushGraceMs: 3000,
      onFlush: (rows) => onFlushPerTf(tf, rows, alertChannels),
    }),
  }));

  // --- WS wiring ---
  const ws = new BybitPublicTradesWS({
    net: "mainnet",
    market: "linear",
    log: console.log,
  });
  ws.connect();
  ws.subscribeTrades(symbols);
  ws.subscribeTickers(symbols);
  ws.subscribeLiquidations(symbols);
  for (const tf of TIMEFRAMES) ws.subscribeKlines(tf, symbols);

  // start all aggregators
  for (const { agg } of aggregators) agg.start();

  ws.onTrade((t) => {
    if (!Number.isFinite(t.size) || !Number.isFinite(t.ts)) return;
    for (const { agg } of aggregators)
      agg.onTrade(t.symbol, t.side, t.size, t.ts);
  });
  ws.onLiquidation((lq) => {
    for (const { agg } of aggregators)
      agg.onLiquidation(lq.symbol, lq.side, lq.size, lq.ts, lq.price);
  });
  ws.onTicker((tk) => {
    for (const { agg } of aggregators) {
      if (tk.lastPrice !== undefined) agg.onLastPrice(tk.symbol, tk.lastPrice);
      if (tk.openInterest !== undefined)
        agg.onOpenInterest(tk.symbol, tk.openInterest);
    }
  });
  ws.onKline((k) => {
    if (!k.confirm) return;
    const tf = Math.round((k.end - k.start) / 60000);
    const target = aggregators.find((a) => a.tf === tf);
    target?.agg.onKline(
      k.symbol,
      k.start,
      k.end,
      k.open,
      k.high,
      k.low,
      k.close,
      true
    );

    // Update POI hanya dari TF 5m (hemat & konsisten)
    if (tf === 5) {
      const ev = ingestCandlePOI(k.symbol, k.start, k.open, k.high, k.low);
      // Persist state (boleh semua event agar H/L selalu tersimpan)
      savePOIToRedis(k.symbol, ev.state).catch((err) =>
        console.error("[POI] save error", err)
      );
    }
  });

  // seeding snapshot
  setInterval(() => {
    for (const s of symbols) {
      const snap = ws.getTicker?.(s);
      for (const { agg } of aggregators) {
        if (snap?.lastPrice !== undefined) agg.onLastPrice(s, snap.lastPrice);
        if (snap?.openInterest !== undefined)
          agg.onOpenInterest(s, snap.openInterest);
      }
    }
  }, 3000).unref?.();

  setInterval(() => {
    for (const s of symbols) {
      loadPOIFromREST(s, "linear").catch((e) =>
        console.error("[POI] weekly seed error", e)
      );
    }
  }, 10 * 60 * 2000).unref?.(); // tiap 20 menit

  console.log("⏱️ WS aktif | Multi-TF enabled.");
});

function nextEma(prev: number, x: number, nWindow: number) {
  const N = Math.max(1, nWindow);
  const alpha = 2 / (N + 1);
  if (!Number.isFinite(prev) || prev === 0) return x; // seed cepat
  return prev + alpha * (x - prev);
}

function trueRange(
  h: number,
  l: number,
  o: number,
  prevClose?: number
): number {
  if (!Number.isFinite(h) || !Number.isFinite(l)) return 0;
  const hl = Math.max(h - l, 0);
  const ref = o;
  const hc = Math.abs(h - ref);
  const lc = Math.abs(l - ref);
  return Math.max(hl, hc, lc);
}

function nextAtrWilderWithSeed(
  prevAtr: number | undefined,
  tr: number,
  N: number,
  count: number
): number | undefined {
  // kalau belum ada cukup TR, jangan hitung ATR dulu
  if (count < ATR_PERIOD) {
    console.log("masuk undefined");
    return undefined;
  }

  // Seed awal (sampai ATR_PERIOD)
  if (!Number.isFinite(prevAtr) || count < N) {
    const seeded =
      (Math.max(0, prevAtr ?? 0) * Math.max(0, count - 1) + tr) /
      Math.max(1, count);
    console.log(`masuk seeded: ${seeded}`);
    return seeded;
  }

  // Wilder smoothing
  const smooterResult = ((prevAtr as number) * (N - 1) + tr) / N;
  console.log(`smoother res = ${smooterResult}`);
  return smooterResult;
}

async function onFlushPerTf(
  tf: number,
  rows: FiveMinResult[],
  alertChannels: TextChannel[]
) {
  // proses sekuensial untuk meredam ledakan paralel di boundary
  for (const row of rows) {
    // 1) simpan candle TF ke redis
    const key = aggKeyTf(row.symbol, tf);
    const item = {
      timestamp: row.start,
      symbol: row.symbol,
      start: row.start,
      end: row.end,
      open: row.open ?? 0,
      high: row.high ?? 0,
      low: row.low ?? 0,
      close: row.close ?? 0,
      lastPrice: row.lastPrice,
      buyVol: row.buyVol,
      sellVol: row.sellVol,
      delta: row.delta,
      tradeCount: row.tradeCount,
      tradeVolume: row.tradeVolume,
      oiClose: row.oiClose,
      oiOpen: row.oiOpen,
      oiHigh: row.oiHigh,
      oiLow: row.oiLow,
      oiChange: row.oiChange,
      liquidationVol: row.liquidationVol,
      liquidationBuyVol: row.liquidationBuyVol,
      liquidationSellVol: row.liquidationSellVol,
      liquidationCount: row.liquidationCount,
    };

    const status = await listReplaceHeadIfSameTs(key, item);
    const len = await listLen(key);

    console.log(
      `[redis:${tf}m] ${row.symbol} pushed=${status} len=${len} ts=${row.start}`
    );

    // === (ATR CALCULATION) ===

    const keyPC = pcKey(row.symbol, tf);
    const prevClose = prevCloseMap.get(keyPC) ?? row.open;

    // Hitung TR untuk bar ini
    const H = Number(row.high ?? 0);
    const L = Number(row.low ?? 0);
    const C = Number(row.close ?? row.lastPrice ?? 0);
    const o = Number(row.open ?? 0);

    const TR = trueRange(H, L, o, prevClose);

    console.log(
      `[TR:${tf}m] ${row.symbol} prevC=${prevClose ?? "-"} | ` +
        `H=${H} L=${L} C=${C} -> TR=${TR}`
    );

    const prev = await loadAtrState(row.symbol, tf);
    const next = updateAtrWithTrBuffer(prev, TR, ATR_PERIOD, ATR_PERIOD);
    await saveAtrState(row.symbol, tf, next);

    // Update prevClose untuk bar berikutnya
    if (Number.isFinite(C)) prevCloseMap.set(keyPC, C);

    if (next.atr === undefined) {
      console.log(
        `[ATR:${tf}m] ${row.symbol} TR=${TR.toFixed(2)} | seed ${
          next.trBuf.length
        }/${ATR_PERIOD} (min ${ATR_PERIOD}) — ATR belum dihitung`
      );
    } else {
      console.log(
        `[ATR:${tf}m] ${row.symbol} TR=${TR.toFixed(2)} | ATR=${(
          next.atr as number
        ).toFixed(2)} (count=${next.count})`
      );
    }

    let atrOk = true;
    let priceAtrActive: number | undefined;
    let atrModeActive: "long" | "short" | undefined;

    const atrNow = next.atr;
    const mult = Number(process.env.ATR_MULT ?? 3.5);
    const epsPct = Number(process.env.ATR_EPS_PCT ?? 0.05);

    if (Number.isFinite(atrNow) && C > 0) {
      const stopKey = atrStopKeyTf(row.symbol, tf);
      const prevStop = (await getJSON(stopKey)) as AtrStopState | undefined;

      const nextStop = updateAtrTrailingStop(
        prevStop,
        H,
        L,
        C,
        atrNow as number,
        mult
      );
      await setJSON(stopKey, nextStop);

      const direction = inferDirection(row.delta);
      atrOk = atrGateOk(direction, C, nextStop.stop, epsPct);

      priceAtrActive = nextStop.stop; // <--- simpan garis aktif
      atrModeActive = nextStop.mode;

      console.log(
        `[ATR-STOP:${tf}m] ${row.symbol} mode=${nextStop.mode} px=${C} ` +
          `stop=${nextStop.stop?.toFixed?.(2)} pass=${atrOk}`
      );
    }

    // 2) Ambil baseline PREV (tanpa LRANGE)
    const avgKey = aggAvgKeyTf(row.symbol, tf);
    const prevAvg = await getJSON<{
      count: number;
      avgVolume: number;
      avgDelta: number; // signed
      avgDeltaAbs: number; // |Δ|
      avgOiChangeAbs: number; // |ΔOI|
      updatedAt: number;
    }>(avgKey);

    const prevCount = prevAvg?.count ?? 0;
    const prevAvgVol = prevAvg?.avgVolume ?? 0;
    const prevAvgDelta = prevAvg?.avgDelta ?? 0;
    const prevAvgDeltaAbs = prevAvg?.avgDeltaAbs ?? 0;
    const prevAvgOiAbs = prevAvg?.avgOiChangeAbs ?? 0;

    // 3) Hitung nilai current (hanya dari row ini)
    const currentVol =
      (row.tradeVolume ?? 0) || (row.buyVol ?? 0) + (row.sellVol ?? 0);
    const currentDelta = row.delta ?? 0;
    const currentDeltaAbs = Math.abs(currentDelta);
    const currentOiChangeAbs = Math.abs(row.oiChange ?? 0);

    // 4) Update EMA baseline
    const nextCount = Math.min(prevCount + 1, CAPACITY);
    const N = Math.max(10, Math.min(CAPACITY, nextCount));

    const avgVolumeNow = nextEma(prevAvgVol, currentVol, N);
    const avgDeltaNow = nextEma(prevAvgDelta, currentDelta, N);
    const avgDeltaAbsNow = nextEma(prevAvgDeltaAbs, currentDeltaAbs, N);
    const avgOiAbsNow = nextEma(prevAvgOiAbs, currentOiChangeAbs, N);

    await setJSON(avgKey, {
      symbol: row.symbol,
      period: `${tf}m`,
      count: nextCount,
      avgVolume: avgVolumeNow,
      avgDelta: avgDeltaNow,
      avgDeltaAbs: avgDeltaAbsNow,
      avgOiChangeAbs: avgOiAbsNow,
      updatedAt: Date.now(),
    });

    console.log(
      `[redis:${tf}m] ${row.symbol} baseline -> vol=${avgVolumeNow.toFixed(
        2
      )} |Δ|=${avgDeltaAbsNow.toFixed(2)} |ΔOI|=${avgOiAbsNow.toFixed(2)}`
    );

    // 6) cache lokal
    lastAgg.set(`${row.symbol}:${tf}`, row);

    // 7) RULES pakai baseline PREV
    const enoughHistory = prevCount >= ALERT_MIN_COUNT;

    const baseVol = prevAvgVol;
    const baseDeltaAbs = prevAvgDeltaAbs;
    const baseOiAbs = prevAvgOiAbs;

    const rvol =
      baseVol > 0 && Number.isFinite(currentVol) ? currentVol / baseVol : 0;
    const rdelta =
      baseDeltaAbs > 0 && Number.isFinite(currentDeltaAbs)
        ? currentDeltaAbs / baseDeltaAbs
        : 0;
    const roi =
      baseOiAbs > 0 && Number.isFinite(currentOiChangeAbs)
        ? currentOiChangeAbs / baseOiAbs
        : 0;

    const direction = inferDirection(row.delta);
    const tier = pickTier(rvol, rdelta, roi);

    // --- CANDLE INDENTIFIER---
    let candleType:
      | "Green Pinbar"
      | "Red Pinbar"
      | "Green Inverted Pinbar"
      | "Red Inverted Pinbar"
      | undefined = undefined;

    let breaker = false;

    if (tier === "A" || tier === "S") {
      const H = Number(row.high ?? 0);
      const L = Number(row.low ?? 0);
      const C = Number(row.close ?? row.lastPrice ?? 0);
      const O = Number(row.open ?? 0);

      const classified = classifyCandle(O, H, L, C);
      if (classified === "green pinbar") candleType = "Green Pinbar";
      else if (classified === "green inverted pinbar")
        candleType = "Green Inverted Pinbar";
      else if (classified === "red inverted pinbar")
        candleType = "Red Inverted Pinbar";
      else if (classified === "red pinbar") candleType = "Red Pinbar";

      breaker = candleType !== undefined;
    }

    const gateOk = breaker ? true : atrOk;

    // --- NEAREST LEVEL RULE (±NEAR_LEVEL_PCT)
    const levels = getPOILevels(row.symbol);
    const px = row.close ?? row.lastPrice ?? 0;
    function distPct(p?: number | null) {
      return p == null || px === 0
        ? Number.POSITIVE_INFINITY
        : Math.abs((px - p) / px) * 100;
    }

    type Candidate = { label: string; price: number | null; pct: number };
    const candidates: Candidate[] = [
      {
        label: "Monday Open",
        price: levels.mondayOpen ?? null,
        pct: distPct(levels.mondayOpen),
      },
      {
        label: "Monday High",
        price: levels.mondayHigh ?? null,
        pct: distPct(levels.mondayHigh),
      },
      {
        label: "Monday Low",
        price: levels.mondayLow ?? null,
        pct: distPct(levels.mondayLow),
      },
      {
        label: "PrevW Open",
        price: levels.prevWeekOpen ?? null,
        pct: distPct(levels.prevWeekOpen),
      },
      {
        label: "PrevW High",
        price: levels.prevWeekHigh ?? null,
        pct: distPct(levels.prevWeekHigh),
      },
      {
        label: "PrevW Low",
        price: levels.prevWeekLow ?? null,
        pct: distPct(levels.prevWeekLow),
      },
      {
        label: "PrevD Open",
        price: levels.prevDayOpen ?? null,
        pct: distPct(levels.prevDayOpen),
      },
      {
        label: "PrevD High",
        price: levels.prevDayHigh ?? null,
        pct: distPct(levels.prevDayHigh),
      },
      {
        label: "PrevD Low",
        price: levels.prevDayLow ?? null,
        pct: distPct(levels.prevDayLow),
      },
    ].sort((a, b) => a.pct - b.pct);

    const nearest = candidates[0];
    const nearOk =
      nearest && Number.isFinite(nearest.pct) && nearest.pct <= NEAR_LEVEL_PCT;

    const nowJakarta = new Date().toLocaleString("en-US", {
      timeZone: "Asia/Jakarta",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const fire = enoughHistory && !!tier && nearOk && gateOk;

    console.log(
      `[near:${tf}m] ${row.symbol} poi=${
        nearest?.label ?? "-"
      } dist=${nearest?.pct?.toFixed(3)}% ok=${nearOk}`
    );
    console.log(
      `[check:${tf}m] [${nowJakarta}] hist=${enoughHistory} rvol=${rvol.toFixed(
        2
      )} rΔ=${rdelta.toFixed(2)} roi=${roi.toFixed(2)} tier=${
        tier ?? "-"
      } fire=${fire ? "YES" : "NO"}`
    );

    if (fire && tier && nearest && nearOk) {
      const coolKey = `${row.symbol}:${tf}`;
      const now = Date.now();
      const last = lastAlertAt.get(coolKey) ?? 0;
      const due = now - last >= ALERT_COOLDOWN_SEC * 1000;

      if (due) {
        try {
          // kirim embed + level info
          await sendCombinedAlert(
            alertChannels,
            tf,
            row.symbol,
            row,
            { rvol, rdelta, roi },
            direction,
            tier,
            {
              label: nearest.label,
              price: nearest.price ?? 0,
              distancePct: nearest.pct,
            },
            priceAtrActive,
            atrModeActive,
            candleType
          );
          lastAlertAt.set(coolKey, now);

          const ts = row.end ?? row.start;
          const session = inferSession(ts);

          const deltaSigned = row.delta;
          const prevCandle = prevCount ?? 0;
          const avgDeltaSigned = prevAvgDelta ?? 0;

          // NOTE: perbaikan def. oiPct -> (oiChange / oiClose) * 100
          const oiPct =
            row.oiClose && row.oiChange
              ? (row.oiChange / row.oiClose) * 100
              : "";

          const currentOiChange = row.oiChange ?? 0; // ΔOI pada candle ini (USD)
          const avgOiChangePrev = prevAvgOiAbs ?? 0; // baseline |ΔOI| (prev)
          const oiChangeRatio =
            avgOiChangePrev > 0 ? currentOiChange / avgOiChangePrev : 0;

          const volNow = row.tradeVolume ?? 0;
          const liqPct =
            volNow > 0 && (row.tradeVolume ?? 0)
              ? ((row.liquidationVol as number) / volNow) * 100
              : "";

          const levelLabel = nearest?.label ?? "";
          const levelPrice = nearest?.price ?? "";
          const levelDist =
            nearest && Number.isFinite(nearest.pct)
              ? Number(nearest.pct.toFixed(4))
              : "";

          // ==== LOG ke CSV (satu baris per alert terkirim)
          logAlertCsv({
            TIER: tier,
            Timestamp: new Date(ts).toISOString(),
            Timeframe: String(tf),
            Session: session,
            POIType: nearest.label ?? "",
            Level: levelLabel,
            LevelPrice: levelPrice,
            LevelDistPct: levelDist,
            Event: toEvent(direction),
            PreviousCandle: prevCandle,
            DeltaTotal: avgDeltaSigned,
            AvgDelta: prevAvgDelta ?? 0,
            Delta: deltaSigned,
            DeltaChangex: rdelta,
            AvgOiChange: avgOiChangePrev,
            currentOiChange: currentOiChange,
            oiChange: oiChangeRatio,
            LiqPct: typeof liqPct === "number" ? liqPct : "",
            MFEpct: "",
            MAEpct: "",
            RR: "",
            MFEtoTrigger: "",
            Outcome: "",
          });

          console.log(
            `[alert/${tier}:${tf}m] ${row.symbol} RVOL=${rvol.toFixed(
              2
            )} RΔ=${rdelta.toFixed(2)} ROI=${roi.toFixed(
              2
            )} dir=${direction} level=${
              nearest.label
            } dist=${nearest.pct.toFixed(3)}%`
          );
        } catch (e) {
          console.error(`[alert/${tier}:${tf}m] failed for ${row.symbol}`, e);
        }
      } else {
        console.log(
          `[alert:${tf}m] suppressed ${row.symbol} (cooldown ${ALERT_COOLDOWN_SEC}s)`
        );
      }
    }
  } // end-for rows
}

client.login(TOKEN);
