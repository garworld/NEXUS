const PINBAR_ZONE = 0.4; // zona top/bottom 40%
const BODY_MAX_OF_RANGE = 0.35; // body <= 35% dari range (batasi spinning-top)
const WICK_DOM_RATIO = 1.5; // wick dominan >= 1.5x body
const OPPOSITE_WICK_MAX_RATIO = 1.0; // wick sisi lawan <= 1.0x body (opsional, bisa 999 utk disable)

type CandleClass =
  | "green pinbar"
  | "red pinbar"
  | "green inverted pinbar"
  | "red inverted pinbar"
  | "normal";

export function classifyCandle(
  open: number,
  high: number,
  low: number,
  close: number
): CandleClass {
  if (![open, high, low, close].every(Number.isFinite)) return "normal";
  const range = high - low;
  if (range <= 0) return "normal";

  // ukuran body & wick
  const body = Math.abs(close - open);
  const upperWick = Math.max(0, high - Math.max(open, close));
  const lowerWick = Math.max(0, Math.min(open, close) - low);

  // guard: body tak boleh terlalu besar (hindari candle penuh/body besar)
  const bodyPct = body / range;
  if (bodyPct > BODY_MAX_OF_RANGE) return "normal";

  // posisi BODY (pakai midpoint body), 0=low .. 1=high
  const bodyMid = ((open + close) / 2 - low) / range;
  const inTopZone = bodyMid >= 1 - PINBAR_ZONE; // >= 0.60 jika zone=0.40
  const inBotZone = bodyMid <= PINBAR_ZONE; // <= 0.40

  // aturan pinbar (zona atas: lower wick dominan)
  if (inTopZone) {
    const lowerDominant = lowerWick >= WICK_DOM_RATIO * body;
    const oppOk = upperWick <= OPPOSITE_WICK_MAX_RATIO * body;
    if (lowerDominant && oppOk) {
      return close > open ? "green pinbar" : "red pinbar";
    }
  }

  // aturan inverted pinbar (zona bawah: upper wick dominan)
  if (inBotZone) {
    const upperDominant = upperWick >= WICK_DOM_RATIO * body;
    const oppOk = lowerWick <= OPPOSITE_WICK_MAX_RATIO * body;
    if (upperDominant && oppOk) {
      return close > open ? "green inverted pinbar" : "red inverted pinbar";
    }
  }

  return "normal";
}
