// bot.js

import express from "express";
import formidable from "formidable";
import { Client, GatewayIntentBits, EmbedBuilder, Events } from "discord.js";
import fs from "fs";
import path from "path";
import simpleGit from "simple-git";
import dotenv from "dotenv";
dotenv.config();

// ── Configuration ─────────────────────────────────────────────────────
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT         = process.env.GITHUB_PAT;     // optional
const REPO               = "craigmuzza/monday-madness-bot";
const BRANCH             = "main";
const COMMIT_MSG         = "auto: sync data";

const DEDUP_WINDOW_MS = 10_000;
const LOOT_RE         = /(.+?) has defeated (.+?) and received \(([\d,]+) coins\)/i;

// ── Express setup ─────────────────────────────────────────────────────
const app = express();
// for JSON bodies
app.use(express.json());
// for raw bodies
app.use(express.text({ type: "*/*" }));

// ── Discord client ────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── In-memory state ────────────────────────────────────────────────────
let currentEvent   = "default";
let clanOnlyMode   = false;
const registeredNames = new Set();
const seenRecently    = new Map();  // dedupe cache
setInterval(() => {
  const now = Date.now();
  for (const [k,t] of seenRecently) {
    if (now - t > DEDUP_WINDOW_MS) seenRecently.delete(k);
  }
}, 30_000);

const events = {
  default: { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} },
};

const ci = s => s.toLowerCase().trim();
function getEventData() {
  if (!events[currentEvent]) {
    events[currentEvent] = { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} };
  }
  return events[currentEvent];
}

function saveJSON(file, obj) {
  const p = path.join(__dirname, file);
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

// load persisted registered names
try {
  const arr = JSON.parse(fs.readFileSync(path.join(__dirname, "data/registered.json")));
  if (Array.isArray(arr)) arr.forEach(n => registeredNames.add(ci(n)));
  console.log(`[init] loaded ${registeredNames.size} registered names`);
} catch {
  console.log("[init] no registered.json found, starting fresh");
}

// ── Core loot processor ────────────────────────────────────────────────
async function processLoot(killer, victim, gp, dedupKey, res) {
  // clan-only filter
  if (
    clanOnlyMode &&
    (!registeredNames.has(ci(killer)) || !registeredNames.has(ci(victim)))
  ) {
    return res?.status(200).send("Ignored non-clan");
  }

  // dedupe
  if (seenRecently.has(dedupKey) && Date.now() - seenRecently.get(dedupKey) < DEDUP_WINDOW_MS) {
    return res?.status(200).send("Duplicate suppressed");
  }
  seenRecently.set(dedupKey, Date.now());

  const { lootTotals, gpTotal, kills } = getEventData();
  lootTotals[ci(killer)] = (lootTotals[ci(killer)] || 0) + gp;
  gpTotal[ci(killer)]    = (gpTotal[ci(killer)]    || 0) + gp;
  kills[ci(killer)]      = (kills[ci(killer)]      || 0) + 1;

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

// ── /logKill endpoint ─────────────────────────────────────────────────
app.post("/logKill", async (req, res) => {
  const { killer, victim } = req.body || {};
  if (!killer || !victim) return res.status(400).send("Missing killer/victim");

  if (
    clanOnlyMode &&
    (!registeredNames.has(ci(killer)) || !registeredNames.has(ci(victim)))
  ) {
    return res.status(200).send("Ignored non-clan kill");
  }

  const key = `K|${ci(killer)}|${ci(victim)}`;
  if (seenRecently.has(key) && Date.now() - seenRecently.get(key) < DEDUP_WINDOW_MS) {
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

// ── /logLoot endpoint (legacy HTTP) ──────────────────────────────────
app.post("/logLoot", (req, res) => {
  const line = req.body?.lootMessage;
  if (!line) return res.status(400).send("Missing lootMessage");

  console.log("[http] /logLoot raw =", line);
  const m = LOOT_RE.exec(line);
  if (!m) return res.status(400).send("Invalid format");

  const gp = Number(m[3].replace(/,/g, ""));
  return processLoot(m[1], m[2], gp, line.trim(), res);
});

// ── /dink endpoint (RuneLite Dink plugin) ───────────────────────────
app.post(
  "/dink",
  // need raw body for multipart or JSON
  express.text({ type: "*/*" }),
  (req, res) => {
    let payload = req.body;
    // if it came in as a string, try JSON.parse
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch { /* not pure JSON, might be multipart later */ }
    }

    // debug
    console.log("[dink] payload:", JSON.stringify(payload).slice(0, 200));

    if (
      payload?.type === "CHAT" &&
      payload.extra?.type === "CLAN_CHAT"
    ) {
      console.log("[dink] content:", payload.content);
      console.log("[dink] extra.message:", payload.extra.message);

      // extract inner chat line from backticks
      const line = payload.content.replace(/^[^`]*`(.+)`$/, (_, inner) => inner);
      console.log("[dink] loot line:", line);

      return processLoot(
        // reuse same regex
        ...( (() => {
          const m = LOOT_RE.exec(line);
          return m
            ? [m[1], m[2], Number(m[3].replace(/,/g, "")), line.trim(), res]
            : (res.status(200).end(), [])
        })() )
      );
    }

    // otherwise ignore
    return res.status(204).end();
  }
);

// ── start HTTP after Discord is ready ─────────────────────────────────
client.once("ready", () => {
  console.log(`[discord] ready: ${client.user.tag}`);
  // Render will bind to the port in $PORT env; fallback to 3000 for local dev
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[http] listening on ${port}`));
});

// ── Discord commands (unchanged) ────────────────────────────────────
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  const text = msg.content.toLowerCase();
  const { deathCounts, lootTotals, gpTotal, kills } = getEventData();

  // !hiscores
  if (text === "!hiscores") {
    const board = Object.entries(kills)
      .map(([n, k]) => {
        const d = deathCounts[n] || 0;
        const kd = d === 0 ? k : (k / d).toFixed(2);
        return { n, k, d, kd };
      })
      .sort((a, b) => b.k - a.k)
      .slice(0, 10);

    const embed = new EmbedBuilder()
      .setTitle("🏆 Monday Madness Hiscores 🏆")
      .setColor(0xFF0000)
      .setTimestamp();
    if (board.length === 0) {
      embed.setDescription("No kills recorded yet.");
    } else {
      board.forEach((e, i) =>
        embed.addFields({
          name: `${i + 1}. ${e.n}`,
          value: `Kills: ${e.k} | Deaths: ${e.d} | K/D: ${e.kd}`,
          inline: false,
        })
      );
    }
    return msg.channel.send({ embeds: [embed] });
  }

  // !lootboard
  if (text === "!lootboard") {
    const sorted = Object.entries(lootTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const embed = new EmbedBuilder()
      .setTitle("💰 Top Loot Earners 💰")
      .setColor(0xFF0000)
      .setTimestamp();
    if (sorted.length === 0) {
      embed.setDescription("No loot recorded yet.");
    } else {
      sorted.forEach(([_n, gp], i) =>
        embed.addFields({
          name: `${i + 1}. ${_n}`,
          value: `${gp.toLocaleString()} coins`,
          inline: false,
        })
      );
    }
    return msg.channel.send({ embeds: [embed] });
  }

  // … (keep your other commands: !createEvent, !finishEvent, !help, !register, etc.) …

});

// ── login Discord ─────────────────────────────────────────────────────
client.login(DISCORD_BOT_TOKEN);
