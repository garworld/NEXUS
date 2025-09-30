// helpers/poi-redis.ts
import {
  getJSON,
  setJSON,
  listReplaceHeadIfSameTs,
  CAPACITY,
} from "../helpers/redis.js";
import {
  getPOI,
  setPOI,
  type POIState,
  type POIEvent,
  bootstrapPOIFromREST, // seed monday/prevWeek/prevDay dari REST v5
} from "./poi-tracker.js";

// =========================
// ====== Key helpers ======
// =========================
const poiCurrKey = (symbol: string) => `poi:current:${symbol}`;
const poiPrevKey = (symbol: string) => `poi:prev:${symbol}`;
const poiHistKey = (symbol: string) => `poi:history:${symbol}`; // ring buffer weekly history

// ==========================
// ===== Persist payload =====
// ==========================
type PersistShape = {
  symbol: string;
  currentWeek?: {
    weekId: string;
    weekAnchorMs?: number;
    open: number | null;
    high: number | null;
    low: number | null;
  } | null;
  prevWeek?: {
    weekId: string;
    weekAnchorMs?: number;
    open: number | null;
    high: number | null;
    low: number | null;
  } | null;
  monday?: {
    weekId: string;
    mondayAnchorMs?: number;
    open: number | null;
    high: number | null;
    low: number | null;
  } | null;
  currentDay?: {
    dayId: string;
    dayAnchorMs?: number;
    open: number | null;
    high: number | null;
    low: number | null;
  } | null;
  prevDay?: {
    dayId: string;
    dayAnchorMs?: number;
    open: number | null;
    high: number | null;
    low: number | null;
  } | null;
  updatedAt: number;
};

// ==================================
// ===== Persist to / load Redis =====
// ==================================
export async function savePOIToRedis(symbol: string, st: POIState) {
  const payload: PersistShape = {
    symbol,
    currentWeek: st.currentWeek
      ? {
          weekId: st.currentWeek.weekId,
          weekAnchorMs: st.currentWeek.weekAnchorMs,
          open: st.currentWeek.open ?? null,
          high: st.currentWeek.high ?? null,
          low: st.currentWeek.low ?? null,
        }
      : null,
    prevWeek: st.prevWeek
      ? {
          weekId: st.prevWeek.weekId,
          weekAnchorMs: st.prevWeek.weekAnchorMs,
          open: st.prevWeek.open ?? null,
          high: st.prevWeek.high ?? null,
          low: st.prevWeek.low ?? null,
        }
      : null,
    monday: st.monday
      ? {
          weekId: st.monday.weekId,
          mondayAnchorMs: st.monday.mondayAnchorMs,
          open: st.monday.open ?? null,
          high: st.monday.high ?? null,
          low: st.monday.low ?? null,
        }
      : null,
    currentDay: st.currentDay
      ? {
          dayId: st.currentDay.dayId,
          dayAnchorMs: st.currentDay.dayAnchorMs,
          open: st.currentDay.open ?? null,
          high: st.currentDay.high ?? null,
          low: st.currentDay.low ?? null,
        }
      : null,
    prevDay: st.prevDay
      ? {
          dayId: st.prevDay.dayId,
          dayAnchorMs: st.prevDay.dayAnchorMs,
          open: st.prevDay.open ?? null,
          high: st.prevDay.high ?? null,
          low: st.prevDay.low ?? null,
        }
      : null,
    updatedAt: Date.now(),
  };

  // Snapshot terkini
  await setJSON(poiCurrKey(symbol), payload);

  // Optional: simpan prevWeek-only untuk lookup cepat
  if (payload.prevWeek) {
    await setJSON(poiPrevKey(symbol), payload.prevWeek);
  }

  // Ring history mingguan (dedup head by timestamp)
  if (st.prevWeek?.weekAnchorMs) {
    const histItem = {
      symbol,
      weekId: st.prevWeek.weekId,
      timestamp: st.prevWeek.weekAnchorMs, // dipakai dedup
      open: st.prevWeek.open ?? null,
      high: st.prevWeek.high ?? null,
      low: st.prevWeek.low ?? null,
    };
    await listReplaceHeadIfSameTs(poiHistKey(symbol), histItem);
  }
}

export async function loadPOIFromRedis(symbol: string) {
  const data = await getJSON<PersistShape>(poiCurrKey(symbol));
  if (!data) return;

  const st: POIState = {
    currentWeek: data.currentWeek
      ? {
          weekId: data.currentWeek.weekId,
          weekAnchorMs: data.currentWeek.weekAnchorMs,
          open: data.currentWeek.open ?? null,
          high: data.currentWeek.high ?? null,
          low: data.currentWeek.low ?? null,
        }
      : null,
    prevWeek: data.prevWeek
      ? {
          weekId: data.prevWeek.weekId,
          weekAnchorMs: data.prevWeek.weekAnchorMs,
          open: data.prevWeek.open ?? null,
          high: data.prevWeek.high ?? null,
          low: data.prevWeek.low ?? null,
        }
      : null,
    monday: data.monday
      ? {
          weekId: data.monday.weekId,
          mondayAnchorMs: data.monday.mondayAnchorMs,
          open: data.monday.open ?? null,
          high: data.monday.high ?? null,
          low: data.monday.low ?? null,
        }
      : null,
    currentDay: data.currentDay
      ? {
          dayId: data.currentDay.dayId,
          dayAnchorMs: data.currentDay.dayAnchorMs,
          open: data.currentDay.open ?? null,
          high: data.currentDay.high ?? null,
          low: data.currentDay.low ?? null,
        }
      : null,
    prevDay: data.prevDay
      ? {
          dayId: data.prevDay.dayId,
          dayAnchorMs: data.prevDay.dayAnchorMs,
          open: data.prevDay.open ?? null,
          high: data.prevDay.high ?? null,
          low: data.prevDay.low ?? null,
        }
      : null,
  };

  setPOI(symbol, st);
}

// =====================================
// ===== Seed REST & need-to-update =====
// =====================================

// Anchor Senin UTC untuk tanggal ref
function mondayUTCOfWeek(refMs: number): number {
  const d = new Date(refMs);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const todayMid = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate()
  );
  const diffToMon = (dow + 6) % 7;
  return todayMid - diffToMon * 86400000;
}

/** True jika monday di state bukan Monday minggu ini → perlu REST seed */
export async function shouldUpdatePOI(symbol: string) {
  const st = getPOI(symbol);
  const lastMonday = st.monday?.mondayAnchorMs ?? 0;
  const thisMonday = mondayUTCOfWeek(Date.now());
  return lastMonday !== thisMonday;
}

/** Seed monday/prevWeek/prevDay via REST, tinggalkan currentDay/currentWeek untuk WS */
export async function loadPOIFromREST(
  symbol: string,
  category: "linear" | "inverse" | "spot" = "linear"
) {
  const need = await shouldUpdatePOI(symbol);
  if (!need) {
    console.log(`POI for ${symbol} is up-to-date (REST seed skipped).`);
    return;
  }

  const boot = await bootstrapPOIFromREST(symbol, { category });
  const st = getPOI(symbol);

  if (boot.prevDay) {
    st.prevDay = {
      dayId: boot.prevDay.dayId,
      dayAnchorMs: boot.prevDay.dayAnchorMs,
      open: boot.prevDay.open,
      high: boot.prevDay.high,
      low: boot.prevDay.low,
    };
  }

  if (boot.prevWeek) {
    st.prevWeek = {
      weekId: boot.prevWeek.weekId,
      weekAnchorMs: boot.prevWeek.weekAnchorMs,
      open: boot.prevWeek.open,
      high: boot.prevWeek.high,
      low: boot.prevWeek.low,
    };
  }

  if (boot.monday) {
    st.monday = {
      weekId: boot.monday.weekId,
      mondayAnchorMs: boot.monday.mondayAnchorMs,
      open: boot.monday.open,
      high: boot.monday.high,
      low: boot.monday.low,
    };
  }

  // Biarkan currentDay/currentWeek null → WS yang isi
  setPOI(symbol, st);

  // Persist sekali setelah seed
  await savePOIToRedis(symbol, st);
  console.log(`POI updated & persisted for ${symbol} from REST seed.`);
}

// =========================================
// ===== Persist dari WebSocket (hemat) =====
// =========================================

// Cache fingerprint & debounce timer per symbol
const fpCache = new Map<
  string,
  { week?: string; day?: string; mon?: string }
>();
const debounceTimer = new Map<string, ReturnType<typeof setTimeout>>();

/** Buat fingerprint sederhana untuk deteksi perubahan O/H/L per bucket */
function makeFingerprints(st: POIState) {
  const week = st.currentWeek
    ? `${st.currentWeek.weekId}|${st.currentWeek.open}|${st.currentWeek.high}|${st.currentWeek.low}`
    : "";
  const day = st.currentDay
    ? `${st.currentDay.dayId}|${st.currentDay.open}|${st.currentDay.high}|${st.currentDay.low}`
    : "";
  const mon = st.monday
    ? `${st.monday.weekId}|${st.monday.open}|${st.monday.high}|${st.monday.low}`
    : "";
  return { week, day, mon };
}

/** Debounce persist 250ms untuk coalesce burst update */
async function schedulePersist(symbol: string) {
  if (debounceTimer.has(symbol)) {
    clearTimeout(debounceTimer.get(symbol)!);
  }
  const t = setTimeout(async () => {
    try {
      const st = getPOI(symbol);
      await savePOIToRedis(symbol, st);
    } catch (e) {
      console.error("schedulePersist error:", e);
    } finally {
      debounceTimer.delete(symbol);
    }
  }, 250);
  debounceTimer.set(symbol, t);
}

/** Panggil ini setelah setiap `ingestCandlePOI(...)` dari WS confirm=true */
export async function onPOIEventPersist(symbol: string, ev: POIEvent) {
  const st = getPOI(symbol);
  const nowFp = makeFingerprints(st);
  const last = fpCache.get(symbol);

  const isRollover =
    ev.type === "newWeek" || ev.type === "newDay" || ev.type === "newMonday";

  // Simpan segera saat rollover (penting utk konsistensi prev*)
  if (isRollover) {
    await savePOIToRedis(symbol, st);
    fpCache.set(symbol, nowFp);
    return;
  }

  const changed =
    !last ||
    last.week !== nowFp.week ||
    last.day !== nowFp.day ||
    last.mon !== nowFp.mon;

  if (changed) {
    fpCache.set(symbol, nowFp);
    await schedulePersist(symbol);
  }
}

// Optional helper: flush persist debounce (mis. saat shutdown)
export async function flushPOIPersist(symbol: string) {
  if (debounceTimer.has(symbol)) {
    clearTimeout(debounceTimer.get(symbol)!);
    debounceTimer.delete(symbol);
  }
  const st = getPOI(symbol);
  await savePOIToRedis(symbol, st);
}
