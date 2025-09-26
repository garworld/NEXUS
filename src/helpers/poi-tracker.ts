import axios from "axios";

// helpers/poi-tracker.ts
export type WeekPOI = {
  weekId: string; // "YYYY-WW" (ISO week, UTC)
  open: number | null;
  high: number | null;
  low: number | null;
  // anchor time utk redis history (Senin 00:00:00 UTC)
  weekAnchorMs?: number;
};

export type MondayPOI = {
  weekId: string;
  open: number | null;
  high: number | null;
  low: number | null;
  // anchor time utk redis history (Senin 00:00:00 UTC)
  mondayAnchorMs?: number;
};

export type DayPOI = {
  dayId: string; // YYYY-MM-DD (UTC / atau WIB offset)
  open: number | null;
  high: number | null;
  low: number | null;
  dayAnchorMs?: number; // jam 00:00 hari itu
};

export type POIState = {
  currentWeek: WeekPOI | null;
  prevWeek: WeekPOI | null;
  monday: MondayPOI | null;
  currentDay: DayPOI | null;
  prevDay: DayPOI | null;
};

export type POIEvent =
  | { type: "newWeek"; state: POIState }
  | { type: "updateWeek"; state: POIState }
  | { type: "newMonday"; state: POIState }
  | { type: "updateMonday"; state: POIState }
  | { type: "newDay"; state: POIState }
  | { type: "updateDay"; state: POIState };

const state = new Map<string, POIState>();

export function getPOI(symbol: string): POIState {
  return (
    state.get(symbol) ?? {
      currentWeek: null,
      prevWeek: null,
      monday: null,
      currentDay: null,
      prevDay: null,
    }
  );
}

export function setPOI(symbol: string, st: POIState) {
  state.set(symbol, st);
}

/** ISO week id (UTC) + apakah candle berada di Senin (UTC Monday). */
function isoWeekIdUTC(tsMs: number): {
  weekId: string;
  isMonday: boolean;
  mondayAnchorMs: number; // Senin 00:00 UTC ms dari minggu tsb
} {
  const d = new Date(tsMs);
  // ISO weekday: Mon=1..Sun=7
  const day = ((d.getUTCDay() + 6) % 7) + 1;

  // Monday 00:00 UTC anchor
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  monday.setUTCDate(d.getUTCDate() - (day - 1)); // mundur ke Senin
  monday.setUTCHours(0, 0, 0, 0);
  const mondayAnchorMs = monday.getTime();

  // Thursday trick utk week/year
  const thursday = new Date(mondayAnchorMs);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
  );
  const weekId = `${thursday.getUTCFullYear()}-${String(week).padStart(
    2,
    "0"
  )}`;

  return { weekId, isMonday: day === 1, mondayAnchorMs };
}

function dayIdUTC(tsMs: number): { dayId: string; anchorMs: number } {
  const d = new Date(tsMs);
  // anchor = jam 00:00 UTC hari tsb
  const anchor = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  return {
    dayId: `${anchor.getUTCFullYear()}-${String(
      anchor.getUTCMonth() + 1
    ).padStart(2, "0")}-${String(anchor.getUTCDate()).padStart(2, "0")}`,
    anchorMs: anchor.getTime(),
  };
}

function updHigh(a: number | null, v: number) {
  return a == null ? v : Math.max(a, v);
}
function updLow(a: number | null, v: number) {
  return a == null ? v : Math.min(a, v);
}

/** Ingest candle confirm (pakai 5m ideal), kembalikan event untuk persist. */
export function ingestCandlePOI(
  symbol: string,
  startMs: number,
  open: number,
  high: number,
  low: number
): POIEvent {
  const { weekId, isMonday, mondayAnchorMs } = isoWeekIdUTC(startMs);
  const { dayId, anchorMs: dayAnchorMs } = dayIdUTC(startMs);

  let st = state.get(symbol);
  if (!st) {
    st = {
      currentWeek: null,
      prevWeek: null,
      monday: null,
      currentDay: null,
      prevDay: null,
    };
    state.set(symbol, st);
  }

  // rollover day?
  if (!st.currentDay || st.currentDay.dayId !== dayId) {
    if (st.currentDay) {
      st.prevDay = { ...st.currentDay };
    }
    st.currentDay = { dayId, dayAnchorMs, open, high, low };
  } else {
    st.currentDay.high = updHigh(st.currentDay.high, high);
    st.currentDay.low = updLow(st.currentDay.low, low);
    if (st.currentDay.open == null) st.currentDay.open = open;
  }

  // rollover minggu?
  if (!st.currentWeek || st.currentWeek.weekId !== weekId) {
    if (st.currentWeek) {
      // pindahkan ke prevWeek
      st.prevWeek = { ...st.currentWeek };
    }
    // buat currentWeek baru
    st.currentWeek = { weekId, open, high, low, weekAnchorMs: mondayAnchorMs };
    // set monday utk minggu ini jika candle di hari Senin
    st.monday = isMonday ? { weekId, open, high, low, mondayAnchorMs } : null;

    return { type: "newWeek", state: st };
  }

  // minggu sama → update weekly highs/lows
  st.currentWeek.high = updHigh(st.currentWeek.high, high);
  st.currentWeek.low = updLow(st.currentWeek.low, low);
  if (st.currentWeek.open == null) st.currentWeek.open = open;

  // monday update
  if (isMonday) {
    if (!st.monday || st.monday.weekId !== weekId) {
      st.monday = { weekId, open, high, low, mondayAnchorMs };
      return { type: "newMonday", state: st };
    } else {
      st.monday.high = updHigh(st.monday.high, high);
      st.monday.low = updLow(st.monday.low, low);
      if (st.monday.open == null) st.monday.open = open;
      return { type: "updateMonday", state: st };
    }
  }

  return { type: "updateWeek", state: st };
}

export function getPOILevels(symbol: string) {
  const st = getPOI(symbol);
  return {
    mondayOpen: st.monday?.open ?? null,
    mondayHigh: st.monday?.high ?? null,
    mondayLow: st.monday?.low ?? null,

    prevWeekOpen: st.prevWeek?.open ?? null,
    prevWeekHigh: st.prevWeek?.high ?? null,
    prevWeekLow: st.prevWeek?.low ?? null,

    prevDayOpen: st.prevDay?.open ?? null,
    prevDayHigh: st.prevDay?.high ?? null,
    prevDayLow: st.prevDay?.low ?? null,

    prevWeekId: st.prevWeek?.weekId ?? null,
    currentWeekId: st.currentWeek?.weekId ?? null,
    currentDayId: st.currentDay?.dayId ?? null,
  };
}

// Fungsi untuk mendapatkan data kline harian
async function getKlineData(
  symbol: string,
  interval: string = "1d",
  limit: number = 200
) {
  try {
    const response = await axios.get(
      "https://api.bybit.com/v2/public/kline/list",
      {
        params: {
          symbol,
          interval, // 1d untuk daily
          limit, // Batasan jumlah data yang diambil
        },
      }
    );
    return response.data.result; // Data kline per hari
  } catch (error) {
    console.error("Error fetching kline data:", error);
    return [];
  }
}

// Fungsi untuk mendapatkan POI (High/Low/Open) berdasarkan kline data
export async function getPOIData(symbol: string) {
  const klineData = await getKlineData(symbol);

  // Ambil data untuk Monday, Previous Week, and Previous Day
  const mondayData = klineData.find(
    (kline: any) => new Date(kline.timestamp * 1000).getDay() === 1
  );
  const prevWeekData = klineData.slice(-7)[0]; // Ambil data kline terakhir untuk minggu sebelumnya
  const prevDayData = klineData[klineData.length - 2]; // Ambil kline untuk hari sebelumnya

  // Extract High, Low, Open
  const mondayHigh = mondayData ? mondayData.high : null;
  const mondayLow = mondayData ? mondayData.low : null;
  const mondayOpen = mondayData ? mondayData.open : null;

  const prevWeekHigh = prevWeekData ? prevWeekData.high : null;
  const prevWeekLow = prevWeekData ? prevWeekData.low : null;
  const prevWeekOpen = prevWeekData ? prevWeekData.open : null;

  const prevDayHigh = prevDayData ? prevDayData.high : null;
  const prevDayLow = prevDayData ? prevDayData.low : null;
  const prevDayOpen = prevDayData ? prevDayData.open : null;

  return {
    mondayHigh,
    mondayLow,
    mondayOpen,
    prevWeekHigh,
    prevWeekLow,
    prevWeekOpen,
    prevDayHigh,
    prevDayLow,
    prevDayOpen,
  };
}
