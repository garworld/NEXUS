import { EmbedBuilder } from "discord.js";
import { formatFiat, formatKM } from "./utils.js";

export type BreakdownData = {
  symbol: string;
  timeframe: string;
  price: number;

  rvol: number; // rasio volume sekarang terhadap avg
  currentVol: number; // volume sekarang (BTC)
  delta: number; // delta sekarang
  rdelta: number; // rasio delta terhadap avg
  oi: number; // open interest change sekarang (atau nilai OI change yang kamu pakai di index)
  roi: number; // rasio OI change terhadap avg
  liq: number; // total liquidation vol

  direction: "bullish" | "bearish";
  tier: "B" | "A" | "S";

  oiNote: string;
  liqNote: string;

  interpretation: string;

  // NEW (opsional): info level terdekat
  poiLabel?: string; // ex: "Monday High"
  poiPrice?: number; // ex: 116_750
  poiDistancePct?: number; // ex: 0.32 (persen)

  priceATR?: number;
  atrMode?: "long" | "short";
  candleType?:
    | "Green Pinbar"
    | "Red Pinbar"
    | "Green Inverted Pinbar"
    | "Red Inverted Pinbar";
};

export function breakdownEmbed(data: BreakdownData, currency: string) {
  const titleDir = data.candleType
    ? data.direction === "bullish"
      ? "Failed Breakout"
      : "Failed Breakdown"
    : data.direction === "bullish"
    ? "Bullish Breakout"
    : "Bearish Breakdown";
  const color = data.candleType
    ? data.direction === "bullish"
      ? 0xef4444
      : 0x22c55e
    : data.direction === "bullish"
    ? 0x22c55e
    : 0xef4444;

  const embed = new EmbedBuilder()
    .setTitle(
      `${data.symbol} - ${data.timeframe} | ${titleDir} (Tier ${data.tier})`
    )
    .setColor(color)
    .setTimestamp(new Date())
    .setFooter({ text: `Resource: Bybit` });

  let embedSymbol = "BTC";
  if (data.symbol === "ETHUSDT") {
    embedSymbol = "ETH";
  } else if (data.symbol === "SOLUSDT") {
    embedSymbol = "SOL";
  } else if (data.symbol === "DOGEUSDT") {
    embedSymbol = "DOGE";
  } else if (data.symbol === "FARTCOINUSDT") {
    embedSymbol = "FARTCOIN";
  }

  const lines: string[] = [
    `Price : ${formatFiat(data.price, currency)}`,
    ``,
    `RVOL        : **${formatKM(
      data.currentVol
    )} ${embedSymbol}** (${data.rvol.toFixed(1)}x Avg)`,
    `RDELTA      : **${data.delta > 0 ? "+" : ""}${formatKM(
      data.delta
    )} ${embedSymbol}** (${data.rdelta.toFixed(1)}x Avg)`,
    `OI          : **${formatKM(data.oi)}** (${data.roi.toFixed(1)}x Avg) — ${
      data.oiNote
    }`,
    `Liquidations: **${data.liq ? formatKM(data.liq) : "No Liquidation"}** ${
      data.liqNote
    }`,
  ];

  // NEW: render baris Level jika tersedia
  if (
    data.poiLabel &&
    Number.isFinite(data.poiPrice as number) &&
    Number.isFinite(data.poiDistancePct as number)
  ) {
    const poiPrice = data.poiPrice as number;
    const distancePct = data.poiDistancePct as number;

    const isAbove = data.price > poiPrice;
    const isBelow = data.price < poiPrice;
    const relStr = isAbove ? "Above" : isBelow ? "Below" : "at";

    lines.push(
      `Level       : **${data.poiLabel}**  (${formatFiat(
        data.poiPrice as number,
        currency
      )} | ${(data.poiDistancePct as number).toFixed(
        2
      )}%) — current price is **${relStr}** this level`
    );

    if (data.direction === "bullish" && isAbove) {
      lines.push(
        `⚠️ Caution on LONG: price is already **above** the nearest POI level — risk of chasing.`
      );
    } else if (data.direction === "bearish" && isBelow) {
      lines.push(
        `⚠️ Caution on SHORT: price is already **below** the nearest POI level — risk of chasing.`
      );
    }
  }

  lines.push(
    ``,
    `${
      data.candleType
        ? data.direction === "bullish"
          ? "Failed Breakout Interpretation"
          : "Failed Breakdown Interpretation"
        : "Interpretation"
    } : ${
      data.candleType
        ? data.direction === "bullish"
          ? "Should be a strong breakout, but the candle shows no strength, high probability of breakdown from here."
          : "Should be a strong breakdown, but the candle shows no strength, high chance of breakdown from here."
        : data.interpretation
    }`
  );

  if (data.priceATR !== undefined) {
    lines.push(
      `ATR : **${formatFiat(
        data.priceATR as number,
        currency
      )} ${embedSymbol}** · ${data.atrMode ? data.atrMode.toUpperCase() : ""}`
    ); // Display ATR value
  }

  if (data.candleType !== undefined) {
    lines.push(
      `Candle Type: **${data.candleType}**, ${
        data.oiNote === "long closing"
          ? "Absorbed Liquidation | Potential Reversal"
          : data.oiNote === "new shorts"
          ? "Short Trapped | Potential Reversal"
          : data.oiNote === "short closing"
          ? "Absorbed Liquidation | Potential Reversal"
          : data.oiNote === "new longs"
          ? "Long Trapped | Potential Reversal"
          : ""
      }`
    );
  }

  embed.setDescription(lines.join("\n"));
  return embed;
}
