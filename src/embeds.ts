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
  oi: number; // open interest sekarang
  roi: number; // rasio OI change terhadap avg
  liq: number; // total liquidation vol

  direction: "bullish" | "bearish";
  tier: "B" | "A" | "S";

  oiNote: string;
  liqNote: string;

  interpretation: string;
};

export function breakdownEmbed(data: BreakdownData, currency: string) {
  const titleDir =
    data.direction === "bullish" ? "Bullish Breakout" : "Bearish Breakdown";
  const color = data.direction === "bullish" ? 0x22c55e : 0xef4444;
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

  const desc = [
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
    ``,
    `Interpretation : ${data.interpretation}`,
  ].join("\n");

  embed.setDescription(desc);
  return embed;
}
