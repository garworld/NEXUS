export function normalizeSymbol(input: string) {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.endsWith("USDT") ? s : `${s}USDT`;
}

export const colors = {
  long: 0x10b981, // emerald
  short: 0xef4444, // red
  info: 0x3b82f6, // blue
};

export async function fetchJSON<T = any>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "discord-price-bot/1.0",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} fetching ${url}: ${text}`);
  }
  return (await res.json()) as T;
}

export function formatFiat(n: number, currency: string) {
  const cur = currency.toUpperCase();
  if (cur === "USDT" || cur === "USD") {
    return `$${n.toFixed(2)}`;
  }
  try {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: cur,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${cur}`;
  }
}

export function formatKM(num: number): string {
  const format = (n: number) => {
    // buletin ke 2 desimal
    const rounded = Math.round(n * 100) / 100;

    // kalau hasilnya integer (misal 355.00), tampilkan tanpa koma
    if (Number.isInteger(rounded)) {
      return rounded.toString();
    }
    return rounded.toFixed(2);
  };

  if (Math.abs(num) >= 1_000_000) {
    return format(num / 1_000_000) + "M";
  } else if (Math.abs(num) >= 1_000) {
    return format(num / 1_000) + "K";
  }
  return format(num);
}
