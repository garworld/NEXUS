// aggregator-5m.ts
type Side = "Buy" | "Sell";

export type FiveMinResult = {
  symbol: string;
  start: number; // bucket start ms
  end: number; // bucket end ms (exclusive)
  lastPrice: number; // harga terakhir close candle

  // volume trade (basis asset)
  buyVol: number;
  sellVol: number;
  delta: number; // buyVol - sellVol (basis asset)
  tradeCount: number; // jumlah trade dalam 5 menit
  tradeVolume: number; // total size (buy+sell) dalam 5 menit (basis asset)

  // OI (pakai openInterestValue = USD)
  oiClose?: number; // USD
  // optional OHLC jika enabled
  oiOpen?: number;
  oiHigh?: number;
  oiLow?: number;

  // NEW: perubahan OI antar-candle (USD)
  oiChange?: number; // oiClose(now) - oiClose(prev)

  // --- Liquidations (NOTIONAL / USDT or USD) ---
  liquidationVol?: number; // total (buy+sell)
  liquidationBuyVol?: number; // optional breakdown
  liquidationSellVol?: number; // optional breakdown
  liquidationCount?: number; // jumlah event liquidation

  // OHLC harga di dalam bucket 5 menit (opsional jika pakai onKline)
  open?: number;
  high?: number;
  low?: number;
  close?: number;
};

type AggConfig = {
  intervalMs?: number; // default 5m
  useOiOhlc?: boolean; // default false (hemat)
  onFlush: (rows: FiveMinResult[]) => void; // dipanggil tiap bucket close
  now?: () => number; // for testing
  flushGraceMs?: number; // default 1500 ms
};

type Bucket = {
  start: number;
  end: number;
  buyVol: number;
  sellVol: number;
  tradeCount: number;
  tradeVolume: number;
  lastPriceClose?: number;

  // OI (USD dari openInterestValue)
  oiClose?: number;
  oiOpen?: number;
  oiHigh?: number;
  oiLow?: number;
  // (oiChange dihitung saat flush, tidak disimpan di bucket)

  // liquidation aggregates (NOTIONAL)
  liquidationBuyVol: number;
  liquidationSellVol: number;
  liquidationCount: number;

  // harga OHLC dari kline (optional)
  o?: number; // open
  h?: number; // high
  l?: number; // low
  c?: number; // close
};

export class FiveMinAggregator {
  private readonly interval: number;
  private readonly useOiOhlc: boolean;
  private readonly onFlush: (rows: FiveMinResult[]) => void;
  private readonly now: () => number;
  private readonly graceMs: number;

  // state per symbol untuk bucket aktif
  private buckets = new Map<string, Map<number, Bucket>>();

  // cache OI USD (openInterestValue) & last price terakhir per symbol
  private lastOi = new Map<string, number>(); // USD
  private lastPx = new Map<string, number>();

  // NEW: menyimpan oiClose (USD) candle terakhir yang sudah ter-flush per symbol
  private prevOiCloseFlushed = new Map<string, number>();

  private timer?: NodeJS.Timeout;

  constructor(cfg: AggConfig) {
    this.interval = cfg.intervalMs ?? 5 * 60 * 1000;
    this.useOiOhlc = cfg.useOiOhlc ?? false;
    this.onFlush = cfg.onFlush;
    this.now = cfg.now ?? Date.now;
    this.graceMs = cfg.flushGraceMs ?? 1500;
  }

  /** Mulai timer flush yang sinkron dengan boundary interval (default 5 menit) */
  start() {
    this.stop();
    const alignDelay = this.msUntilNextBoundaryPlusGrace();
    this.timer = setTimeout(() => {
      this.flushAndRoll();
      this.timer = setInterval(() => {
        this.flushAndRoll();
      }, this.interval) as unknown as NodeJS.Timeout;
      (this.timer as any).unref?.();
    }, alignDelay) as unknown as NodeJS.Timeout;
    (this.timer as any).unref?.();
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      // @ts-ignore: setInterval type
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Catat trade dari WS publicTrade (basis asset) */
  onTrade(symbol: string, side: Side, size: number, tsMs: number) {
    const { start, end } = this.bucketBounds(tsMs);
    const now = this.now();
    if (tsMs < now - this.interval * 2) return; // drop trade yang sangat telat

    const b = this.getOrInitBucket(symbol, start, end);
    if (side === "Buy") b.buyVol += size;
    else b.sellVol += size;

    b.tradeCount += 1;
    b.tradeVolume += size;
  }

  /** Catat last price dari WS tickers */
  onLastPrice(symbol: string, lastPrice: number, tsMs?: number) {
    if (lastPrice == null || !Number.isFinite(lastPrice)) return;
    this.lastPx.set(symbol, lastPrice);

    const at = tsMs ?? this.now();
    const { start, end } = this.bucketBounds(at);
    const b = this.getOrInitBucket(symbol, start, end);

    // simpan "close" harga terakhir terlihat
    b.lastPriceClose = lastPrice;
  }

  /**
   * Catat OI dari WS tickers
   * PAKAI: openInterestValue (USD)
   * Contoh pemanggilan:
   *   if (tk.openInterestValue !== undefined) agg.onOpenInterest(symbol, tk.openInterestValue, tkTs);
   */
  onOpenInterest(symbol: string, oiUsd?: number, tsMs?: number) {
    if (oiUsd == null || !Number.isFinite(oiUsd)) return;
    this.lastOi.set(symbol, oiUsd);

    const at = tsMs ?? this.now();
    const { start, end } = this.bucketBounds(at);
    const b = this.getOrInitBucket(symbol, start, end);

    b.oiClose = oiUsd;
    if (this.useOiOhlc) {
      if (b.oiOpen == null) b.oiOpen = oiUsd;
      b.oiHigh = b.oiHigh == null ? oiUsd : Math.max(b.oiHigh, oiUsd);
      b.oiLow = b.oiLow == null ? oiUsd : Math.min(b.oiLow, oiUsd);
    }
  }

  /** Catat liquidation dari WS all_liquidation_stream (S, v, T) */
  onLiquidation(
    symbol: string,
    side: Side,
    size: number,
    tsMs: number,
    price?: number
  ) {
    const { start, end } = this.bucketBounds(tsMs);
    const now = this.now();
    if (tsMs < now - this.interval * 2) return;

    // resolve harga untuk konversi notional
    const px = Number.isFinite(price as number)
      ? (price as number)
      : this.lastPx.get(symbol);
    if (px == null || !Number.isFinite(px)) {
      // kalau tak ada harga sama sekali, skip agar tidak memasukkan 0 yang menyesatkan
      return;
    }
    const notional = size * px;

    const b = this.getOrInitBucket(symbol, start, end);
    if (side === "Buy") b.liquidationBuyVol += notional;
    else b.liquidationSellVol += notional;

    b.liquidationCount += 1;
  }

  /** Isi OHLC dari stream Kline (gunakan hanya saat confirm=true) */
  onKline(
    symbol: string,
    start: number,
    end: number,
    open: number,
    high: number,
    low: number,
    close: number,
    confirm: boolean
  ) {
    if (!confirm) return;
    // validasi durasi ~ interval
    const dur = end - start;
    if (Math.abs(dur - this.interval) > 2000) return;

    const b = this.getOrInitBucket(symbol, start, end);
    b.o = open;
    b.h = high;
    b.l = low;
    b.c = close;

    // sinkronkan lastPriceClose agar lastPrice result = close
    b.lastPriceClose = close;
  }

  /** Flush paksa (mis. saat shutdown) */
  flushNow() {
    const rows: FiveMinResult[] = [];

    for (const [symbol, byStart] of this.buckets) {
      const list = [...byStart.values()].sort((a, b) => a.start - b.start);
      let prevOi = this.prevOiCloseFlushed.get(symbol);

      for (const b of list) {
        const row = this.buildRow(symbol, b, prevOi);
        rows.push(row);
        if (b.oiClose != null && Number.isFinite(b.oiClose)) prevOi = b.oiClose;
      }

      if (prevOi != null) this.prevOiCloseFlushed.set(symbol, prevOi);
      console.log({ prevOi });
    }

    this.buckets.clear();
    if (rows.length) this.onFlush(rows);
  }

  // -------- internals --------
  private getOrInitBucket(symbol: string, start: number, end: number): Bucket {
    let byStart = this.buckets.get(symbol);
    if (!byStart) {
      byStart = new Map();
      this.buckets.set(symbol, byStart);
    }
    let b = byStart.get(start);
    if (!b) {
      b = {
        start,
        end,
        buyVol: 0,
        sellVol: 0,
        tradeCount: 0,
        tradeVolume: 0,
        lastPriceClose: this.lastPx.get(symbol),

        // seed OI dengan nilai USD terbaru
        oiClose: this.lastOi.get(symbol),

        liquidationBuyVol: 0,
        liquidationSellVol: 0,
        liquidationCount: 0,
      };

      if (this.useOiOhlc) {
        const seed = this.lastOi.get(symbol);
        b.oiOpen = seed ?? undefined;
        b.oiHigh = seed ?? undefined;
        b.oiLow = seed ?? undefined;
      }

      byStart.set(start, b);

      // opsional: batasi jumlah bucket aktif per symbol agar hemat memori
      if (byStart.size > 4) {
        const keys = [...byStart.keys()].sort((a, c) => a - c);
        while (byStart.size > 4) byStart.delete(keys.shift()!);
      }
    }
    return b;
  }

  private flushAndRoll() {
    // flush semua bucket yang end <= boundaryNow
    const boundaryNow = Math.floor(this.now() / this.interval) * this.interval;
    const rows: FiveMinResult[] = [];

    for (const [symbol, byStart] of this.buckets) {
      const closables: Bucket[] = [];
      for (const [start, b] of byStart) {
        if (b.end <= boundaryNow) {
          closables.push(b);
          byStart.delete(start);
        }
      }

      if (closables.length) {
        closables.sort((a, b) => a.start - b.start);
        let prevOi = this.prevOiCloseFlushed.get(symbol);

        for (const b of closables) {
          const row = this.buildRow(symbol, b, prevOi);
          rows.push(row);
          if (b.oiClose != null && Number.isFinite(b.oiClose))
            prevOi = b.oiClose;
        }

        if (prevOi != null) this.prevOiCloseFlushed.set(symbol, prevOi);
      }

      if (byStart.size === 0) this.buckets.delete(symbol);
    }

    if (rows.length) this.onFlush(rows);
  }

  private msUntilNextBoundaryPlusGrace() {
    const now = this.now();
    const nextBoundary = Math.ceil(now / this.interval) * this.interval;
    return Math.max(0, nextBoundary + this.graceMs - now);
  }

  private buildRow(symbol: string, b: Bucket, prevOi?: number): FiveMinResult {
    const liquidationVol = b.liquidationBuyVol + b.liquidationSellVol;

    const oiClose = b.oiClose;
    const oiChange =
      oiClose != null &&
      Number.isFinite(oiClose) &&
      prevOi != null &&
      Number.isFinite(prevOi)
        ? oiClose - prevOi
        : undefined;

    return {
      symbol,
      start: b.start,
      end: b.end,

      // kalau ada close (c) dari kline, pakai itu; else fallback cache
      lastPrice: (b.c ??
        this.resolveLastPrice(symbol, b.lastPriceClose)) as number,

      buyVol: b.buyVol,
      sellVol: b.sellVol,
      delta: b.buyVol - b.sellVol,
      tradeCount: b.tradeCount,
      tradeVolume: b.tradeVolume,

      oiClose, // USD
      ...(this.useOiOhlc
        ? { oiOpen: b.oiOpen, oiHigh: b.oiHigh, oiLow: b.oiLow }
        : {}),
      oiChange, // USD

      liquidationVol,
      liquidationBuyVol: b.liquidationBuyVol,
      liquidationSellVol: b.liquidationSellVol,
      liquidationCount: b.liquidationCount,

      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
    };
  }

  private resolveLastPrice(symbol: string, closeFromBucket?: number): number {
    if (closeFromBucket != null && Number.isFinite(closeFromBucket))
      return closeFromBucket;
    const cached = this.lastPx.get(symbol);
    return cached != null && Number.isFinite(cached) ? cached : NaN;
  }

  private bucketBounds(ts: number) {
    const start = Math.floor(ts / this.interval) * this.interval;
    return { start, end: start + this.interval };
  }
}
