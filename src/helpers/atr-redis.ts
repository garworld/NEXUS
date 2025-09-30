import { getJSON, setJSON } from "./redis";

export type AtrState = {
  count: number; // total bar yang sudah dihitung (info)
  atr?: number; // ATR terakhir (undefined kalau belum siap)
  trBuf: number[]; // buffer TR (tua -> baru), max N
  updatedAt: number; // ms
};

export type AtrStopState = {
  mode: "long" | "short"; // arah aktif
  upper?: number; // final upper band (aktif saat mode=short)
  lower?: number; // final lower band (aktif saat mode=long)
  stop?: number; // garis stop yang dipakai (priceATR)
  updatedAt: number;
};

// key helper
const atrKeyTf = (symbol: string, tf: number) => `atr:${tf}m:${symbol}`;

export const atrStopKeyTf = (symbol: string, tf: number) =>
  `atrstop:${tf}m:${symbol}`;

// config (bisa dari .env juga)
const ATR_PERIOD = Number(process.env.ATR_PERIOD ?? 14);
const ATR_MIN_SEED = Number(process.env.ATR_MIN_SEED ?? 5); // kamu minta min 5 TR
const ATR_TRBUF_MAX = ATR_PERIOD + 1;

export async function loadAtrState(
  symbol: string,
  tf: number
): Promise<AtrState> {
  const key = atrKeyTf(symbol, tf);
  const state = await getJSON<AtrState>(key);
  if (state && Array.isArray(state.trBuf)) return state;
  return { count: 0, atr: undefined, trBuf: [], updatedAt: Date.now() };
}

export async function saveAtrState(
  symbol: string,
  tf: number,
  state: AtrState
) {
  const key = atrKeyTf(symbol, tf);
  // optional: clamp trBuf length sebelum simpan (jaga ukuran Redis)
  if (state.trBuf.length > ATR_TRBUF_MAX) {
    state.trBuf = state.trBuf.slice(-ATR_TRBUF_MAX);
  }
  await setJSON(key, state);
}

function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

export function updateAtrWithTrBuffer(
  prev: AtrState,
  tr: number,
  period: number,
  minSeed: number
): AtrState {
  const buf = (prev.trBuf ?? []).concat(tr);
  if (buf.length > ATR_TRBUF_MAX) buf.shift();

  const len = buf.length;
  let atrNow = prev.atr;
  const nextCount = (prev.count ?? 0) + 1;

  if (len < minSeed) {
    return {
      count: nextCount,
      atr: undefined,
      trBuf: buf,
      updatedAt: Date.now(),
    };
  }
  if (len === period) {
    atrNow = mean(buf); // seed textbook (SMA N bar)
    return { count: nextCount, atr: atrNow, trBuf: buf, updatedAt: Date.now() };
  }
  if (len > period) {
    atrNow = ((atrNow as number) * (period - 1) + tr) / period; // Wilder
    return { count: nextCount, atr: atrNow, trBuf: buf, updatedAt: Date.now() };
  }
  return {
    count: nextCount,
    atr: undefined,
    trBuf: buf,
    updatedAt: Date.now(),
  };
}

export function updateAtrTrailingStop(
  prev: AtrStopState | undefined,
  high: number,
  low: number,
  close: number,
  atr: number,
  mult: number
): AtrStopState {
  const hl2 = (high + low) / 2;
  console.log({ high, low });
  const basicUpper = hl2 + mult * atr;
  const basicLower = hl2 - mult * atr;
  console.log({ mult, atr, prev });
  console.log({ hl2, basicUpper, basicLower });

  let mode: "long" | "short" = prev?.mode ?? "long";
  let prevUpper = prev?.upper;
  let prevLower = prev?.lower;

  // trailing (carry previous side)
  let finalUpper = basicUpper;
  let finalLower = basicLower;

  if (mode === "long" && Number.isFinite(prevLower as number)) {
    finalLower = Math.max(basicLower, prevLower as number);
  }
  if (mode === "short" && Number.isFinite(prevUpper as number)) {
    finalUpper = Math.min(basicUpper, prevUpper as number);
  }

  // flip bila ditembus
  if (mode === "long" && close < finalLower) {
    mode = "short";
    // saat flip ke short, seed upper dari basicUpper (bisa juga finalUpper)
    finalUpper = basicUpper;
  } else if (mode === "short" && close > finalUpper) {
    mode = "long";
    // saat flip ke long, seed lower dari basicLower
    finalLower = basicLower;
  }

  const stop = mode === "short" ? finalUpper : finalLower;
  console.log({
    mode,
    upper: finalUpper,
    lower: finalLower,
    stop,
  });

  return {
    mode,
    upper: finalUpper,
    lower: finalLower,
    stop,
    updatedAt: Date.now(),
  };
}

export function atrGateOk(
  direction: "bullish" | "bearish",
  price: number,
  stop: number | undefined,
  epsPct = 0 // mis. 0.05 untuk toleransi 0.05%
): boolean {
  if (!Number.isFinite(stop as number) || !Number.isFinite(price)) return true; // kalau belum siap, jangan blok
  const eps = (epsPct / 100) * price;
  return direction === "bullish"
    ? price >= (stop as number) - eps
    : price <= (stop as number) + eps;
}
