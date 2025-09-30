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
  mondayLive?: MondayPOI | null;
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

type BybitKlineTuple = [string, string, string, string, string, string, string];

type KlineBar = {
  ts: number; // start time (ms, UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
};

const state = new Map<string, POIState>();

export function getPOI(symbol: string): POIState {
  return (
    state.get(symbol) ?? {
      currentWeek: null,
      prevWeek: null,
      monday: null,
      mondayLive: null,
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
      mondayLive: null,
      currentDay: null,
      prevDay: null,
    };
    state.set(symbol, st);
  }

  if (
    !isMonday &&
    st.mondayLive &&
    st.currentWeek &&
    st.mondayLive.weekId === st.currentWeek.weekId
  ) {
    st.monday = { ...st.mondayLive }; // promote jadi final
    st.mondayLive = null;
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
    // st.monday = isMonday ? { weekId, open, high, low, mondayAnchorMs } : null;

    if (isMonday) {
      st.mondayLive = { weekId, open, high, low, mondayAnchorMs };
    } else {
      st.mondayLive = null;
    }

    return { type: "newWeek", state: st };
  }

  // minggu sama → update weekly highs/lows
  st.currentWeek.high = updHigh(st.currentWeek.high, high);
  st.currentWeek.low = updLow(st.currentWeek.low, low);
  if (st.currentWeek.open == null) st.currentWeek.open = open;

  // monday update
  if (isMonday) {
    if (!st.mondayLive || st.mondayLive.weekId !== weekId) {
      st.mondayLive = { weekId, open, high, low, mondayAnchorMs };
      return { type: "newMonday", state: st };
    } else {
      st.mondayLive.high = updHigh(st.mondayLive.high, high);
      st.mondayLive.low = updLow(st.mondayLive.low, low);
      if (st.mondayLive.open == null) st.mondayLive.open = open;
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

/** Normalisasi tuple v5 -> object & sort ascending */
function normalizeV5(list: BybitKlineTuple[]): KlineBar[] {
  const rows = (list || []).map((t) => ({
    ts: Number(t[0]),
    open: Number(t[1]),
    high: Number(t[2]),
    low: Number(t[3]),
    close: Number(t[4]),
    volume: Number(t[5]),
    turnover: Number(t[6]),
  }));
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

/** Ambil kline harian via Bybit v5 (interval "D") */
async function getKlineDataV5Daily(
  symbol: string,
  category: "linear" | "inverse" | "spot" = "linear",
  limit = 60
): Promise<KlineBar[]> {
  const { data } = await axios.get("https://api.bybit.com/v5/market/kline", {
    params: {
      category,
      symbol,
      interval: "D", // daily
      limit, // default 200, maks 1000
    },
  });

  if (data?.retCode !== 0) {
    throw new Error(`Bybit error: ${data?.retMsg ?? "Unknown error"}`);
  }

  const list: BybitKlineTuple[] = data?.result?.list ?? [];
  return normalizeV5(list);
}

function utcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function mondayUTCOfWeek(refMs: number): number {
  const d = new Date(refMs);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const todayMid = utcMidnight(refMs);
  const diffToMon = (dow + 6) % 7;
  return todayMid - diffToMon * 86400000;
}

/** Hasil seed REST (tambahan close utk konsumsi eksternal) */
export type BootstrapPOIResult = {
  monday?: {
    open: number;
    high: number;
    low: number;
    close: number;
    weekId: string;
    mondayAnchorMs: number;
  };
  prevWeek?: {
    open: number;
    high: number;
    low: number;
    close: number;
    weekId: string;
    weekAnchorMs: number;
  };
  prevDay?: {
    open: number;
    high: number;
    low: number;
    close: number;
    dayId: string;
    dayAnchorMs: number;
  };
};

/**
 * Seed POI saat start: ambil Monday (UTC) minggu ini (jika sudah closed),
 * Previous Week (UTC) [Mon prev, Mon this), dan Previous Day (UTC).
 * currentDay/currentWeek dibiarkan null agar di-update live oleh websocket.
 */
export async function bootstrapPOIFromREST(
  symbol: string,
  opts?: { category?: "linear" | "inverse" | "spot"; lookbackDays?: number }
): Promise<BootstrapPOIResult> {
  const category = opts?.category ?? "linear";
  const lookbackDays = Math.max(21, opts?.lookbackDays ?? 60);

  const klines = await getKlineDataV5Daily(symbol, category, lookbackDays);
  const nowMid = utcMidnight(Date.now());
  const monThis = mondayUTCOfWeek(Date.now());
  const monPrev = monThis - 7 * 86400000;

  // --- Prev Day ---
  const prevDayAnchor = nowMid - 86400000;
  const prevDayBar = klines.find((k) => utcMidnight(k.ts) === prevDayAnchor);
  const prevDay = prevDayBar
    ? (() => {
        const { dayId, anchorMs } = dayIdUTC(prevDayBar.ts);
        return {
          open: prevDayBar.open,
          high: prevDayBar.high,
          low: prevDayBar.low,
          close: prevDayBar.close,
          dayId,
          dayAnchorMs: anchorMs,
        };
      })()
    : undefined;

  // --- Monday (minggu ini, hanya jika sudah closed = Selasa UTC atau lebih) ---
  const mondayBar =
    nowMid >= monThis + 86400000
      ? klines.find((k) => utcMidnight(k.ts) === monThis)
      : undefined;
  const monday = mondayBar
    ? (() => {
        const { weekId } = isoWeekIdUTC(mondayBar.ts);
        return {
          open: mondayBar.open,
          high: mondayBar.high,
          low: mondayBar.low,
          close: mondayBar.close,
          weekId,
          mondayAnchorMs: monThis,
        };
      })()
    : undefined;

  // --- Prev Week range [MonPrev, MonThis) ---
  const weekSlice = klines.filter((k) => k.ts >= monPrev && k.ts < monThis);
  const prevWeek =
    weekSlice.length > 0
      ? (() => {
          const open = weekSlice[0].open;
          const close = weekSlice[weekSlice.length - 1].close;
          const high = weekSlice.reduce(
            (mx, k) => Math.max(mx, k.high),
            -Infinity
          );
          const low = weekSlice.reduce(
            (mn, k) => Math.min(mn, k.low),
            Infinity
          );
          const { weekId } = isoWeekIdUTC(monPrev);
          return {
            open,
            high: Number.isFinite(high) ? high : open,
            low: Number.isFinite(low) ? low : open,
            close,
            weekId,
            weekAnchorMs: monPrev,
          };
        })()
      : undefined;

  // --- Commit ke state: hanya prevDay/prevWeek/monday; biarkan currentDay/currentWeek tetap null ---
  const st = getPOI(symbol);

  if (prevDay) {
    st.prevDay = {
      dayId: prevDay.dayId,
      dayAnchorMs: prevDay.dayAnchorMs,
      open: prevDay.open,
      high: prevDay.high,
      low: prevDay.low,
    };
  }

  if (prevWeek) {
    st.prevWeek = {
      weekId: prevWeek.weekId,
      weekAnchorMs: prevWeek.weekAnchorMs,
      open: prevWeek.open,
      high: prevWeek.high,
      low: prevWeek.low,
    };
  }

  if (monday) {
    st.monday = {
      weekId: monday.weekId,
      mondayAnchorMs: monday.mondayAnchorMs,
      open: monday.open,
      high: monday.high,
      low: monday.low,
    };
  }

  // Jangan set st.currentDay / st.currentWeek → biarkan websocket yang mengisi
  setPOI(symbol, st);

  return { monday, prevWeek, prevDay };
}
