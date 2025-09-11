import { createClient } from "redis";

export const REDIS_URL = process.env.REDIS_URL;
export const OI_PERIOD = "5m";
export const LSR_PERIOD = "5m";
export const CAPACITY = 50;

let _redis: ReturnType<typeof createClient> | null = null;

export async function redisClient() {
  if (!REDIS_URL) return null;
  if (_redis && _redis.isOpen) return _redis;

  _redis = createClient({ url: REDIS_URL });
  _redis.on("error", (e) => console.error(`[redis] error: `, e));
  await _redis.connect();
  return _redis;
}

export function oiKey(symbol: string, period = OI_PERIOD) {
  return `oi:${symbol}:${period}`;
}
export function lsrKey(symbol: string, period = LSR_PERIOD) {
  return `lsr:${symbol}:${period}`;
}

export async function listHeadJSON<T>(key: string): Promise<T | undefined> {
  const r = await _redis!.lIndex(key, 0);
  return r ? (JSON.parse(r) as T) : undefined;
}

export async function listLPushTrim(
  key: string,
  items: unknown[],
  capacity = CAPACITY
) {
  if (items.length === 0) return;
  const payload = items.map((x) => JSON.stringify(x)).reverse();
  const multi = _redis!.multi();
  multi.lPush(key, payload);
  multi.lTrim(key, 0, capacity - 1);
  await multi.exec();
}

export async function listReplaceHeadIfSameTs<T extends { timestamp: number }>(
  key: string,
  item: T
) {
  const head = await _redis!.lIndex(key, 0);
  if (!head) {
    await listLPushTrim(key, [item]);
    return "pushed";
  }

  try {
    const parsed = JSON.parse(head) as T;
    if (parsed.timestamp === item.timestamp) {
      await _redis!.lSet(key, 0, JSON.stringify(item));
      return "replaced";
    } else {
      await listLPushTrim(key, [item]);
      return "pushed";
    }
  } catch (err) {
    await listLPushTrim(key, [item]);
    return "pushed";
  }
}

export function agg5mKey(symbol: string) {
  return `agg:${symbol}:5m`;
}

export function agg5mAvgKey(symbol: string) {
  return `agg:${symbol}:5m:avg`;
}

const tfLabel = (tf: number) => `${tf}m`;

export function aggKeyTf(symbol: string, tf: number) {
  return `agg:${tfLabel(tf)}:${symbol}`;
}

export function aggAvgkeyTf(symbol: string, tf: number) {
  return `aggavg:${tfLabel(tf)}:${symbol}`;
}

export async function listLen(key: string): Promise<number> {
  if (!_redis) return 0;
  return await _redis.lLen(key);
}

export async function listReadJSON<T>(key: string, n = CAPACITY): Promise<T[]> {
  const len = await listLen(key);
  if (len === 0) return [];
  const arr = await _redis!.lRange(key, 0, Math.min(n, len) - 1);
  return arr.map((s) => JSON.parse(s) as T);
}

export async function setJSON(key: string, value: unknown, ttlSec?: number) {
  const payload = JSON.stringify(value);
  if (ttlSec && ttlSec > 0) {
    await _redis!.set(key, payload, { EX: ttlSec });
  } else {
    await _redis!.set(key, payload);
  }
}

export async function getJSON<T>(key: string): Promise<T | null> {
  const s = await _redis!.get(key);
  return s ? (JSON.parse(s) as T) : null;
}
