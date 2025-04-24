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
const GITHUB_PAT         = process.env.GITHUB_PAT;  // optional for GitHub commits
const REPO               = "craigmuzza/monday-madness-bot";
const BRANCH             = "main";
const COMMIT_MSG         = "auto: sync data";

// ── constants ───────────────────────────────────────────────────────
const DEDUP_MS = 10_000;   // 10s anti-spam window
const LOOT_RE  = /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\( *([\d,]+) *coins\).*/i;

// ── express + multer ─────────────────────────────────────────────────
const app    = express();
const upload = multer();  // handles multipart/form-data

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
const registered = new Set();   // lower-case RSNs
const seen       = new Map();   // dedup map
const events     = {};          // will load below

const ci  = s => (s||"").toLowerCase().trim();
const now = () => Date.now();

// ── helpers for JSON persistence ───────────────────────────────────
function loadJSON(relPath, fallback) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, relPath), "utf-8")
    );
  } catch {
    return fallback;
  }
}
function saveJSON(relPath, obj) {
  const fp = path.join(__dirname, relPath);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
}

// ── load persisted clan registrations ───────────────────────────────
const regList = loadJSON("data/registered.json", []);
regList.forEach(n => registered.add(ci(n)));
console.log(`[init] loaded ${registered.size} registered names`);

// ── load persisted default event stats ─────────────────────────────
events.default = loadJSON("data/default.json", {
  deathCounts: {},
  lootTotals: {},
  gpTotal: {},
  kills: {}
});

// ensure our `currentEvent` always exists
if (!events[currentEvent]) events[currentEvent] = events.default;

// ── optional GitHub commit helper (errors are caught) ───────────────
async function commitToGitHub() {
  if (!GITHUB_PAT) return;
  try {
    const git = simpleGit();
    await git.add(".");
    await git.commit(COMMIT_MSG);
    await git.push(
      `https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`,
      BRANCH
    );
  } catch (e) {
    console.error("Git commit failed:", e.message);
  }
}

// ── get-or-create current event object ──────────────────────────────
function getEventData() {
  if (!events[currentEvent]) {
    events[currentEvent] = {
      deathCounts: {},
      lootTotals: {},
      gpTotal: {},
      kills: {}
    };
  }
  return events[currentEvent];
}

// ── core loot processor ─────────────────────────────────────────────
async function processLoot(killer, victim, gp, dedupKey, res) {
  // clan-only filter
  if (
    clanOnlyMode &&
    (!registered.has(ci(killer)) ||
     !registered.has(ci(victim)))
  ) {
    return res.status(200).send("non-clan ignored");
  }
  // de-dup
  if (seen.has(dedupKey) && now() - seen.get(dedupKey) < DEDUP_MS) {
    return res.status(200).send("duplicate");
  }
  seen.set(dedupKey, now());

  // update stats
  const ev = getEventData();
  ev.lootTotals[ci(killer)] = (ev.lootTotals[ci(killer)]||0) + gp;
  ev.gpTotal[ci(killer)]    = (ev.gpTotal[ci(killer)]   ||0) + gp;
  ev.kills[ci(killer)]      = (ev.kills[ci(killer)]     ||0) + 1;

  // persist default event so it never resets
  if (currentEvent === "default") {
    saveJSON("data/default.json", events.default);
  }

  // send embed
  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({
      name: currentEvent === "default" ? "Total GP Earned" : "Event GP Gained",
      value: `${ev.gpTotal[ci(killer)].toLocaleString()} coins`,
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

  const ev = getEventData();
  ev.deathCounts[ci(victim)] = (ev.deathCounts[ci(victim)] || 0) + 1;
  if (currentEvent === "default") saveJSON("data/default.json", events.default);

  const embed = new EmbedBuilder()
    .setTitle("💀 Kill Logged")
    .setDescription(`**${killer}** killed **${victim}**`)
    .addFields({
      name: "Total Deaths",
      value: String(ev.deathCounts[ci(victim)]),
      inline: true
    })
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
  return processLoot(m[1], m[2], Number(m[3].replace(/,/g,"")), txt.trim(), res);
});

// ── /dink (Runelite-Dink multipart) ────────────────────────────────
app.post(
  "/dink",
  upload.fields([
    { name:"payload_json", maxCount:1 },
    { name:"file",         maxCount:1 }  // optional screenshot
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

    // Log RSN + clan-chat line
    const rsn = data.playerName;
    const msg = data.extra?.message;
    if (typeof msg === "string") {
      console.log(`[dink] seen by=${rsn} | message=${msg}`);
    }

    // match & process
    if (
      data.type === "CHAT" &&
      (data.extra?.type === "CLAN_CHAT" || data.extra?.type === "CLAN_MESSAGE") &&
      typeof msg === "string"
    ) {
      const m = msg.match(LOOT_RE);
      if (m) {
        return processLoot(
          m[1], m[2], Number(m[3].replace(/,/g,"")),
          msg.trim(), res
        );
      }
    }

    return res.status(204).end();
  }
);

// ── start HTTP after Discord ready ─────────────────────────────────
client.once("ready", () => {
  console.log(`[discord] ready: ${client.user.tag}`);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[http] listening on ${port}`));
});

// ── Discord chat commands ───────────────────────────────────────────
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  const text = msg.content.trim();
  const lower = text.toLowerCase();
  const ev = getEventData();

  // — Hiscores: !hiscores [optionalName]
  if (lower.startsWith("!hiscores")) {
    const parts = text.split(" ").slice(1);
    const name = parts.join(" ") || null;
    const board = Object.entries(ev.kills)
      .filter(([n]) => !name || n === ci(name))
      .map(([n,k]) => {
        const d = ev.deathCounts[n]||0;
        const ratio = d===0 ? k : (k/d).toFixed(2);
        return { n,k,d,ratio };
      })
      .sort((a,b)=>b.k-a.k)
      .slice(0,10);
    const e = new EmbedBuilder()
      .setTitle(name ? `🏆 Hiscores for ${name}` : "🏆 Hiscores")
      .setColor(0xFF0000)
      .setTimestamp();
    if (!board.length) e.setDescription("No data.");
    else board.forEach((v,i)=>
      e.addFields({
        name:`${i+1}. ${v.n}`,
        value:`Kills: ${v.k} | Deaths: ${v.d} | K/D: ${v.ratio}`,
        inline:false
      })
    );
    return msg.channel.send({ embeds:[e] });
  }

  // — Lootboard: !lootboard [optionalName]
  if (lower.startsWith("!lootboard")) {
    const parts = text.split(" ").slice(1);
    const name = parts.join(" ") || null;
    const sorted = Object.entries(ev.lootTotals)
      .filter(([n]) => !name || n === ci(name))
      .sort((a,b)=>b[1]-a[1])
      .slice(0,10);
    const e = new EmbedBuilder()
      .setTitle(name ? `💰 Loot for ${name}` : "💰 Top Loot Earners")
      .setColor(0xFF0000)
      .setTimestamp();
    if (!sorted.length) e.setDescription("No data.");
    else sorted.forEach(([n,gp],i)=>
      e.addFields({
        name:`${i+1}. ${n}`,
        value:`${gp.toLocaleString()} coins`,
        inline:false
      })
    );
    return msg.channel.send({ embeds:[e] });
  }

  // — List clan members
  if (lower === "!listclan") {
    const arr = [...registered];
    return msg.reply(
      arr.length
        ? `Registered clan members: ${arr.join(", ")}`
        : "No one registered yet."
    );
  }

  // — Register / Unregister
  if (lower.startsWith("!register ")) {
    const names = msg.content
      .slice(10)
      .split(",")
      .map(ci)
      .filter(Boolean);
    names.forEach(n=>registered.add(n));
    saveJSON("data/registered.json", [...registered]);
    await commitToGitHub();
    return msg.reply(`Registered: ${names.join(", ")}`);
  }
  if (lower.startsWith("!unregister ")) {
    const names = msg.content
      .slice(12)
      .split(",")
      .map(ci)
      .filter(Boolean);
    names.forEach(n=>registered.delete(n));
    saveJSON("data/registered.json", [...registered]);
    await commitToGitHub();
    return msg.reply(`Unregistered: ${names.join(", ")}`);
  }

  // — Clan-only mode
  if (lower === "!clanonly on") {
    clanOnlyMode = true;
    return msg.reply("Clan-only mode **enabled**.");
  }
  if (lower === "!clanonly off") {
    clanOnlyMode = false;
    return msg.reply("Clan-only mode **disabled**.");
  }

  // — Event commands
  if (lower === "!listevents") {
    const list = Object.keys(events)
      .map(e=>`• ${e}${e===currentEvent?" *(current)*":""}`)
      .join("\n");
    const e = new EmbedBuilder()
      .setTitle("📅 Available Events")
      .setDescription(list)
      .setColor(0xFF0000)
      .setTimestamp();
    return msg.channel.send({ embeds:[e] });
  }
  if (lower.startsWith("!createevent ")) {
    const name = msg.content.slice(13).trim();
    if (!name || events[name]) return msg.reply("Invalid or duplicate name.");
    events[name] = { deathCounts:{},lootTotals:{},gpTotal:{},kills:{} };
    currentEvent = name;
    return msg.reply(`Event **${name}** created and selected.`);
  }
  if (lower === "!finishevent") {
    const file = `events/event_${currentEvent}_${new Date()
      .toISOString().replace(/[:.]/g,"-")}.json`;
    fs.mkdirSync(path.dirname(path.join(__dirname,file)),{recursive:true});
    fs.writeFileSync(
      path.join(__dirname,file),
      JSON.stringify(events[currentEvent],null,2)
    );
    await commitToGitHub();
    delete events[currentEvent];
    currentEvent = "default";
    const e = new EmbedBuilder()
      .setTitle("📦 Event Finalised")
      .setDescription(`Saved to \`${file}\` and switched back to **default**.`)
      .setColor(0xFF0000)
      .setTimestamp();
    return msg.channel.send({ embeds:[e] });
  }

  // — Help
  if (lower === "!help") {
    const e = new EmbedBuilder()
      .setTitle("🛠 Robo-Rat – Help")
      .addFields(
        { name:"📊 Stats",  value:"`!hiscores [name]`, `!lootboard [name]`", inline:false },
        { name:"👥 Clan",   value:"`!listclan`, `!register a,b`, `!unregister a,b`, `!clanonly on/off`", inline:false },
        { name:"🎯 Events", value:"`!listevents`, `!createevent <name>`, `!finishevent`", inline:false },
        { name:"❓ Help",   value:"`!help`", inline:false }
      )
      .setColor(0xFF0000)
      .setTimestamp();
    return msg.channel.send({ embeds:[e] });
  }
});

// ── login ───────────────────────────────────────────────────────────
client.login(DISCORD_BOT_TOKEN);
