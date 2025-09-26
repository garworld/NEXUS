// helpers/poi-redis.ts
import {
  getJSON,
  setJSON,
  listReplaceHeadIfSameTs,
  CAPACITY,
} from "../helpers/redis.js";
import { getPOI, getPOIData, POIState, setPOI } from "./poi-tracker.js";

// Key naming
const poiCurrKey = (symbol: string) => `poi:current:${symbol}`;
const poiPrevKey = (symbol: string) => `poi:prev:${symbol}`;
const poiHistKey = (symbol: string) => `poi:history:${symbol}`; // ring buffer weekly history (opsional)

type PersistShape = {
  symbol: string;
  // currentWeek
  currentWeek?: {
    weekId: string;
    weekAnchorMs?: number;
    open: number | null;
    high: number | null;
    low: number | null;
  } | null;
  // previous week (fully closed)
  prevWeek?: {
    weekId: string;
    weekAnchorMs?: number;
    open: number | null;
    high: number | null;
    low: number | null;
  } | null;
  // monday this week
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

/** Simpan state penuh (current, prev, monday). */
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

  await setJSON(poiCurrKey(symbol), payload);

  // kalau ada prevWeek (baru rollover), masukkan juga ke history ring (opsional)
  if (st.prevWeek?.weekAnchorMs) {
    const histItem = {
      symbol,
      weekId: st.prevWeek.weekId,
      timestamp: st.prevWeek.weekAnchorMs, // pakai sebagai dedup ts
      open: st.prevWeek.open ?? null,
      high: st.prevWeek.high ?? null,
      low: st.prevWeek.low ?? null,
    };
    await listReplaceHeadIfSameTs(poiHistKey(symbol), histItem);
  }
}

/** Muat state dari Redis (kalau ada) ke tracker in-memory. */
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

// check is POI need to be update or no
export async function shouldUpdatePOI(symbol: string) {
  const st = getPOI(symbol);
  const lastUpdated = st.monday?.mondayAnchorMs ?? 0;

  const currentDate = new Date();
  const lastUpdateDate = new Date(lastUpdated);

  // make sure POI has been update on monday
  if (
    currentDate.getDay() === 1 &&
    lastUpdateDate.getDate() !== currentDate.getDate()
  ) {
    return true;
  }

  return false;
}

// Fungsi untuk mendapatkan POI dari REST API
export async function loadPOIFromREST(symbol: string) {
  const shouldUpdate = await shouldUpdatePOI(symbol);

  if (shouldUpdate) {
    const poiData = await getPOIData(symbol);

    const st = {
      currentWeek: {
        weekId: "2025-W01", // Static data, real logic can be applied based on date range
        open: poiData.prevWeekOpen,
        high: poiData.prevWeekHigh,
        low: poiData.prevWeekLow,
      },
      prevWeek: {
        weekId: "2024-W52",
        open: poiData.prevWeekOpen,
        high: poiData.prevWeekHigh,
        low: poiData.prevWeekLow,
      },
      monday: {
        weekId: "2025-W01",
        open: poiData.mondayOpen,
        high: poiData.mondayHigh,
        low: poiData.mondayLow,
      },
      currentDay: {
        dayId: "2025-01-01",
        open: poiData.prevDayOpen,
        high: poiData.prevDayHigh,
        low: poiData.prevDayLow,
      },
      prevDay: {
        dayId: "2024-12-31",
        open: poiData.prevDayOpen,
        high: poiData.prevDayHigh,
        low: poiData.prevDayLow,
      },
    };

    // Simpan POI dalam state internal
    setPOI(symbol, st);
    console.log(`POI updated for ${symbol} from REST API.`);
  } else {
    console.log(`POI for ${symbol} is up-to-date.`);
  }
}
