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

// ── Fix for ES modules to get __dirname ───────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Environment ──────────────────────────────────────────────────────
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT         = process.env.GITHUB_PAT;
const REPO               = "craigmuzza/monday-madness-bot";
const BRANCH             = "main";
const COMMIT_MSG         = "auto: sync data";

// ── Constants ────────────────────────────────────────────────────────
const DEDUP_MS = 10_000; // 10 seconds
const LOOT_RE  = /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\( *([\d,]+) *coins\).*/i;

// ── Express setup ───────────────────────────────────────────────────
const app = express();
app.use(express.json());                // parse application/json
app.use(express.text({ type: "text/*" })); // parse plain-text bodies

// ── Multer for multipart/form-data ─────────────────────────────────
const upload = multer().any();          // accept any fields (payload_json + optional file)

// ── Discord client ──────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ── Bot state ────────────────────────────────────────────────────────
let currentEvent = "default";
let clanOnlyMode = false;
const registered = new Set();           // lower-case clan names
const seen       = new Map();           // deduplication cache: key → timestamp
const events     = {
  default: { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} }
};

const ci  = s => (s || "").toLowerCase().trim();
const now = () => Date.now();

// ── Load persisted registrations ─────────────────────────────────────
try {
  const arr = JSON.parse(
    fs.readFileSync(path.join(__dirname, "data/registered.json"))
  );
  if (Array.isArray(arr)) arr.forEach(n => registered.add(ci(n)));
  console.log(`[init] loaded ${registered.size} registered names`);
} catch {
  /* first run – ignore */
}

// ── GitHub commit helper ─────────────────────────────────────────────
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

// ── Get or initialize current event data ─────────────────────────────
function getEventData() {
  if (!events[currentEvent]) {
    events[currentEvent] = { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} };
  }
  return events[currentEvent];
}

// ── Core loot processor ──────────────────────────────────────────────
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
  gpTotal[ci(killer)]    = (gpTotal[ci(killer)]    || 0) + gp;
  kills[ci(killer)]      = (kills[ci(killer)]      || 0) + 1;

  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    // show the exact clan‐chat line, with the 'worth of loot!' suffix
    .setDescription(dedupKey)
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
  }
  return res.status(200).send("ok");
}

// ── /logKill endpoint ───────────────────────────────────────────────
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
  }
  return res.status(200).send("ok");
});

// ── /logLoot (legacy HTTP) ──────────────────────────────────────────
app.post("/logLoot", (req, res) => {
  const txt = req.body?.lootMessage;
  if (!txt) return res.status(400).send("bad");
  const m = txt.match(LOOT_RE);
  if (!m) return res.status(400).send("fmt");
  return processLoot(
    m[1], m[2], Number(m[3].replace(/,/g, "")),
    txt.trim(), res
  );
});

// ── /dink endpoint (RuneLite-Dink multipart/form-data) ─────────────
app.post(
  "/dink",
  upload,
  async (req, res) => {
    const raw = req.body.payload_json;
    if (!raw) return res.status(400).send("no payload_json");

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error("[dink] JSON parse error:", e);
      return res.status(400).send("bad JSON");
    }

    console.log("[dink] full JSON payload:", JSON.stringify(data, null, 2));
    if (data.extra?.message) {
      console.log("[dink] clan chat message:", data.extra.message);
    }

    if (
      data.type === "CHAT" &&
      data.extra?.type === "CLAN_CHAT" &&
      typeof data.extra.message === "string"
    ) {
      const msg = data.extra.message;
      console.log("[dink] message (regex target):", msg);
      const m = msg.match(LOOT_RE);
      if (m) {
        return processLoot(
          m[1], m[2], Number(m[3].replace(/,/g, "")),
          msg.trim(), res
        );
      }
    }

    return res.status(204).end();
  }
);

// ── Start HTTP after Discord is ready ────────────────────────────────
client.once("ready", () => {
  console.log(`[discord] ready: ${client.user.tag}`);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[http] listening on ${port}`));
});

// ── Commands (insert your !hiscores, !lootboard, etc.) ───────────────
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  const text = msg.content.toLowerCase();
  const { deathCounts, lootTotals, kills } = getEventData();

  // … your existing command handlers here …
});

client.login(DISCORD_BOT_TOKEN);
