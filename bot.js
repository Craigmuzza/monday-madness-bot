// bot.js
import express from "express";
import { formidable } from "formidable";
import { Client, GatewayIntentBits, EmbedBuilder, Events } from "discord.js";
import fs from "fs";
import path from "path";
import simpleGit from "simple-git";
import dotenv from "dotenv";
dotenv.config();

// ── Config ─────────────────────────────────────────────────────────────
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT         = process.env.GITHUB_PAT;      // optional
const REPO               = "craigmuzza/monday-madness-bot";
const BRANCH             = "main";
const COMMIT_MSG         = "auto: sync data";

const DEDUP_WINDOW_MS = 10_000;
const LOOT_RE = /(.+?) has defeated (.+?) and received \(([\d,]+) coins\)/i;

// ── Express & Body Parsers ─────────────────────────────────────────────
const app = express();
// only JSON (for /logKill, /logLoot, plain JSON Dink path)
app.use(express.json());

// ── Discord Client ─────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── In-memory State ────────────────────────────────────────────────────
let currentEvent = "default";
let clanOnlyMode = false;

const registeredNames = new Set();
const seenRecently = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of seenRecently) {
    if (now - t > DEDUP_WINDOW_MS) seenRecently.delete(k);
  }
}, 30_000);

const events = {
  default: { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} }
};

const ci = s => s.toLowerCase().trim();
function getEventData() {
  if (!events[currentEvent]) {
    events[currentEvent] = { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} };
  }
  return events[currentEvent];
}

function saveJSON(file, obj) {
  const p = path.join(process.cwd(), file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

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

// load persisted names
try {
  const arr = JSON.parse(fs.readFileSync("data/registered.json"));
  if (Array.isArray(arr)) arr.forEach(n => registeredNames.add(ci(n)));
  console.log(`[init] loaded ${registeredNames.size} registered names`);
} catch {
  console.log("[init] no registered.json, starting fresh");
}

// ── Core Loot Processor ─────────────────────────────────────────────────
async function processLoot(killer, victim, gp, dedupKey, res) {
  if (
    clanOnlyMode &&
    (!registeredNames.has(ci(killer)) ||
     !registeredNames.has(ci(victim)))
  ) {
    return res?.status(200).send("Ignored non-clan");
  }

  if (
    seenRecently.has(dedupKey) &&
    Date.now() - seenRecently.get(dedupKey) < DEDUP_WINDOW_MS
  ) {
    return res?.status(200).send("Duplicate suppressed");
  }
  seenRecently.set(dedupKey, Date.now());

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

  try {
    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (ch?.isTextBased()) {
      await ch.send({ embeds: [embed] });
      console.log(`[discord] sent loot for ${killer}`);
    }
  } catch (e) {
    console.error("[discord] error sending loot embed:", e);
  }

  return res?.status(200).send("ok");
}

// ── /logKill ───────────────────────────────────────────────────────────
app.post("/logKill", async (req, res) => {
  const { killer, victim } = req.body || {};
  if (!killer || !victim) return res.status(400).send("Missing killer/victim");

  if (
    clanOnlyMode &&
    (!registeredNames.has(ci(killer)) ||
     !registeredNames.has(ci(victim)))
  ) {
    return res.status(200).send("Ignored non-clan kill");
  }

  const key = `K|${ci(killer)}|${ci(victim)}`;
  if (
    seenRecently.has(key) &&
    Date.now() - seenRecently.get(key) < DEDUP_WINDOW_MS
  ) {
    return res.status(200).send("Duplicate suppressed");
  }
  seenRecently.set(key, Date.now());

  const { deathCounts } = getEventData();
  deathCounts[ci(victim)] = (deathCounts[ci(victim)] || 0) + 1;

  const embed = new EmbedBuilder()
    .setTitle("💀 Kill Logged")
    .setDescription(`**${killer}** killed **${victim}**`)
    .addFields({ name: "Total Deaths", value: String(deathCounts[ci(victim)]), inline: true })
    .setColor(0xFF0000)
    .setTimestamp();

  try {
    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (ch?.isTextBased()) {
      await ch.send({ embeds: [embed] });
      console.log(`[discord] sent kill for ${killer}→${victim}`);
    }
  } catch (e) {
    console.error("[discord] error sending kill embed:", e);
  }

  res.status(200).send("ok");
});

// ── /logLoot ──────────────────────────────────────────────────────────
app.post("/logLoot", (req, res) => {
  const line = req.body?.lootMessage;
  if (!line) return res.status(400).send("Missing lootMessage");
  console.log("[http] /logLoot raw =", line);

  const m = LOOT_RE.exec(line);
  if (!m) return res.status(400).send("Invalid format");

  const gp = Number(m[3].replace(/,/g, ""));
  return processLoot(m[1], m[2], gp, line.trim(), res);
});

// ── /dink ─────────────────────────────────────────────────────────────
// handle RuneLite-Dink webhook (multipart/form-data)
app.post("/dink", (req, res) => {
  const ct = req.headers["content-type"] || "";

  // A) multipart/form-data path
  if (ct.startsWith("multipart/form-data")) {
    const form = formidable({ multiples: false });
    form.parse(req, (err, fields) => {
      if (err || !fields.payload_json) {
        console.warn("[dink] multipart err", err);
        return res.status(400).send("multipart err");
      }

      let data;
      try {
        data = JSON.parse(fields.payload_json);
      } catch (e) {
        console.warn("[dink] bad JSON in payload_json", e);
        return res.status(400).send("bad JSON");
      }

      console.log("[dink] json", JSON.stringify(data).slice(0, 200));
      if (
        data.type === "CHAT" &&
        data.extra?.type === "CLAN_CHAT"
      ) {
        const line = data.extra.message;
        const m = LOOT_RE.exec(line);
        if (!m) {
          console.log("[dink] loot regex ✗", line);
          return res.status(204).end();
        }
        console.log("[dink] loot regex ✓", m.slice(1,4));
        const gp = Number(m[3].replace(/,/g, ""));
        return processLoot(m[1], m[2], gp, line.trim(), res);
      }

      return res.status(204).end();
    });
    return;
  }

  // B) fallback JSON or raw text
  let payload = req.body;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); }
    catch { /* not JSON */ }
  }

  console.log("[dink] payload fallback", typeof payload);
  if (
    payload?.type === "CHAT" &&
    payload.extra?.type === "CLAN_CHAT"
  ) {
    console.log("[dink] content", payload.content);
    // extract inside backticks, or use extra.message
    const rawLine = payload.extra.message || payload.content.replace(/^.*`(.+)`.*$/, "$1");
    const m = LOOT_RE.exec(rawLine);
    if (!m) return res.status(204).end();
    const gp = Number(m[3].replace(/,/g, ""));
    return processLoot(m[1], m[2], gp, rawLine.trim(), res);
  }

  return res.status(204).end();
});

// ── Spin up HTTP once Discord is ready ────────────────────────────────
client.once("ready", () => {
  console.log(`[discord] ready as ${client.user.tag}`);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[http] listening on ${port}`));
});

// ── Discord commands (keep your existing handlers here) ──────────────
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  const text = msg.content.toLowerCase();
  const { deathCounts, lootTotals, gpTotal, kills } = getEventData();

  if (text === "!hiscores") {
    /* … your embed logic … */
  }
  if (text === "!lootboard") {
    /* … */
  }
  // … rest of your !createEvent, !finishEvent, !register, !help etc …
});

// ── Login to Discord ──────────────────────────────────────────────────
client.login(DISCORD_BOT_TOKEN);
