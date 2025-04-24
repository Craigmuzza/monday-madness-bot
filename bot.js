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
const upload = multer().none();  // only parse text fields, no files

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
const registered = new Set();  // lower-case RSNs
const seen       = new Map();  // for de-duplication
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

  // configure author identity from env
  if (process.env.GIT_COMMIT_EMAIL && process.env.GIT_COMMIT_NAME) {
    await git.addConfig('user.email',  process.env.GIT_COMMIT_EMAIL);
    await git.addConfig('user.name',   process.env.GIT_COMMIT_NAME);
  }

  await git.add('.');
  await git.commit(COMMIT_MSG);
  await git.push(
    `https://${process.env.GITHUB_ACTOR}:${GITHUB_PAT}@github.com/${REPO}.git`,
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

  const title = currentEvent === "default"
    ? "💰 Total GP Earned"
    : "💰 Loot Detected";

  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({
      name: title,
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

// ── /dink (Runelite-Dink multipart) ─────────────────────────────────
app.post("/dink", upload, async (req, res) => {
  let raw = req.body.payload_json;
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
  console.log(`[dink] seen by=${rsn} | message=${msg}`);

  if (
    data.type === "CHAT" &&
    (data.extra?.type === "CLAN_CHAT" || data.extra?.type === "CLAN_MESSAGE") &&
    typeof msg === "string"
  ) {
    const m = msg.match(LOOT_RE);
    if (m) {
      return processLoot(
        m[1], m[2],
        Number(m[3].replace(/,/g, "")),
        msg.trim(), res
      );
    }
  }

  return res.status(204).end();
});

// ── start HTTP after Discord ready ────────────────────────────────
client.once("ready", () => {
  console.log(`[discord] ready: ${client.user.tag}`);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[http] listening on ${port}`));
});

// ── Discord text commands ─────────────────────────────────────────
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  const text = msg.content.trim();
  const lct = text.toLowerCase();
  const { deathCounts, lootTotals, kills } = getEventData();

  // ── !hiscores [name]
  if (lct.startsWith("!hiscores")) {
    const nameArg = text.slice(9).trim(); // after "!hiscores"
    if (nameArg) {
      const key = ci(nameArg);
      const k = kills[key] || 0;
      const d = deathCounts[key] || 0;
      const ratio = d === 0 ? k : (k/d).toFixed(2);
      const embed = new EmbedBuilder()
        .setTitle(`🏆 ${nameArg} Hiscores 🏆`)
        .addFields(
          { name: "Kills",  value: String(k), inline: true },
          { name: "Deaths", value: String(d), inline: true },
          { name: "K/D",     value: String(ratio), inline: true }
        )
        .setColor(0xFF0000)
        .setTimestamp();
      return msg.channel.send({ embeds: [embed] });
    }
    // top 10
    const board = Object.entries(kills)
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
      embed.setDescription("No kills recorded yet.");
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

  // ── !lootboard [name]
  if (lct.startsWith("!lootboard")) {
    const nameArg = text.slice(10).trim();
    if (nameArg) {
      const key = ci(nameArg);
      const gp  = lootTotals[key] || 0;
      const embed = new EmbedBuilder()
        .setTitle(`💰 ${nameArg} GP Totals 💰`)
        .setDescription(`${gp.toLocaleString()} coins`)
        .setColor(0xFF0000)
        .setTimestamp();
      return msg.channel.send({ embeds: [embed] });
    }
    // top 10
    const sorted = Object.entries(lootTotals)
      .sort((a,b) => b[1] - a[1])
      .slice(0,10);

    const embed = new EmbedBuilder()
      .setTitle("💰 Top Loot Earners 💰")
      .setColor(0xFF0000)
      .setTimestamp();

    if (sorted.length === 0) {
      embed.setDescription("No loot recorded yet.");
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

  // ── !listclan
  if (lct === "!listclan") {
    if (registered.size === 0) {
      return msg.reply("No clan members registered.");
    }
    return msg.reply(`Registered clan members: ${[...registered].join(", ")}`);
  }

  // ── !register and !unregister
  if (lct.startsWith("!register ")) {
    const names = text.slice(10).split(",").map(ci).filter(Boolean);
    names.forEach(n => registered.add(n));
    fs.writeFileSync(
      path.join(__dirname,"data/registered.json"),
      JSON.stringify([...registered], null, 2)
    );
    await commitToGitHub();
    return msg.reply(`Registered: ${names.join(", ")}`);
  }
  if (lct.startsWith("!unregister ")) {
    const names = text.slice(12).split(",").map(ci).filter(Boolean);
    names.forEach(n => registered.delete(n));
    fs.writeFileSync(
      path.join(__dirname,"data/registered.json"),
      JSON.stringify([...registered], null, 2)
    );
    await commitToGitHub();
    return msg.reply(`Unregistered: ${names.join(", ")}`);
  }

  // ── !clanonly on/off
  if (lct === "!clanonly on") {
    clanOnlyMode = true;
    return msg.reply("Clan-only mode **enabled**.");
  }
  if (lct === "!clanonly off") {
    clanOnlyMode = false;
    return msg.reply("Clan-only mode **disabled**.");
  }

  // ── events commands, help, etc. (unchanged from before)
  if (lct === "!listevents") {
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
  if (lct.startsWith("!createevent ")) {
    const name = msg.content.slice(13).trim();
    if (!name || events[name]) return msg.reply("Invalid or duplicate name.");
    events[name] = { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} };
    currentEvent = name;
    return msg.reply(`Event **${name}** created and selected.`);
  }
  if (lct === "!finishevent") {
    const file = `events/event_${currentEvent}_${new Date()
      .toISOString()
      .replace(/[:.]/g,"-")}.json`;
    fs.mkdirSync(path.dirname(path.join(__dirname,file)), { recursive:true });
    fs.writeFileSync(
      path.join(__dirname,file),
      JSON.stringify(events[currentEvent], null, 2)
    );
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

  if (lct === "!help") {
    const embed = new EmbedBuilder()
      .setTitle("🛠 Robo-Rat – Help")
      .addFields(
        { name:"📊 Stats",  value:"`!hiscores [name]`, `!lootboard [name]`, `!listclan`", inline:false },
        { name:"🎯 Events", value:"`!createevent <name>`, `!finishevent`, `!listevents`", inline:false },
        { name:"👥 Clan",   value:"`!register <names>`, `!unregister <names>`, `!clanonly on/off`", inline:false },
        { name:"❓ Help",   value:"`!help`", inline:false }
      )
      .setColor(0xFF0000)
      .setTimestamp();
    return msg.channel.send({ embeds: [embed] });
  }
});

// ── login ───────────────────────────────────────────────────────────
client.login(DISCORD_BOT_TOKEN);
