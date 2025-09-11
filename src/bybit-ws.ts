// bybit-ws.ts
import WebSocket from "ws";

type Market = "linear" | "inverse" | "spot";
type Net = "mainnet" | "testnet";

const WS_ENDPOINT: Record<Net, Record<Market, string>> = {
  mainnet: {
    spot: "wss://stream.bybit.com/v5/public/spot",
    linear: "wss://stream.bybit.com/v5/public/linear",
    inverse: "wss://stream.bybit.com/v5/public/inverse",
  },
  testnet: {
    spot: "wss://stream-testnet.bybit.com/v5/public/spot",
    linear: "wss://stream-testnet.bybit.com/v5/public/linear",
    inverse: "wss://stream-testnet.bybit.com/v5/public/inverse",
  },
};

export type Side = "Buy" | "Sell";

export type BybitTrade = {
  symbol: string; // e.g. BTCUSDT
  side: Side;
  price: number;
  size: number;
  ts: number; // ms
  raw?: any;
};

// Penting: semua field opsional karena WS bisa kirim partial update
export type BybitTicker = {
  symbol: string;
  tickDirection?: string;
  lastPrice?: number;
  prevPrice24h?: number;
  highPrice24h?: number;
  lowPrice24h?: number;
  prevPrice1h?: number;
  markPrice?: number;
  indexPrice?: number;
  openInterest?: number;
  openInterestValue?: number;
  turnover24h?: number;
  volume24h?: number;
  nextFundingTime?: number; // ms
  fundingRate?: number;
  bid1Price?: number;
  bid1Size?: number;
  ask1Price?: number;
  ask1Size?: number;
  raw?: any;
};

/** Event dari all_liquidation_stream */
export type BybitLiquidation = {
  symbol: string; // e.g. ROSEUSDT
  side: Side; // "Buy" artinya long yang kena likuid (executed buy)
  size: number; // executed size (basis asset)
  price?: number; // bankruptcy/trigger price kalau tersedia (p)
  ts: number; // ms (T)
  raw?: any;
};

export type BybitKline = {
  symbol: string; // e.g. BTCUSDT
  interval: string; // "1" | "3" | "5" | "15" | "30" | "60" | ... | "D" | "W" | "M"
  start: number; // ms
  end: number; // ms
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number; // trade volume (basis asset)
  turnover: number; // quote turnover
  confirm: boolean; // candle closed or not
  timestamp: number; // last matched order ts in this candle (ms)
  raw?: any;
};

type Opts = {
  net?: Net; // default: 'mainnet'
  market?: Market; // default: 'linear'
  log?: (msg: string, ...a: any[]) => void;
  pingIntervalMs?: number; // default: 20_000
  maxBackoffMs?: number; // default: 30_000
};

type Topic =
  | `publicTrade.${string}`
  | `tickers.${string}`
  | `allLiquidation.${string}`
  | `kline.${string}.${string}`;

export class BybitPublicTradesWS {
  private url: string;
  private ws?: WebSocket;
  private closed = false;

  /** Set topik aktif agar auto re-subscribe saat reconnect */
  private subs = new Set<Topic>();

  /** Cache ticker per-symbol untuk merge partial update */
  private tickerStore = new Map<string, BybitTicker>();

  /** Handlers */
  private onMessageHandlers = new Set<
    (t: BybitTrade | BybitTicker | BybitLiquidation) => void
  >();
  private onTradeHandlers = new Set<(t: BybitTrade) => void>();
  private onTickerHandlers = new Set<(t: BybitTicker) => void>();
  private onLiquidationHandlers = new Set<(t: BybitLiquidation) => void>();
  private onKlineHandlers = new Set<(t: BybitKline) => void>();

  /** timers & backoff */
  private pingTimer?: NodeJS.Timeout;
  private backoff = 1000;
  private readonly maxBackoff: number;
  private readonly log: (msg: string, ...a: any[]) => void;
  private readonly pingInterval: number;

  constructor(opts: Opts = {}) {
    const net = opts.net ?? "mainnet";
    const market = opts.market ?? "linear";
    this.url = WS_ENDPOINT[net][market];
    this.log = opts.log ?? (() => {});
    this.pingInterval = opts.pingIntervalMs ?? 20_000;
    this.maxBackoff = opts.maxBackoffMs ?? 30_000;
  }

  /** connect (or reconnect) */
  connect() {
    this.closed = false;
    this.ws = new WebSocket(this.url);
    this.attach();
  }

  /** stop completely */
  close() {
    this.closed = true;
    this.clearPing();
    try {
      this.ws?.close();
    } catch {}
  }

  // ---------- Public API: Register handlers ----------
  onMessage(fn: (t: BybitTrade | BybitTicker | BybitLiquidation) => void) {
    this.onMessageHandlers.add(fn);
    return () => this.onMessageHandlers.delete(fn);
  }

  onTrade(fn: (t: BybitTrade) => void) {
    this.onTradeHandlers.add(fn);
    return () => this.onTradeHandlers.delete(fn);
  }

  onTicker(fn: (t: BybitTicker) => void) {
    this.onTickerHandlers.add(fn);
    return () => this.onTickerHandlers.delete(fn);
  }

  onLiquidation(fn: (t: BybitLiquidation) => void) {
    this.onLiquidationHandlers.add(fn);
    return () => this.onLiquidationHandlers.delete(fn);
  }

  onKline(fn: (t: BybitKline) => void) {
    this.onKlineHandlers.add(fn);
    return () => this.onKlineHandlers.delete(fn);
  }

  // ---------- Public API: Subscribe / Unsubscribe ----------
  subscribeTrades(symbols: string[]) {
    const topics = symbols.map((s) => `publicTrade.${s}` as Topic);
    for (const t of topics) this.subs.add(t);
    this.flushSubs("subscribe", topics);
  }

  unsubscribeTrades(symbols: string[]) {
    const topics = symbols.map((s) => `publicTrade.${s}` as Topic);
    this.flushSubs("unsubscribe", topics);
    for (const t of topics) this.subs.delete(t);
  }

  subscribeTickers(symbols: string[]) {
    const topics = symbols.map((s) => `tickers.${s}` as Topic);
    for (const t of topics) this.subs.add(t);
    this.flushSubs("subscribe", topics);
  }

  unsubscribeTickers(symbols: string[]) {
    const topics = symbols.map((s) => `tickers.${s}` as Topic);
    this.flushSubs("unsubscribe", topics);
    for (const t of topics) this.subs.delete(t);
  }

  /** Subscribe ke stream liquidation */
  subscribeLiquidations(symbols: string[]) {
    const topics = symbols.map((s) => `allLiquidation.${s}` as Topic);
    for (const t of topics) this.subs.add(t);
    this.flushSubs("subscribe", topics);
  }

  unsubscribeLiquidations(symbols: string[]) {
    const topics = symbols.map((s) => `allLiquidation.${s}` as Topic);
    this.flushSubs("unsubscribe", topics);
    for (const t of topics) this.subs.delete(t);
  }

  /** Subscribe Kline. interval bisa "1","3","5","15","30","60","120","240","360","720","D","W","M" */
  subscribeKlines(interval: string | number, symbols: string[]) {
    const itv = String(interval); // jaga-jaga kalau number
    const topics = symbols.map((s) => `kline.${itv}.${s}` as Topic);
    for (const t of topics) this.subs.add(t);
    this.flushSubs("subscribe", topics);
  }

  unsubscribeKlines(interval: string | number, symbols: string[]) {
    const itv = String(interval);
    const topics = symbols.map((s) => `kline.${itv}.${s}` as Topic);
    this.flushSubs("unsubscribe", topics);
    for (const t of topics) this.subs.delete(t);
  }

  /** Optional: akses snapshot ticker yang sudah di-merge untuk symbol tertentu */
  getTicker(symbol: string): BybitTicker | undefined {
    return this.tickerStore.get(symbol);
  }

  // ---------------- Internals ----------------
  private attach() {
    if (!this.ws) return;

    this.ws.on("open", () => {
      this.log(`[BybitWS] connected ${this.url}`);
      this.backoff = 1000;
      this.startPing();
      // re-subscribe semua topik aktif
      this.flushSubs("subscribe", [...this.subs]);
    });

    this.ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString());

        // ping/pong & status event
        if (msg.op === "pong") return;
        if (msg.event === "sub" || msg.event === "unsub") {
          this.log(`[BybitWS] ${msg.event} result`, msg);
          return;
        }

        const topic: string | undefined = msg.topic;

        // ---- publicTrade handler ----
        if (topic?.startsWith("publicTrade.")) {
          const arr = Array.isArray(msg.data) ? msg.data : [msg.data];
          for (const d of arr) {
            const trade: BybitTrade = {
              symbol: d.s ?? d.symbol,
              side: (d.S ?? d.side) as Side,
              price: toNum(d.p ?? d.price)!,
              size: toNum(d.v ?? d.size)!,
              ts: toNum(d.T ?? d.ts)!,
              raw: d,
            };
            this.onTradeHandlers.forEach((fn) => fn(trade));
            this.onMessageHandlers.forEach((fn) => fn(trade));
          }
          return;
        }

        // ---- tickers handler (merge partial to cache) ----
        if (topic?.startsWith("tickers.")) {
          const arr = Array.isArray(msg.data) ? msg.data : [msg.data];
          for (const d of arr) {
            const merged = this.upsertTicker(d);
            // fire events dengan snapshot hasil merge
            this.onTickerHandlers.forEach((fn) => fn(merged));
            this.onMessageHandlers.forEach((fn) => fn(merged));
          }
          return;
        }

        // ---- liquidation handler ----
        if (topic?.startsWith("allLiquidation.")) {
          const arr = Array.isArray(msg.data) ? msg.data : [msg.data];
          for (const d of arr) {
            // sesuai docs/screenshoot: T,s,S,v,p
            const ev: BybitLiquidation = {
              symbol: d.s ?? d.symbol,
              side: (d.S ?? d.side) as Side,
              size: toNum(d.v)!,
              price: toNum(d.p), // bankruptcy price (opsional)
              ts: toNum(d.T ?? d.ts)!,
              raw: d,
            };
            this.onLiquidationHandlers.forEach((fn) => fn(ev));
            this.onMessageHandlers.forEach((fn) => fn(ev));
            // this.log(`[LIQUIDATION] result`, d);
          }
          return;
        }

        // ---- kline handler ----
        if (topic?.startsWith("kline.")) {
          const arr = Array.isArray(msg.data) ? msg.data : [msg.data];

          // ambil interval dari topic
          const parts = topic.split(".");
          const intervalFromTopic = parts[1];

          for (const d of arr) {
            const k: BybitKline = {
              symbol: (d.symbol ?? d.s ?? parts[2]) as string,
              interval: String(d.interval ?? intervalFromTopic),
              start: toNum(d.start)!,
              end: toNum(d.end)!,
              open: toNum(d.open)!,
              close: toNum(d.close)!,
              high: toNum(d.high)!,
              low: toNum(d.low)!,
              volume: toNum(d.volume)!,
              turnover: toNum(d.turnover)!,
              confirm: Boolean(d.confirm),
              timestamp: toNum(d.timestamp)!,
              raw: d,
            };

            this.onKlineHandlers.forEach((fn) => fn(k));
            this.onMessageHandlers.forEach((fn) => fn(k));
          }
          return;
        }

        // Optional debug:
        // this.log(`[BybitWS] msg`, msg);
      } catch (e) {
        this.log(`[BybitWS] parse error`, e);
      }
    });

    this.ws.on("close", (code) => {
      this.log(`[BybitWS] closed ${code}`);
      this.clearPing();
      if (!this.closed) this.reconnect();
    });

    this.ws.on("error", (err) => {
      this.log(`[BybitWS] error`, err);
      try {
        this.ws?.close();
      } catch {}
    });
  }

  private reconnect() {
    if (this.closed) return;
    const delay = Math.min(this.backoff, this.maxBackoff);
    this.log(`[BybitWS] reconnect in ${delay}ms`);
    setTimeout(() => {
      if (this.closed) return;
      this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
      this.ws = new WebSocket(this.url);
      this.attach();
    }, delay);
  }

  /** Kirim payload subscribe/unsubscribe. Bisa di-override args (topik) */
  private flushSubs(op: "subscribe" | "unsubscribe", args?: Topic[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payloadArgs = (args ?? [...this.subs]) as string[];
    if (payloadArgs.length === 0) return;
    const payload = { op, args: payloadArgs };
    this.ws.send(JSON.stringify(payload));
  }

  private startPing() {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ op: "ping" }));
      } catch {}
    }, this.pingInterval);
    this.pingTimer.unref?.();
  }

  private clearPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  // ---------- Ticker merging ----------
  /** Merge partial update dari Bybit ke snapshot lokal per-symbol. */
  private upsertTicker(d: any): BybitTicker {
    const symbol: string = d.symbol ?? d.s;
    if (!symbol) {
      // jika tak ada symbol, abaikan
      return { symbol: "UNKNOWN", raw: d };
    }

    const prev = this.tickerStore.get(symbol) ?? { symbol };

    const next: BybitTicker = {
      ...prev, // base: nilai sebelumnya
      symbol,
      // update hanya jika ada value baru (undefined tidak menimpa)
      tickDirection: pickStr(d.tickDirection, prev.tickDirection),
      lastPrice: pickNum(d.lastPrice, prev.lastPrice),
      prevPrice24h: pickNum(d.prevPrice24h, prev.prevPrice24h),
      highPrice24h: pickNum(d.highPrice24h, prev.highPrice24h),
      lowPrice24h: pickNum(d.lowPrice24h, prev.lowPrice24h),
      prevPrice1h: pickNum(d.prevPrice1h, prev.prevPrice1h),
      markPrice: pickNum(d.markPrice, prev.markPrice),
      indexPrice: pickNum(d.indexPrice, prev.indexPrice),
      openInterest: pickNum(d.openInterest, prev.openInterest),
      openInterestValue: pickNum(d.openInterestValue, prev.openInterestValue),
      turnover24h: pickNum(d.turnover24h, prev.turnover24h),
      volume24h: pickNum(d.volume24h, prev.volume24h),
      nextFundingTime: pickNum(d.nextFundingTime, prev.nextFundingTime),
      fundingRate: pickNum(d.fundingRate, prev.fundingRate),
      bid1Price: pickNum(d.bid1Price, prev.bid1Price),
      bid1Size: pickNum(d.bid1Size, prev.bid1Size),
      ask1Price: pickNum(d.ask1Price, prev.ask1Price),
      ask1Size: pickNum(d.ask1Size, prev.ask1Size),
      raw: d, // simpan raw terakhir agar mudah debug
    };

    this.tickerStore.set(symbol, next);
    return next;
  }
}

/* ----------------- Helpers ----------------- */
function toNum(x: any): number | undefined {
  if (x === null || x === undefined) return undefined;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : undefined;
}
function pickNum(newVal: any, oldVal?: number): number | undefined {
  const n = toNum(newVal);
  return n !== undefined ? n : oldVal;
}
function pickStr(newVal: any, oldVal?: string): string | undefined {
  if (newVal === undefined || newVal === null) return oldVal;
  return String(newVal);
}
