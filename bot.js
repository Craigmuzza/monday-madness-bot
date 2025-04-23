/*  ────────────────────────────────────────────────────────────────────
    Monday-Madness Discord bot – single-instance / de-duping version
    ──────────────────────────────────────────────────────────────────── */
const express      = require("express");
const bodyParser   = require("body-parser");
const { Client, GatewayIntentBits, EmbedBuilder, Events } = require("discord.js");
const fs           = require("fs");
const path         = require("path");
const simpleGit    = require("simple-git");
require("dotenv").config();

/* ── env ───────────────────────────────────────────────────────────── */
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT   = process.env.GITHUB_PAT;          // optional – safe if unset
const REPO         = "craigmuzza/monday-madness-bot";
const BRANCH       = "main";
const COMMIT_MSG   = "auto: sync data";

/* ── constants ─────────────────────────────────────────────────────── */
const DEDUP_WINDOW_MS = 10_000;                       // 10-s anti-spam window

/* ── express ───────────────────────────────────────────────────────── */
const app = express();
app.use(bodyParser.json());

/* ── discord client ────────────────────────────────────────────────── */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/* ── in-memory state ───────────────────────────────────────────────── */
let currentEvent    = "default";
let clanOnlyMode    = false;
let registeredNames = new Set();          // lower-case entries
let chatKillCounts  = {};                 // kills from loot lines

const events = {
  default: { deathCounts:{}, lootTotals:{}, gpTotal:{} }
};

/* ── de-duplication cache ──────────────────────────────────────────── */
const seenRecently = new Map();           // key → timestamp (ms)
setInterval(() => {
  const now = Date.now();
  for (const [k,t] of seenRecently)
    if (now - t > DEDUP_WINDOW_MS) seenRecently.delete(k);
}, 30_000);

/* ── helper fns ────────────────────────────────────────────────────── */
const ci = (s = "") => s.toLowerCase().trim();

function getEventData() {
  if (!events[currentEvent])
    events[currentEvent] = { deathCounts:{}, lootTotals:{}, gpTotal:{} };
  return events[currentEvent];
}

function saveJSON(file, data) {
  const p = path.join(__dirname, file);
  fs.mkdirSync(path.dirname(p), { recursive:true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

async function commitToGitHub() {
  if (!GITHUB_PAT) return;                      // PAT not configured → skip
  const git = simpleGit();
  await git.add(".");
  await git.commit(COMMIT_MSG);
  await git.push(
    `https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`,
    BRANCH
  );
}

/* ── load persistent registered names on start-up ─────────────────── */
try {
  const stored = JSON.parse(
    fs.readFileSync(path.join(__dirname,"data/registered.json"))
  );
  if (Array.isArray(stored)) stored.forEach(n => registeredNames.add(ci(n)));
  console.log(`Loaded ${registeredNames.size} registered clan names`);
} catch {/* first run – nothing to load */}

/* ───────────────── HTTP ROUTES ────────────────────────────────────── */

/* ---------- shared loot processing so /logLoot and /dink can call -- */
async function handleLootLine(rawMessage, res) {
  const lootRe =
    /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\(([\d,]+)\s+coins\).*/i;
  const m = rawMessage.match(lootRe);
  if (!m) return res?.status(400).send("Invalid loot format");

  const [, killer, victim, gpStr] = m;
  if (
    clanOnlyMode &&
    (!registeredNames.has(ci(killer)) || !registeredNames.has(ci(victim)))
  ) {
    return res?.status(200).send("Non-clan loot ignored");
  }

  const dedupKey = `L|${rawMessage.trim()}`;
  if (
    seenRecently.has(dedupKey) &&
    Date.now() - seenRecently.get(dedupKey) < DEDUP_WINDOW_MS
  )
    return res?.status(200).send("Duplicate loot suppressed");
  seenRecently.set(dedupKey, Date.now());

  const gp = Number(gpStr.replace(/,/g,""));
  const { lootTotals, gpTotal } = getEventData();
  lootTotals[ci(killer)] = (lootTotals[ci(killer)] || 0) + gp;
  gpTotal  [ci(killer)] = (gpTotal  [ci(killer)] || 0) + gp;
  chatKillCounts[ci(killer)] = (chatKillCounts[ci(killer)] || 0) + 1;

  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(
      `**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`
    )
    .addFields({
      name: "Event GP Gained",
      value: `${lootTotals[ci(killer)].toLocaleString()} coins`,
      inline: true
    })
    .setColor(0xFF0000)               // RED theme
    .setTimestamp();

  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if (channel?.isTextBased()) await channel.send({ embeds:[embed] });

  return res?.status(200).send("Loot logged");
}

/* ---------- /logKill ------------------------------------------------ */
app.post("/logKill", async (req, res) => {
  const { killer, victim } = req.body || {};
  if (!killer || !victim) return res.status(400).send("Missing killer/victim");

  if (
    clanOnlyMode &&
    (!registeredNames.has(ci(killer)) || !registeredNames.has(ci(victim)))
  )
    return res.status(200).send("Non-clan kill ignored");

  const dedupKey = `K|${ci(killer)}|${ci(victim)}`;
  if (
    seenRecently.has(dedupKey) &&
    Date.now() - seenRecently.get(dedupKey) < DEDUP_WINDOW_MS
  )
    return res.status(200).send("Duplicate kill suppressed");
  seenRecently.set(dedupKey, Date.now());

  const { deathCounts } = getEventData();
  deathCounts[ci(victim)] = (deathCounts[ci(victim)] || 0) + 1;

  const embed = new EmbedBuilder()
    .setTitle("💀 Kill Logged")
    .setDescription(`**${killer}** killed **${victim}**`)
    .addFields({
      name:"Total Deaths",
      value:String(deathCounts[ci(victim)]),
      inline:true
    })
    .setColor(0xFF0000)
    .setTimestamp();

  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if (channel?.isTextBased()) await channel.send({ embeds:[embed] });

  res.status(200).send("Kill logged");
});

/* ---------- /logLoot (direct RuneLite HTTP) ------------------------- */
app.post("/logLoot", async (req, res) => {
  const { lootMessage } = req.body || {};
  if (!lootMessage) return res.status(400).send("Missing loot message");
  return handleLootLine(lootMessage, res);
});

/* ---------- /dink (RuneLite Dink plugin) --------------------------- */
app.post("/dink", async (req, res) => {
  try {
    const payload = req.body;
    if (
      payload?.type === "CHAT" &&
      payload?.extra?.type === "CLAN_CHAT" &&
      typeof payload.extra.message === "string"
    ) {
      return handleLootLine(payload.extra.message, res);
    }
    // not a loot chat line – ignore silently
    return res.status(204).end();
  } catch (err) {
    console.error("Error in /dink:", err);
    return res.status(500).send("Handler error");
  }
});

/* ── start express ─────────────────────────────────────────────────── */
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  app.listen(3000, () => console.log("HTTP listening on port 3000"));
});

/* ───────────────── Discord text commands ─────────────────────────── */
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const { deathCounts, lootTotals } = getEventData();
  const lower = message.content.toLowerCase();

  /* ---------- !hiscores -------------------------------------------- */
  if (lower === "!hiscores") {
    const board = Object.entries(chatKillCounts).map(([n,k])=>{
      const d = deathCounts[n] || 0;
      const ratio = d === 0 ? k : (k/d).toFixed(2);
      return { n, k, d, ratio };
    }).sort((a,b)=>b.k-a.k).slice(0,10);

    const embed = new EmbedBuilder()
      .setTitle("🏆 Monday Madness Hiscores 🏆")
      .setColor(0xFF0000)
      .setTimestamp();

    if (board.length === 0) {
      embed.setDescription("No kills recorded yet.");
    } else {
      board.forEach((e,i)=>embed.addFields({
        name:`${i+1}. ${e.n}`,
        value:`Kills: ${e.k} | Deaths: ${e.d} | K/D: ${e.ratio}`,
        inline:false
      }));
    }
    return message.channel.send({ embeds:[embed] });
  }

  /* ---------- !lootboard ------------------------------------------- */
  if (lower === "!lootboard") {
    const sorted = Object.entries(lootTotals)
      .sort((a,b)=>b[1]-a[1])
      .slice(0,10);

    const embed = new EmbedBuilder()
      .setTitle("💰 Top Loot Earners 💰")
      .setColor(0xFF0000)
      .setTimestamp();

    if (sorted
