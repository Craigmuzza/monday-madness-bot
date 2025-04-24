// bot.js
import express from "express";
import multer from "multer";
import { fileURLToPath } from "url";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events
} from "discord.js";
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
  // ensure identity on Render
  await git.addConfig("user.email", process.env.GIT_COMMIT_EMAIL || "bot@craigmuzza.com");
  await git.addConfig("user.name",  process.env.GIT_COMMIT_NAME  || "Robo-Rat Bot");
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
  gpTotal  [ci(killer)]  = (gpTotal[ci(killer)]  || 0) + gp;
  kills    [ci(killer)]  = (kills[ci(killer)]    || 0) + 1;

  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({
      name: currentEvent === "default" ? "Total GP Earned" : "Event GP Gained",
      value: `${gpTotal[ci(killer)].toLocaleString()} coins`,
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
  upload.fields([
    { name: "payload_json", maxCount: 1 },
    { name: "file",         maxCount: 1 }
  ]),
  async (req, res) => {
    let raw = req.body.payload_json;
    if (Array.isArray(raw)) raw = raw[0];
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

    const rsn = data.playerName;
    const msg = data.extra?.message;
    if (typeof msg === "string") {
      console.log(`[dink] seen by=${rsn} | message=${msg}`);
    }

    if (
      data.type === "CHAT" &&
      (data.extra?.type === "CLAN_CHAT" || data.extra?.type === "CLAN_MESSAGE") &&
      typeof msg === "string"
    ) {
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

// ── start server after Discord ready ────────────────────────────────
client.once("ready", () => {
  console.log(`[discord] ready: ${client.user.tag}`);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[http] listening on ${port}`));
});

// ── Discord commands ────────────────────────────────────────────────
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  const text = msg.content.toLowerCase();
  const { deathCounts, lootTotals, kills } = getEventData();

  // Hiscores
  if (text.startsWith("!hiscores")) {
    const parts = msg.content.split(" ");
    const target = parts[1]?.toLowerCase().trim();
    const board = Object.entries(kills)
      .filter(([n]) => !target || n === target)
      .map(([n,k]) => {
        const d = deathCounts[n] || 0;
        const ratio = d === 0 ? k : (k/d).toFixed(2);
        return { n, k, d, ratio };
      })
      .sort((a,b) => b.k - a.k)
      .slice(0,10);

    const embed = new EmbedBuilder()
      .setTitle("🏆 Robo-Rat Hiscores 🏆")
      .setColor(0xFF0000)
      .setTimestamp();

    if (board.length === 0) {
      embed.setDescription(target ? `No data for "${target}".` : "No kills recorded yet.");
    } else {
      board.forEach((e,i) =>
        embed.addFields({
          name: `${i+1}. ${e.n}`,
          value: `Kills: ${e.k} | Deaths: ${e.d} | K/D: ${e.ratio}`,
          inline: false
        })
      );
    }

    return msg.channel.send({ embeds: [embed] });
  }

  // Lootboard
  if (text.startsWith("!lootboard")) {
    const parts = msg.content.split(" ");
    const target = parts[1]?.toLowerCase().trim();
    const sorted = Object.entries(lootTotals)
      .filter(([n]) => !target || n === target)
      .sort((a,b) => b[1] - a[1])
      .slice(0,10);

    const embed = new EmbedBuilder()
      .setTitle("💰 Top Loot Earners 💰")
      .setColor(0xFF0000)
      .setTimestamp();

    if (sorted.length === 0) {
      embed.setDescription(target ? `No data for "${target}".` : "No loot recorded yet.");
    } else {
      sorted.forEach(([n,gp],i) =>
        embed.addFields({
          name: `${i+1}. ${n}`,
          value: `${gp.toLocaleString()} coins`,
          inline: false
        })
      );
    }

    return msg.channel.send({ embeds: [embed] });
  }

  // List clan registers
  if (text === "!listclan") {
    const list = [...registered].join(", ") || "No one registered.";
    return msg.reply(`Registered clan members: ${list}`);
  }

  // List events
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

  // Create event
  if (text.startsWith("!createevent ")) {
    const name = msg.content.slice(13).trim();
    if (!name || events[name]) return msg.reply("Invalid or duplicate event name.");
    events[name] = { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} };
    currentEvent = name;
    return msg.reply(`Event **${name}** created and selected.`);
  }

  // Finish event
  if (text === "!finishevent") {
    const file = `events/event_${currentEvent}_${new Date()
      .toISOString()
      .replace(/[:.]/g,"-")}.json`;
    fs.mkdirSync(path.dirname(path.join(__dirname,file)), { recursive:true });
    fs.writeFileSync(path.join(__dirname,file), JSON.stringify(events[currentEvent], null, 2));
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

  // Register names
  if (text.startsWith("!register ")) {
    const names = msg.content.slice(10).split(",").map(ci).filter(Boolean);
    names.forEach(n => registered.add(n));
    fs.writeFileSync(path.join(__dirname,"data/registered.json"), JSON.stringify([...registered], null, 2));
    await commitToGitHub();
    return msg.reply(`Registered: ${names.join(", ")}`);
  }

  // Unregister names
  if (text.startsWith("!unregister ")) {
    const names = msg.content.slice(12).split(",").map(ci).filter(Boolean);
    names.forEach(n => registered.delete(n));
    fs.writeFileSync(path.join(__dirname,"data/registered.json"), JSON.stringify([...registered], null, 2));
    await commitToGitHub();
    return msg.reply(`Unregistered: ${names.join(", ")}`);
  }

  // Clan-only on/off
  if (text === "!clanonly on") {
    clanOnlyMode = true;
    return msg.reply("Clan-only mode **enabled**.");
  }
  if (text === "!clanonly off") {
    clanOnlyMode = false;
    return msg.reply("Clan-only mode **disabled**.");
  }

  // Help
  if (text === "!help") {
    const embed = new EmbedBuilder()
      .setTitle("🛠 Robo-Rat – Help")
      .addFields(
        { name:"📊 Stats",  value:"`!hiscores [name]`, `!lootboard [name]`, `!listclan`", inline:false },
        { name:"🎯 Events", value:"`!createevent <name>`, `!finishevent`, `!listevents`", inline:false },
        { name:"👥 Clan",   value:"`!register <n1,n2>`, `!unregister <n1,n2>`, `!clanonly on/off`", inline:false },
        { name:"❓ Help",   value:"`!help`", inline:false }
      )
      .setColor(0xFF0000)
      .setTimestamp();
    return msg.channel.send({ embeds: [embed] });
  }
});

// ── login ───────────────────────────────────────────────────────────
client.login(DISCORD_BOT_TOKEN);
