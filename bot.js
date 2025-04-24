// bot.js
import express from "express";
import multer from "multer";
import { fileURLToPath } from "url";
import { Client, GatewayIntentBits, EmbedBuilder, Events } from "discord.js";
import fs from "fs";
import path from "path";
import simpleGit from "simple-git";
import dotenv from "dotenv";
dotenv.config();

// ── __dirname setup for ESM ──────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── env ─────────────────────────────────────────────────────────────
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT         = process.env.GITHUB_PAT;  // optional
const REPO               = "craigmuzza/monday-madness-bot";
const BRANCH             = "main";
const COMMIT_MSG         = "auto: sync data";

// ── constants ───────────────────────────────────────────────────────
const DEDUP_MS = 10_000;   // 10s
const LOOT_RE  = /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\( *([\d,]+) *coins\).*/i;

// ── express + multer ─────────────────────────────────────────────────
const app    = express();
const upload = multer();           // for multipart/form-data

app.use(express.json());
app.use(express.text({ type: "text/*" }));

// ── discord client ──────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ── bot state ───────────────────────────────────────────────────────
let currentEvent = "default";
let clanOnlyMode = false;
const registered = new Set();  // lower-case names
const seen       = new Map();  // dedup map
const events     = {
  default: { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} }
};

const ci  = s => (s||"").toLowerCase().trim();
const now = () => Date.now();

// ── load persisted registrations ───────────────────────────────────
try {
  const arr = JSON.parse(
    fs.readFileSync(path.join(__dirname, "data/registered.json"))
  );
  if (Array.isArray(arr)) arr.forEach(n => registered.add(ci(n)));
  console.log(`[init] loaded ${registered.size} registered names`);
} catch {
  console.log("[init] no registered.json yet");
}

// ── commit helper ───────────────────────────────────────────────────
async function commitToGitHub() {
  if (!GITHUB_PAT) return;
  const git = simpleGit();
  await git.add(".");
  await git.commit(COMMIT_MSG);
  await git.push(
    `https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`,
    BRANCH
  );
}

// ── get or init current event data ─────────────────────────────────
function getEventData() {
  if (!events[currentEvent]) {
    events[currentEvent] = { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} };
  }
  return events[currentEvent];
}

// ── core loot processor ─────────────────────────────────────────────
async function processLoot(killer, victim, gp, dedupKey, res) {
  if (
    clanOnlyMode &&
    (!registered.has(ci(killer)) || !registered.has(ci(victim)))
  ) {
    return res.status(200).send("non-clan ignored");
  }

  if (seen.has(dedupKey) && now() - seen.get(dedupKey) < DEDUP_MS) {
    return res.status(200).send("duplicate");
  }
  seen.set(dedupKey, now());

  const { lootTotals, gpTotal, kills } = getEventData();
  lootTotals[ci(killer)] = (lootTotals[ci(killer)] || 0) + gp;
  gpTotal  [ci(killer)] = (gpTotal  [ci(killer)] || 0) + gp;
  kills    [ci(killer)] = (kills    [ci(killer)] || 0) + 1;

  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({
      name: "Event GP Gained",
      value: `${lootTotals[ci(killer)].toLocaleString()} coins`,
      inline: true
    })
    .setColor(0xFF0000)
    .setTimestamp();

  const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if (ch?.isTextBased()) {
    await ch.send({ embeds: [embed] });
    console.log("[discord] sent loot embed");
  }

  return res.status(200).send("ok");
}

// ── /logKill ────────────────────────────────────────────────────────
app.post("/logKill", async (req, res) => {
  const { killer, victim } = req.body || {};
  if (!killer || !victim) return res.status(400).send("bad data");

  if (
    clanOnlyMode &&
    (!registered.has(ci(killer)) || !registered.has(ci(victim)))
  ) {
    return res.status(200).send("non-clan ignored");
  }

  const dupKey = `K|${ci(killer)}|${ci(victim)}`;
  if (seen.has(dupKey) && now() - seen.get(dupKey) < DEDUP_MS) {
    return res.status(200).send("duplicate");
  }
  seen.set(dupKey, now());

  const { deathCounts } = getEventData();
  deathCounts[ci(victim)] = (deathCounts[ci(victim)] || 0) + 1;

  const embed = new EmbedBuilder()
    .setTitle("💀 Kill Logged")
    .setDescription(`**${killer}** killed **${victim}**`)
    .addFields({ name: "Total Deaths", value: String(deathCounts[ci(victim)]), inline: true })
    .setColor(0xFF0000)
    .setTimestamp();

  const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if (ch?.isTextBased()) {
    await ch.send({ embeds: [embed] });
    console.log("[discord] sent kill embed");
  }

  return res.status(200).send("ok");
});

// ── /logLoot (legacy) ───────────────────────────────────────────────
app.post("/logLoot", (req, res) => {
  const txt = req.body?.lootMessage;
  if (!txt) return res.status(400).send("bad");
  const m = txt.match(LOOT_RE);
  if (!m) return res.status(400).send("fmt");
  return processLoot(m[1], m[2], Number(m[3].replace(/,/g, "")), txt.trim(), res);
});

// ── /dink (multipart/form-data) ───────────────────────────────────
app.post(
  "/dink",
  upload.none(),
  async (req, res) => {
    const raw = req.body.payload_json;
    if (!raw) {
      console.error("[dink] no payload_json");
      return res.status(400).send("no payload_json");
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error("[dink] JSON parse error:", e);
      return res.status(400).send("bad JSON");
    }

    console.log("[dink] full JSON payload:", JSON.stringify(data, null, 2));
    console.log("[dink] clan chat message:", data.extra?.message);

    // now accept both CLAN_CHAT *and* CLAN_MESSAGE
    if (
      data.type === "CHAT" &&
      (data.extra?.type === "CLAN_CHAT" || data.extra?.type === "CLAN_MESSAGE") &&
      typeof data.extra.message === "string"
    ) {
      const msg = data.extra.message;
      console.log("[dink] message:", msg);
      const m = msg.match(LOOT_RE);
      if (m) {
        return processLoot(
          m[1],
          m[2],
          Number(m[3].replace(/,/g, "")),
          msg.trim(),
          res
        );
      }
    }

    return res.status(204).end();
  }
);

// ── start server after Discord ready ────────────────────────────────
client.once("ready", () => {
  console.log(`[discord] ready: ${client.user.tag}`);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[http] listening on ${port}`));
});

// ── your Discord commands go here (e.g. !hiscores, !lootboard, etc.) ─
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  // … unchanged …
});

client.login(DISCORD_BOT_TOKEN);
