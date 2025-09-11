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
  listReadJSON,
  listHeadJSON,
  listLen,
  setJSON,
  getJSON,
  agg5mKey,
  agg5mAvgKey,
  CAPACITY,
} from "./helpers/redis.js";

const TOKEN = process.env.DISCORD_TOKEN!;
const CHANNEL_ID = process.env.CHANNEL_ID!;
const CURRENCY = (process.env.CURRENCY || "usdt").toLowerCase();

// TIER B RATIO
const RVOL_RATIO_TIER_B = Number(process.env.RVOL_RATIO_TIER_B ?? 1.5); // colume spike
const RDELTA_RATIO_TIER_B = Number(process.env.RDELTA_RATIO_TIER_B ?? 1.5); // delta spike
const OI_CHANGE_RATIO_TIER_B = Number(
  process.env.OI_CHANGE_RATIO_TIER_B ?? 1.5
); // OI spike

// TIER A RATIO
const RVOL_RATIO_TIER_A = Number(process.env.RVOL_RATIO_TIER_A ?? 2.5); // colume spike
const RDELTA_RATIO_TIER_A = Number(process.env.RDELTA_RATIO_TIER_A ?? 2); // delta spike
const OI_CHANGE_RATIO_TIER_A = Number(
  process.env.OI_CHANGE_RATIO_TIER_A ?? 2.5
); // OI spike

// TIER S RATIO
const RVOL_RATIO_TIER_S = Number(process.env.RVOL_RATIO_TIER_S ?? 3.5); // colume spike
const RDELTA_RATIO_TIER_S = Number(process.env.RDELTA_RATIO_TIER_S ?? 3); // delta spike
const OI_CHANGE_RATIO_TIER_S = Number(process.env.OI_CHANGE_RATIO_TIER_S ?? 3); // OI spike

const ALERT_MIN_COUNT = Number(process.env.ALERT_MIN_COUNT ?? 20);
const ALERT_COOLDOWN_SEC = Number(process.env.ALERT_COOLDOWN_SEC ?? 300);

const symbols = (process.env.SYMBOLS?.split(",").map((s) =>
  s.trim().toUpperCase()
) || ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "FARTCOINUSDT"]) as string[];

const TIMEFRAMES = (process.env.TIMEFRAMES?.split(",").map((s) =>
  Number(s.trim())
) || [5, 15, 30]) as number[]; // menit

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN in .env");
if (!CHANNEL_ID) throw new Error("Missing CHANNEL_ID in .env");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// cache lokal buat embed rutin
const lastAgg = new Map<string, FiveMinResult>();

// cooldown gabungan (satu map untuk rule AND)
const lastAlertAt = new Map<string, number>();

type Direction = "bullish" | "bearish";
type Tier = "B" | "A" | "S";

const tfLabel = (tf: number) => `${tf}M`;
const aggKeyTf = (symbol: string, tf: number) => `agg:${tf}m:${symbol}`;
const aggAvgKeyTf = (symbol: string, tf: number) => `aggavg:${tf}m:${symbol}`;

// helper: kirim embed alert gabungan
async function sendCombinedAlert(
  ch: TextChannel,
  tf: number,
  symbol: string,
  snapshot: FiveMinResult,
  ratios: { rvol: number; rdelta: number; roi: number },
  dir: Direction,
  tier: Tier
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
    },
    CURRENCY
  );

  await ch.send({ embeds: [embed] });
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

  const lb = Math.max(0, liqBuy ?? 0); // liquidation buy volume
  const ls = Math.max(0, liqSell ?? 0); // liquidation sell volume

  // pilih side dominan dengan sedikit margin biar gak "mixed" terus
  const margin = 1.1;
  if (up && ls > lb * margin) return "Shorts liquidated";
  if (!up && lb > ls * margin) return "Longs liquidated";

  // fallback: pilih yang lebih besar tanpa margin, kalau tetap imbang → mixed
  if (ls > lb) return "Shorts liquidated";
  if (lb > ls) return "Longs liquidated";
  return "";
}

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);

  await redisClient();

  // channel untuk alert
  const chRaw = await client.channels.fetch(CHANNEL_ID);
  if (!chRaw || !chRaw.isTextBased())
    throw new Error(`Channel ${CHANNEL_ID} bukan text channel`);
  const alertChannel = chRaw as TextChannel;

  // === Buat aggregator per TF
  const aggregators = TIMEFRAMES.map((tf) => ({
    tf,
    agg: new FiveMinAggregator({
      intervalMs: tf * 60 * 1000,
      useOiOhlc: false,
      flushGraceMs: 2500,
      onFlush: (rows) => onFlushPerTf(tf, rows, alertChannel),
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

  console.log("⏱️ WS aktif | Multi-TF enabled.");
});

async function onFlushPerTf(
  tf: number,
  rows: FiveMinResult[],
  alertChannel: TextChannel
) {
  await Promise.all(
    rows.map(async (row) => {
      // 1) simpan candle TF ke redis (ring buffer CAPACITY)
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

      // 2) Ambil baseline PREV (sebelum update)
      const avgKey = aggAvgKeyTf(row.symbol, tf);
      const prevAvg = await getJSON<{
        count: number;
        avgVolume: number;
        avgDelta: number;
        avgDeltaAbs: number;
        avgOiChangeAbs: number;
      }>(avgKey);

      const prevCount = prevAvg?.count ?? 0;
      const prevAvgVol = prevAvg?.avgVolume ?? 0;
      const prevAvgDelta = prevAvg?.avgDelta ?? 0; // signed (buat info saja)
      const prevAvgDeltaAbs = prevAvg?.avgDeltaAbs ?? 0; // dipakai rdelta baseline
      const prevAvgOiAbs = prevAvg?.avgOiChangeAbs ?? 0;

      // 3) Hitung avg terbaru dari list
      const all = await listReadJSON<typeof item>(key, CAPACITY);
      let sumVol = 0;
      let sumDelta = 0;
      let sumDeltaAbs = 0;
      let sumOiAbs = 0;
      let count = 0;
      for (const it of all) {
        const vol =
          (it.tradeVolume ?? 0) || (it.buyVol ?? 0) + (it.sellVol ?? 0);
        const dlt = it.delta ?? 0;
        const dltAbs = Math.abs(dlt);
        const oiChgAbs = Math.abs(it.oiChange ?? 0);
        if (Number.isFinite(vol)) sumVol += vol;
        if (Number.isFinite(dlt)) sumDelta += dlt;
        if (Number.isFinite(dltAbs)) sumDeltaAbs += dltAbs;
        if (Number.isFinite(oiChgAbs)) sumOiAbs += oiChgAbs;
        count++;
      }

      const avgVolumeNow = count ? sumVol / count : 0;
      const avgDeltaNow = count ? sumDelta / count : 0; // signed (informasi)
      const avgDeltaAbsNow = count ? sumDeltaAbs / count : 0; // baseline rdelta
      const avgOiAbsNow = count ? sumOiAbs / count : 0;

      // 4) simpan avg terbaru (jadi baseline berikutnya)
      await setJSON(avgKey, {
        symbol: row.symbol,
        period: `${tf}m`,
        count,
        avgVolume: avgVolumeNow,
        avgDelta: avgDeltaNow,
        avgDeltaAbs: avgDeltaAbsNow,
        avgOiChangeAbs: avgOiAbsNow,
        updatedAt: Date.now(),
      });

      // 5) log
      const head = await listHeadJSON<typeof item>(key);
      console.log(
        `[redis:${tf}m] ${status} -> ${key} len=${len}/${CAPACITY} ` +
          `avgVol(now)=${avgVolumeNow.toFixed(3)} ` +
          `avgΔ(now,signed)=${avgDeltaNow.toFixed(3)} ` +
          `avg|Δ|(now)=${avgDeltaAbsNow.toFixed(3)} ` +
          `avg|ΔOI|(now)=${avgOiAbsNow.toFixed(3)} | ` +
          `prev Vol=${prevAvgVol.toFixed(3)} prev |Δ|=${prevAvgDeltaAbs.toFixed(
            3
          )} prev |ΔOI|=${prevAvgOiAbs.toFixed(3)}`
      );
      // console.dir(head, { depth: null });

      // cache lokal untuk kebutuhan lain (key per symbol:tf)
      lastAgg.set(`${row.symbol}:${tf}`, row);

      // 6) RULES: RVOL, RDELTA, ROI (pakai baseline PREV)
      const enoughHistory = prevCount >= ALERT_MIN_COUNT;

      const currentVol =
        (row.tradeVolume ?? 0) || (row.buyVol ?? 0) + (row.sellVol ?? 0);
      const currentDeltaAbs = Math.abs(row.delta ?? 0);
      const currentOiChangeAbs = Math.abs(row.oiChange ?? 0);

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
      const fire = enoughHistory && !!tier;

      console.log(
        `[check:${tf}m] hist=${enoughHistory} rvol=${rvol.toFixed(
          2
        )} rΔ=${rdelta.toFixed(2)} roi=${roi.toFixed(2)} tier=${tier ?? "-"}`
      );

      if (fire && tier) {
        const coolKey = `${row.symbol}:${tf}`;
        const now = Date.now();
        const last = lastAlertAt.get(coolKey) ?? 0;
        const due = now - last >= ALERT_COOLDOWN_SEC * 1000;

        if (due) {
          try {
            await sendCombinedAlert(
              alertChannel,
              tf,
              row.symbol,
              row,
              { rvol, rdelta, roi },
              direction,
              tier
            );
            lastAlertAt.set(coolKey, now);
            console.log(
              `[alert/${tier}:${tf}m] ${row.symbol} RVOL=${rvol.toFixed(
                2
              )} RΔ=${rdelta.toFixed(2)} ROI=${roi.toFixed(2)} dir=${direction}`
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
    })
  );
}

client.login(TOKEN);
