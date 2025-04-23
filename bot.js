// bot.js
import express from "express";
import { Client, GatewayIntentBits, EmbedBuilder, Events } from "discord.js";
import fs from "fs";
import path from "path";
import simpleGit from "simple-git";
import pkg from "formidable";           // pull in the CommonJS module
const { formidable } = pkg;             // now you can call formidable()

import dotenv from "dotenv";
dotenv.config();

// ── env ─────────────────────────────────────────────────────────────
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT         = process.env.GITHUB_PAT;
const REPO               = "craigmuzza/monday-madness-bot";
const BRANCH             = "main";
const COMMIT_MSG         = "auto: sync data";

// ── constants ───────────────────────────────────────────────────────
const DEDUP_MS = 10_000;
const LOOT_RE  = /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\( *([\d,]+) *coins\).*/i;

// ── express setup ───────────────────────────────────────────────────
const app = express();
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
let currentEvent   = "default";
let clanOnlyMode   = false;
const registered   = new Set();  // lower-case names
const seen         = new Map();  // dedupe map
const events       = {
  default: { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} }
};

const ci  = (s = "") => s.toLowerCase().trim();
const now = () => Date.now();

// ── load saved registrations ────────────────────────────────────────
try {
  const arr = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "data/registered.json"))
  );
  if (Array.isArray(arr)) arr.forEach(n => registered.add(ci(n)));
  console.log(`[init] loaded ${registered.size} registered names`);
} catch {
  console.log("[init] no registrations file yet");
}

// ── helper: commit to GitHub ────────────────────────────────────────
async function commitToGitHub() {
  if (!GITHUB_PAT) return;
  const git = simpleGit();
  await git.add(".");
  await git.commit(COMMIT_MSG);
  await git.push(`https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`, BRANCH);
}

// ── helper: get or init current event data ──────────────────────────
function getEventData() {
  if (!events[currentEvent]) {
    events[currentEvent] = { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} };
  }
  return events[currentEvent];
}

// ── core loot handler ───────────────────────────────────────────────
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
    .addFields({
      name: "Total Deaths",
      value: String(deathCounts[ci(victim)]),
      inline: true
    })
    .setColor(0xFF0000)
    .setTimestamp();

  const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if (ch?.isTextBased()) {
    await ch.send({ embeds: [embed] });
  }

  res.status(200).send("ok");
});

// ── /logLoot legacy endpoint ────────────────────────────────────────
app.post("/logLoot", (req, res) => {
  const txt = req.body?.lootMessage;
  if (!txt) return res.status(400).send("bad");
  const m = txt.match(LOOT_RE);
  if (!m) return res.status(400).send("fmt");
  return processLoot(
    m[1],
    m[2],
    Number(m[3].replace(/,/g, "")),
    txt.trim(),
    res
  );
});

// ── /dink endpoint (multipart/form-data) ──────────────────────────
app.post("/dink", (req, res) => {
  const ct = (req.headers["content-type"] || "").toLowerCase();

  // A) multipart/form-data
  if (ct.startsWith("multipart/form-data")) {
    return formidable({ multiples: false }).parse(req, (err, fields) => {
      if (err || !fields.payload_json) {
        return res.status(400).send("multipart err");
      }
      let data;
      try {
        data = JSON.parse(fields.payload_json);
      } catch {
        return res.status(400).send("bad JSON");
      }

      // only clan chat
      if (
        data.type === "CHAT" &&
        data.extra?.type === "CLAN_CHAT" &&
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
    });
  }

  // B) fallback for JSON or raw text
  if (typeof req.body === "object") {
    const data = req.body;
    if (
      data.type === "CHAT" &&
      data.extra?.type === "CLAN_CHAT" &&
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

  if (typeof req.body === "string") {
    const msg = req.body;
    console.log("[dink] text:", msg);
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
});

// ── start HTTP after Discord is ready ───────────────────────────────
client.once("ready", () => {
  console.log(`[discord] ready: ${client.user.tag}`);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[http] listening on ${port}`));
});

// ── Discord command handlers ────────────────────────────────────────
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  const text = msg.content.toLowerCase();
  const { deathCounts, lootTotals, kills } = getEventData();

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
      board.forEach((e, i) => {
        embed.addFields({
          name: `${i + 1}. ${e.n}`,
          value: `Kills: ${e.k} | Deaths: ${e.d} | K/D: ${e.kd}`,
          inline: false
        });
      });
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
      sorted.forEach(([n, gp], i) => {
        embed.addFields({
          name: `${i + 1}. ${n}`,
          value: `${gp.toLocaleString()} coins`,
          inline: false
        });
      });
    }

    return msg.channel.send({ embeds: [embed] });
  }

  // !listEvents
  if (text === "!listevents") {
    const embed = new EmbedBuilder()
      .setTitle("📅 Available Events")
      .setDescription(
        Object.keys(events)
          .map(e => `• ${e}${e === currentEvent ? " *(current)*" : ""}`)
          .join("\n")
      )
      .setColor(0xFF0000)
      .setTimestamp();
    return msg.channel.send({ embeds: [embed] });
  }

  // !createEvent <name>
  if (text.startsWith("!createevent ")) {
    const name = msg.content.slice(13).trim();
    if (!name || events[name]) {
      return msg.reply("Invalid or duplicate event name.");
    }
    events[name] = { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} };
    currentEvent = name;
    return msg.reply(`Event **${name}** created and selected.`);
  }

  // !finishEvent
  if (text === "!finishevent") {
    const file = `events/event_${currentEvent}_${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(events[currentEvent], null, 2));
    await commitToGitHub();
    delete events[currentEvent];
    currentEvent = "default";

    const embed = new EmbedBuilder()
      .setTitle("📦 Event Finalised")
      .setDescription(`Saved as \`${file}\` and switched back to **default**.`)
      .setColor(0xFF0000)
      .setTimestamp();
    return msg.channel.send({ embeds: [embed] });
  }

  // !register <a,b,c>
  if (text.startsWith("!register ")) {
    const names = msg.content
      .slice(10)
      .split(",")
      .map(ci)
      .filter(Boolean);
    names.forEach(n => registered.add(n));
    fs.mkdirSync("data", { recursive: true });
    fs.writeFileSync(
      path.join("data", "registered.json"),
      JSON.stringify(Array.from(registered), null, 2)
    );
    await commitToGitHub();
    return msg.reply(`Registered: ${names.join(", ")}`);
  }

  // !unregister <a,b,c>
  if (text.startsWith("!unregister ")) {
    const names = msg.content
      .slice(12)
      .split(",")
      .map(ci)
      .filter(Boolean);
    names.forEach(n => registered.delete(n));
    fs.writeFileSync(
      path.join("data", "registered.json"),
      JSON.stringify(Array.from(registered), null, 2)
    );
    await commitToGitHub();
    return msg.reply(`Unregistered: ${names.join(", ")}`);
  }

  // !clanOnly on/off
  if (text === "!clanonly on") {
    clanOnlyMode = true;
    return msg.reply("Clan-only mode **enabled**.");
  }
  if (text === "!clanonly off") {
    clanOnlyMode = false;
    return msg.reply("Clan-only mode **disabled**.");
  }

  // !help
  if (text === "!help") {
    const embed = new EmbedBuilder()
      .setTitle("🛠 Monday Madness Bot – Help")
      .addFields(
        { name: "📊 Stats",  value: "`!hiscores`, `!lootboard`", inline: false },
        { name: "🎯 Events", value: "`!createEvent <name>`, `!finishEvent`, `!listEvents`", inline: false },
        { name: "👥 Clan",   value: "`!register <names>`, `!unregister <names>`, `!clanOnly on/off`", inline: false },
        { name: "❓ Help",   value: "`!help`", inline: false }
      )
      .setColor(0xFF0000)
      .setTimestamp();
    return msg.channel.send({ embeds: [embed] });
  }
});

// ── start bot ───────────────────────────────────────────────────────
client.login(DISCORD_BOT_TOKEN);
