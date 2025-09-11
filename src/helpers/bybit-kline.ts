// bybit-kline.ts
export type KlineVolume = {
  symbol: string;
  start: number; // ms
  end: number; // ms
  interval: string; // '5'
  volume: number; // base asset volume dari Bybit
  turnover?: number; // quote volume (opsional)
};

/**
 * Ambil 1 kline interval=5 menit dari Bybit v5.
 * NOTE: endpoint v5: /v5/market/kline
 * category: 'linear' | 'inverse' | 'spot'
 * start/end: ms. Bybit mengembalikan 'list' = array of klines terbaru -> terlama (atau sebaliknya),
 * struktur list item (string array) umumnya:
 * [ startTime, open, high, low, close, volume, turnover ]
 */
export async function fetchBybitKline5mVolume(
  category: "linear" | "inverse" | "spot",
  symbol: string,
  startMs: number,
  endMs: number
): Promise<KlineVolume | null> {
  //   await new Promise((r) => setTimeout(r, 1000));
  const params = new URLSearchParams({
    category,
    symbol,
    interval: "5",
    start: String(startMs),
    end: String(endMs),
    limit: "1",
  });
  const url = `https://api.bybit.com/v5/market/kline?${params.toString()}`;
  // console.log({ url });

  const res = await fetch(url);
  if (!res.ok) {
    console.error("Bybit kline fetch failed:", res.status, res.statusText);
    return null;
  }
  const json = await res.json();
  if (json.retCode !== 0) {
    console.error("Bybit kline retCode != 0", json);
    return null;
  }
  const list = json?.result?.list;
  if (!Array.isArray(list) || list.length === 0) return null;

  // Ambil bar yang sesuai (biasanya indeks 0)
  const it = list[0]; // string[]
  // Struktur umum v5:
  // it[0]=startTime(ms), it[1]=open, it[2]=high, it[3]=low, it[4]=close, it[5]=volume(base), it[6]=turnover(quote)
  const start = Number(it[0]);
  const volume = Number(it[5]);
  const turnover = Number(it[6]);

  return {
    symbol,
    start,
    end: start + 5 * 60 * 1000,
    interval: "5",
    volume: Number.isFinite(volume) ? volume : NaN,
    turnover: Number.isFinite(turnover) ? turnover : undefined,
  };
}
