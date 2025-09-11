import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const TOKEN = process.env.DISCORD_TOKEN!;
const CLIENT_ID = process.env.CLIENT_ID!;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID) throw new Error("Missing DISCORD_TOKEN or CLIENT_ID");

const commands = [
  new SlashCommandBuilder()
    .setName("price")
    .setDescription("Cek harga BTC/ETH/SOL sekarang (Binance)")
    .addStringOption((opt) =>
      opt
        .setName("coin")
        .setDescription("Pilih coin")
        .setRequired(false)
        .addChoices(
          { name: "BTC", value: "btc" },
          { name: "ETH", value: "eth" },
          { name: "SOL", value: "sol" }
        )
    )
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
        body: commands,
      });
      console.log("✅ Registered guild commands (instan).");
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("✅ Registered global commands.");
    }
  } catch (e) {
    console.error(e);
  }
})();
