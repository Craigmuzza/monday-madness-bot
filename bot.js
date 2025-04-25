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

// ── __dirname for ESM ───────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── env & repo info ─────────────────────────────────────────────────
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT         = process.env.GITHUB_PAT; // optional
const REPO               = "craigmuzza/monday-madness-bot";
const BRANCH             = "main";
const COMMIT_MSG         = "auto: sync data";

// ── constants ────────────────────────────────────────────────────────
const DEDUP_MS = 10_000;   // 10s
const LOOT_RE  = /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\( *([\d,]+) *coins\).*/i;
const DATA_DIR   = path.join(__dirname, "data");
const REG_FILE   = path.join(DATA_DIR, "registered.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");

// ── Express + Multer ─────────────────────────────────────────────────
const app    = express();
const upload = multer(); // for multipart/form-data
app.use(express.json());
app.use(express.text({ type: "text/*" }));

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
const registered = new Set();
const seen       = new Map();
const events     = {
  default: { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} }
};
const ci  = s => (s||"").toLowerCase().trim();
const now = () => Date.now();

// ── ensure data dir exists ───────────────────────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── load registrations ───────────────────────────────────────────────
try {
  const arr = JSON.parse(fs.readFileSync(REG_FILE));
  if (Array.isArray(arr)) arr.forEach(n => registered.add(ci(n)));
  console.log(`[init] loaded ${registered.size} registered names`);
} catch {
  fs.writeFileSync(REG_FILE, JSON.stringify([], null, 2));
  console.log("[init] created empty registered.json");
}

// ── load persisted kills/GP ──────────────────────────────────────────
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE));
  if (saved.kills && saved.gpTotal) {
    events.default = saved;
    console.log("[init] loaded persisted state");
  }
} catch {
  fs.writeFileSync(STATE_FILE, JSON.stringify(events.default, null, 2));
  console.log("[init] created empty state.json");
}

// ── helpers ──────────────────────────────────────────────────────────
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(events.default, null, 2));
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
function getEventData() {
  if (!events[currentEvent]) {
    events[currentEvent] = { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} };
  }
  return events[currentEvent];
}
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
  lootTotals[ci(killer)] = (lootTotals[ci(killer)]||0) + gp;
  gpTotal[ci(killer)]    = (gpTotal[ci(killer)]   ||0) + gp;
  kills[ci(killer)]      = (kills[ci(killer)]     ||0) + 1;
  saveState();

  const subtitle = currentEvent === "default"
    ? "Total GP Earned"
    : "Event GP Gained";

  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({
      name: subtitle,
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

// ── /dink endpoint ───────────────────────────────────────────────────
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
    try { data = JSON.parse(raw); }
    catch (e) {
      console.error("[dink] JSON parse error", e);
      return res.status(400).send("bad JSON");
    }

    const rsn = data.playerName;
    const msg = data.extra?.message;
    if (msg) console.log(`[dink] seen by=${rsn} | message=${msg}`);

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

// ── Discord commands ─────────────────────────────────────────────────
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  const text = msg.content;
  const lc   = text.toLowerCase();
  const { deathCounts, lootTotals, gpTotal, kills } = getEventData();

  // !hiscores [name]
  if (lc.startsWith("!hiscores")) {
    const name = text.slice(10).trim();
    if (!name) {
      // top 10
      const board = Object.entries(kills)
        .map(([n,k]) => {
          const d = deathCounts[n]||0;
          return { n, k, d, kd: d ? (k/d).toFixed(2) : k };
        })
        .sort((a,b)=>b.k - a.k)
        .slice(0,10);
      const e = new EmbedBuilder()
        .setTitle("🏆 Hiscores")
        .setColor(0xFF0000)
        .setTimestamp();
      if (!board.length) e.setDescription("No kills yet.");
      else board.forEach((v,i) =>
        e.addFields({
          name: `${i+1}. ${v.n}`,
          value: `Kills ${v.k} | Deaths ${v.d} | K/D ${v.kd}`,
          inline: false
        })
      );
      return msg.channel.send({ embeds: [e] });
    } else {
      const key = ci(name);
      if (!kills[key]) return msg.reply(`No kills for "${name}"`);
      const k  = kills[key], d = deathCounts[key]||0;
      const kd = d ? (k/d).toFixed(2) : k;
      return msg.reply(`**${name}** – Kills: ${k}, Deaths: ${d}, K/D: ${kd}`);
    }
  }

  // !lootboard [name]
  if (lc.startsWith("!lootboard")) {
    const name = text.slice(11).trim();
    if (!name) {
      const sorted = Object.entries(lootTotals)
        .sort((a,b)=>b[1] - a[1])
        .slice(0,10);
      const e = new EmbedBuilder()
        .setTitle("💰 Top Loot Earners")
        .setColor(0xFF0000)
        .setTimestamp();
      if (!sorted.length) e.setDescription("No loot yet.");
      else sorted.forEach(([n,gp],i) =>
        e.addFields({
          name: `${i+1}. ${n}`,
          value: `${gp.toLocaleString()} coins`,
          inline: false
        })
      );
      return msg.channel.send({ embeds: [e] });
    } else {
      const key = ci(name);
      if (!lootTotals[key]) return msg.reply(`No loot for "${name}"`);
      return msg.reply(`**${name}** has looted a total of ${lootTotals[key].toLocaleString()} coins`);
    }
  }

  // !listclan
  if (lc === "!listclan") {
    if (!registered.size) return msg.reply("No one registered yet.");
    return msg.reply(`Registered clan: ${[...registered].join(", ")}`);
  }

  // !register / !unregister
  if (lc.startsWith("!register ")) {
    const names = text.slice(10).split(",").map(ci).filter(Boolean);
    names.forEach(n => registered.add(n));
    fs.writeFileSync(REG_FILE, JSON.stringify([...registered], null, 2));
    await commitToGitHub();
    return msg.reply(`Registered: ${names.join(", ")}`);
  }
  if (lc.startsWith("!unregister ")) {
    const names = text.slice(12).split(",").map(ci).filter(Boolean);
    names.forEach(n => registered.delete(n));
    fs.writeFileSync(REG_FILE, JSON.stringify([...registered], null, 2));
    await commitToGitHub();
    return msg.reply(`Unregistered: ${names.join(", ")}`);
  }

  // !clanonly on/off
  if (lc === "!clanonly on") {
    clanOnlyMode = true;
    return msg.reply("Clan-only mode **enabled**.");
  }
  if (lc === "!clanonly off") {
    clanOnlyMode = false;
    return msg.reply("Clan-only mode **disabled**.");
  }

  // event management & help
  if (lc === "!listevents") {
    const e = new EmbedBuilder()
      .setTitle("📅 Available Events")
      .setDescription(
        Object.keys(events)
          .map(ev => `• ${ev}${ev === currentEvent ? " *(current)*" : ""}`)
          .join("\n")
      )
      .setColor(0xFF0000)
      .setTimestamp();
    return msg.channel.send({ embeds: [e] });
  }
  if (lc.startsWith("!createevent ")) {
    const name = text.slice(13).trim();
    if (!name || events[name]) return msg.reply("Invalid or duplicate name.");
    events[name] = { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} };
    currentEvent = name;
    return msg.reply(`Event **${name}** created and selected.`);
  }
  if (lc === "!finishevent") {
    const file = `events/event_${currentEvent}_${new Date()
      .toISOString()
      .replace(/[:.]/g,"-")}.json`;
    fs.mkdirSync(path.dirname(path.join(__dirname,file)), { recursive:true });
    fs.writeFileSync(path.join(__dirname,file), JSON.stringify(events[currentEvent], null, 2));
    await commitToGitHub();
    delete events[currentEvent];
    currentEvent = "default";
    const e = new EmbedBuilder()
      .setTitle("📦 Event Finalised")
      .setDescription(`Saved as \`${file}\` and switched back to **default**.`)
      .setColor(0xFF0000)
      .setTimestamp();
    return msg.channel.send({ embeds: [e] });
  }

  if (lc === "!help") {
    const e = new EmbedBuilder()
      .setTitle("🛠 Robo-Rat – Help")
      .addFields(
        { name:"📊 Stats",  value:"`!hiscores [name]`, `!lootboard [name]`, `!listclan`", inline:false },
        { name:"🎯 Events", value:"`!createevent <name>`, `!finishevent`, `!listevents`", inline:false },
        { name:"👥 Clan",   value:"`!register <names>`, `!unregister <names>`, `!clanonly on/off`", inline:false },
        { name:"❓ Help",   value:"`!help`", inline:false }
      )
      .setColor(0xFF0000)
      .setTimestamp();
    return msg.channel.send({ embeds: [e] });
  }
});

// ── start server & login ─────────────────────────────────────────────
client.once("ready", () => {
  console.log(`[discord] ready: ${client.user.tag}`);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[http] listening on ${port}`));
});
client.login(DISCORD_BOT_TOKEN);
