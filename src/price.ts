import {
  listHeadJSON,
  listLPushTrim,
  OI_PERIOD,
  CAPACITY,
  oiKey,
  redisClient,
  listReplaceHeadIfSameTs,
  LSR_PERIOD,
  lsrKey,
} from "./helpers/redis.js";
import { fetchJSON } from "./utils.js";

/**
 * Sumber harga Futures:
 * - LAST price:  /fapi/v1/ticker/24hr  → field lastPrice, priceChangePercent
 * - MARK price:  /fapi/v1/premiumIndex → field markPrice (tanpa change %)
 */

type Futures24h = {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string; // bisa negatif
};

type PremiumIndex = {
  symbol: string;
  markPrice: string;
  lastFundingRate?: string;
  nextFundingTime?: number;
};

type OpenInterest = {
  openInterest: string;
  symbol: string;
  time: number;
};

type RawKline = [
  number, // 0  openTime (ms)
  string, // 1  open
  string, // 2  high
  string, // 3  low
  string, // 4  close
  string, // 5  volume (base)
  number, // 6  closeTime (ms)
  string, // 7  quoteAssetVolume
  number, // 8  numberOfTrades
  string, // 9  takerBuyBaseVolume
  string, // 10 takerBuyQuoteVolume
  string // 11 ignore
];

export type Kline = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // base volume
  quoteVolume: number; // quote volume (USDT)
  trades: number;
  takerBuyBase: number;
  takerBuyQuote: number;
};

type OpenInterestHistory = {
  symbol: string;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  CMCCirculatingSupply: string;
  timestamp: number;
};

type TakerLongShortRatio = {
  buySellRatio: string;
  buyVol: string;
  sellVol: string;
  timestamp: string;
};

const FUT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
type FutSymbol = (typeof FUT_SYMBOLS)[number];

type CoinKey = "btc" | "eth" | "sol";

const MAP_SYMBOL_TO_KEY: Record<FutSymbol, CoinKey> = {
  BTCUSDT: "btc",
  ETHUSDT: "eth",
  SOLUSDT: "sol",
};

async function get24hTickers(symbols: FutSymbol[]): Promise<Futures24h[]> {
  const url =
    "https://fapi.binance.com/fapi/v1/ticker/24hr?symbols=" +
    encodeURIComponent(JSON.stringify(symbols));
  return fetchJSON<Futures24h[]>(url);
}

async function getPremiumIndex(symbols: FutSymbol[]): Promise<PremiumIndex[]> {
  // Endpoint ini tidak mendukung ?symbols (array). Kita fetch semua lalu filter,
  // atau fetch satu per satu. Untuk efisiensi, kita ambil ALL lalu filter.
  const url = "https://fapi.binance.com/fapi/v1/premiumIndex";
  const all = await fetchJSON<PremiumIndex | PremiumIndex[]>(url);
  const list = Array.isArray(all) ? all : [all];
  const set = new Set(symbols);
  return list.filter((x) => set.has(x.symbol as FutSymbol));
}

/** Ambil kurs USDT→IDR dari spot untuk tampilan IDR */
async function getUsdtIdr(): Promise<number | null> {
  try {
    const url = "https://api.binance.com/api/v3/ticker/price?symbol=USDTIDRT";
    const res = await fetchJSON<{ symbol: string; price: string }>(url);
    return Number(res.price) || null;
  } catch {
    return null;
  }
}

export async function getOpenInterestPrice(
  symbol: string
): Promise<OpenInterest> {
  const url = `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}&period=5m&limit=50`;
  const result = await fetchJSON<OpenInterest>(url);
  // console.log("oi: ", result);
  return result;
}

export async function getTakerLongShortRatio(
  symbol: string,
  period: string = "5m",
  limit: number = 50
): Promise<TakerLongShortRatio[]> {
  const url = `https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${symbol}&period=${period}&limit=${limit}`;
  const result = await fetchJSON<TakerLongShortRatio[]>(url);
  // console.log({ result });
  return result;
}

export async function getFuturesKlines(
  symbol: "BTCUSDT" | "ETHUSDT" | "SOLUSDT",
  interval: "5m" = "5m",
  limit: number = 50
): Promise<Kline[]> {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await fetchJSON<RawKline[]>(url);
  return raw.map((k) => ({
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: k[6],
    quoteVolume: Number(k[7]),
    trades: k[8],
    takerBuyBase: Number(k[9]),
    takerBuyQuote: Number(k[10]),
  }));
}

async function GetOpenInterestHist(
  symbol: string,
  period: "5m" = "5m",
  limit: number = 50
): Promise<OpenInterestHistory[]> {
  const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`;
  const result = await fetchJSON<OpenInterestHistory[]>(url);
  return result;
}

export type PriceSource = "last" | "mark";

/**
 * getBinancePrices: ambil harga Futures USDT-M.
 * @param currency  "usdt" (default) atau "idr"
 * @param source    "last" → last trade price (punya %change 24h)
 *                  "mark" → mark price (lebih relevan PnL; tanpa %change)
 */
export async function getBinancePrices(
  currency: string,
  source: PriceSource = "last"
) {
  const wantIDR = currency.toLowerCase() === "idr";
  const usdtIdr = wantIDR ? await getUsdtIdr() : null;

  const toNum = (s: string | number | undefined) => Number(s ?? 0);

  // Siapkan output
  const out: Record<
    CoinKey,
    {
      price: number;
      change24h?: number;
      openInterest?: number;
      ratio?: number;
      openInterestTs?: number;
      LSRatioTs?: number;
    }
  > = {
    btc: {
      price: 0,
      change24h: undefined,
      openInterest: undefined,
      ratio: undefined,
      openInterestTs: undefined,
      LSRatioTs: undefined,
    },
    eth: {
      price: 0,
      change24h: undefined,
      openInterest: undefined,
      ratio: undefined,
      openInterestTs: undefined,
      LSRatioTs: undefined,
    },
    sol: {
      price: 0,
      change24h: undefined,
      openInterest: undefined,
      ratio: undefined,
      openInterestTs: undefined,
      LSRatioTs: undefined,
    },
  };

  const rc = await redisClient();

  await Promise.all(
    FUT_SYMBOLS.map(async (symbol) => {
      const key = MAP_SYMBOL_TO_KEY[symbol];

      // OPEN INTEREST
      let oiLatest: OpenInterestHistory | undefined;

      if (rc) {
        oiLatest = await listHeadJSON(oiKey(symbol));
        if (!oiLatest) {
          // seed 50 data from API
          const seed = await GetOpenInterestHist(symbol, OI_PERIOD, CAPACITY);
          // pastikan asc by time
          seed.sort((a, b) => a.timestamp - b.timestamp);
          await listLPushTrim(oiKey(symbol), seed);
          oiLatest = seed.at(-1);
          console.log(`[OI][${symbol}] seed Redis dengan ${seed.length} item`);
        } else {
          // refresh data terbaru dari API
          const latest = await GetOpenInterestHist(symbol, OI_PERIOD, 1);
          const newItem = latest.at(0);
          if (newItem) {
            const action = await listReplaceHeadIfSameTs(
              oiKey(symbol),
              newItem
            );
            console.log(`[OI][${symbol}] ${action} ts=${newItem.timestamp}`);
            oiLatest =
              newItem.timestamp >= oiLatest.timestamp ? newItem : oiLatest;
          }
        }
        // print isi Redis (max 5 item pertama biar ga flooding)
        const allOi = await rc.lRange(oiKey(symbol), 0, 4);
        console.log(`[OI][${symbol}] Redis head 5:`, allOi);
      } else {
        // tanpa redis
        const latest = await GetOpenInterestHist(symbol, OI_PERIOD, 1);
        oiLatest = latest.at(0);
      }

      if (oiLatest) {
        out[key].openInterest = toNum(Number(oiLatest.sumOpenInterest));
      }

      // LONG SHORT RATIO for DELTA
      let lsrLatest: TakerLongShortRatio | undefined;

      if (rc) {
        lsrLatest = await listHeadJSON<TakerLongShortRatio>(lsrKey(symbol));
        if (!lsrLatest) {
          // seed 50 bar
          const seed = await getTakerLongShortRatio(
            symbol,
            LSR_PERIOD,
            CAPACITY
          );
          // Binance mengembalikan ascending by time untuk endpoint ini,
          // pastikan ascending agar reverse di listLPushTrim bekerja seperti yang kita mau
          seed.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
          await listLPushTrim(lsrKey(symbol), seed);
          lsrLatest = seed.at(-1);
          console.log(`[LSR][${symbol}] seed Redis dengan ${seed.length} item`);
        } else {
          const latest = await getTakerLongShortRatio(symbol, LSR_PERIOD, 1);
          const newItem = latest.at(0);
          if (newItem) {
            const action = await listReplaceHeadIfSameTs(lsrKey(symbol), {
              ...newItem,
              // pastikan timestamp number agar konsisten (API kirim string)
              timestamp: Number(newItem.timestamp),
            } as any);
            // pilih yang terbaru
            const newer =
              Number(newItem.timestamp) >= Number(lsrLatest.timestamp)
                ? newItem
                : lsrLatest;
            lsrLatest = newer;
            console.log(`[LSR][${symbol}] ${action} ts=${newItem.timestamp}`);
          }
        }
        const allLsr = await rc.lRange(lsrKey(symbol), 0, 4);
        console.log(`[LSR][${symbol}] Redis head 5:`, allLsr);
      } else {
        const latest = await getTakerLongShortRatio(symbol, LSR_PERIOD, 1);
        lsrLatest = latest.at(0);
      }

      if (lsrLatest) {
        out[key].ratio = Number(lsrLatest.buySellRatio);
      }
    })
  );

  if (source === "last") {
    // Futures 24h ticker → lastPrice + priceChangePercent
    const tickers = await get24hTickers(FUT_SYMBOLS);
    for (const t of tickers) {
      const key = MAP_SYMBOL_TO_KEY[t.symbol as FutSymbol];
      if (!key) continue;
      const pxUSDT = toNum(t.lastPrice);
      const px = wantIDR && usdtIdr ? pxUSDT * usdtIdr : pxUSDT;
      out[key] = {
        ...out[key],
        price: px,
        change24h: toNum(t.priceChangePercent),
      };
    }
  } else {
    // MARK price (premiumIndex) → markPrice saja (tanpa change 24h)
    const indexes = await getPremiumIndex(FUT_SYMBOLS);
    for (const it of indexes) {
      const key = MAP_SYMBOL_TO_KEY[it.symbol as FutSymbol];
      if (!key) continue;
      const pxUSDT = toNum(it.markPrice);
      const px = wantIDR && usdtIdr ? pxUSDT * usdtIdr : pxUSDT;
      out[key] = { ...out[key], price: px };
    }
  }

  console.log("[DEBUG][OUT]", out);

  return {
    currency: wantIDR ? "idr" : "usdt",
    source, // "last" | "mark" → biar jelas di layer atas
    data: out,
  };
}
