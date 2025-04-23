/*  ────────────────────────────────────────────────────────────────────
    Monday-Madness Discord bot – de-duping + RuneLite-Dink support
    ──────────────────────────────────────────────────────────────────── */

const express    = require("express");
const bodyParser = require("body-parser");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events
} = require("discord.js");
const fs         = require("fs");
const path       = require("path");
const simpleGit  = require("simple-git");
require("dotenv").config();

/* ── env ───────────────────────────────────────────────────────────── */
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT   = process.env.GITHUB_PAT;          // optional
const REPO         = "craigmuzza/monday-madness-bot";
const BRANCH       = "main";
const COMMIT_MSG   = "auto: sync data";

/* ── constants ─────────────────────────────────────────────────────── */
const DEDUP_WINDOW_MS = 10_000;   // 10-second anti-spam window

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

/* ── bot state ─────────────────────────────────────────────────────── */
let currentEvent = "default";
let clanOnlyMode = false;

let registeredNames = new Set();         // lower-case
let chatKillCounts  = {};                // kills deducted from loot lines

const events = {
  default: { deathCounts:{}, lootTotals:{}, gpTotal:{} }
};

/* ── de-duplication cache ──────────────────────────────────────────── */
const seenRecently = new Map();          // key → lastTimestamp(ms)
setInterval(() => {
  const now = Date.now();
  for (const [k,t] of seenRecently)
    if (now - t > DEDUP_WINDOW_MS) seenRecently.delete(k);
}, 30_000);

/* ── helpers ───────────────────────────────────────────────────────── */
const ci = (s="") => s.toLowerCase().trim();

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
  if (!GITHUB_PAT) return;
  const git = simpleGit();
  await git.add(".");
  await git.commit(COMMIT_MSG);
  await git.push(
    `https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`,
    BRANCH
  );
}

/* ── load registered names from disk ───────────────────────────────── */
try {
  const arr = JSON.parse(
    fs.readFileSync(path.join(__dirname,"data/registered.json"))
  );
  if (Array.isArray(arr)) arr.forEach(n => registeredNames.add(ci(n)));
  console.log(`Loaded ${registeredNames.size} registered clan names`);
} catch {/* first run – ignore */}

/* ───────────────── HTTP ROUTES ────────────────────────────────────── */

/* shared loot-line handler */
async function handleLootLine(raw, res) {
  const lootRe =
    /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\(([\d,]+)\s+coins\).*/i;
  const m = raw.match(lootRe);
  if (!m) return res?.status(400).send("Invalid loot format");

  const [, killer, victim, gpStr] = m;

  if (
    clanOnlyMode &&
    (!registeredNames.has(ci(killer)) || !registeredNames.has(ci(victim)))
  )
    return res?.status(200).send("Non-clan loot ignored");

  const dupKey = `L|${raw.trim()}`;
  if (seenRecently.has(dupKey) && Date.now() - seenRecently.get(dupKey) < DEDUP_WINDOW_MS)
    return res?.status(200).send("Duplicate loot suppressed");
  seenRecently.set(dupKey, Date.now());

  const gp = Number(gpStr.replace(/,/g,""));
  const { lootTotals, gpTotal } = getEventData();
  lootTotals[ci(killer)] = (lootTotals[ci(killer)] || 0) + gp;
  gpTotal  [ci(killer)] = (gpTotal  [ci(killer)] || 0) + gp;
  chatKillCounts[ci(killer)] = (chatKillCounts[ci(killer)] || 0) + 1;

  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({
      name:"Event GP Gained",
      value:`${lootTotals[ci(killer)].toLocaleString()} coins`,
      inline:true
    })
    .setColor(0xFF0000)
    .setTimestamp();

  try {
    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (ch?.isTextBased()) await ch.send({ embeds:[embed] });
  } catch (e) { console.error("Discord send error:", e); }

  return res?.status(200).send("Loot logged");
}

/* /logKill ----------------------------------------------------------- */
app.post("/logKill", async (req,res)=>{
  const { killer, victim } = req.body || {};
  if (!killer || !victim) return res.status(400).send("Missing data");

  if (
    clanOnlyMode &&
    (!registeredNames.has(ci(killer)) || !registeredNames.has(ci(victim)))
  )
    return res.status(200).send("Non-clan kill ignored");

  const dupKey = `K|${ci(killer)}|${ci(victim)}`;
  if (seenRecently.has(dupKey) && Date.now() - seenRecently.get(dupKey) < DEDUP_WINDOW_MS)
    return res.status(200).send("Duplicate kill suppressed");
  seenRecently.set(dupKey, Date.now());

  const { deathCounts } = getEventData();
  deathCounts[ci(victim)] = (deathCounts[ci(victim)] || 0) + 1;

  const embed = new EmbedBuilder()
    .setTitle("💀 Kill Logged")
    .setDescription(`**${killer}** killed **${victim}**`)
    .addFields({ name:"Total Deaths", value:String(deathCounts[ci(victim)]), inline:true })
    .setColor(0xFF0000)
    .setTimestamp();

  try {
    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (ch?.isTextBased()) await ch.send({ embeds:[embed] });
  } catch (e) { console.error("Discord send error:", e); }

  res.status(200).send("Kill logged");
});

/* /logLoot (direct RuneLite HTTP) ----------------------------------- */
app.post("/logLoot", (req,res)=>{
  const { lootMessage } = req.body || {};
  if (!lootMessage) return res.status(400).send("Missing loot message");
  return handleLootLine(lootMessage, res);
});

/* /dink (RuneLite Dink plugin webhook) ------------------------------ */
app.post("/dink", (req,res)=>{
  const p = req.body;
  if (
    p?.type === "CHAT" &&
    p?.extra?.type === "CLAN_CHAT" &&
    typeof p.extra.message === "string"
  ) {
    return handleLootLine(p.extra.message, res);
  }
  return res.status(204).end();          // ignore non-loot messages
});

/* ── boot express after Discord ready ─────────────────────────────── */
client.once("ready", ()=>{
  console.log(`Logged in as ${client.user.tag}`);
  app.listen(3000, ()=>console.log("HTTP listening on 3000"));
});

/* ── Discord commands ─────────────────────────────────────────────── */
client.on(Events.MessageCreate, async msg=>{
  if (msg.author.bot) return;
  const text = msg.content.toLowerCase();
  const { deathCounts, lootTotals } = getEventData();

  /* !hiscores */
  if (text === "!hiscores") {
    const board = Object.entries(chatKillCounts).map(([n,k])=>{
      const d = deathCounts[n] || 0;
      const ratio = d===0 ? k : (k/d).toFixed(2);
      return { n,k,d,ratio };
    }).sort((a,b)=>b.k-a.k).slice(0,10);

    const embed = new EmbedBuilder()
      .setTitle("🏆 Monday Madness Hiscores 🏆")
      .setColor(0xFF0000)
      .setTimestamp();

    if (board.length===0) embed.setDescription("No kills recorded yet.");
    else board.forEach((e,i)=>embed.addFields({
      name:`${i+1}. ${e.n}`,
      value:`Kills: ${e.k} | Deaths: ${e.d} | K/D: ${e.ratio}`,
      inline:false
    }));

    return msg.channel.send({ embeds:[embed] });
  }

  /* !lootboard */
  if (text === "!lootboard") {
    const sorted = Object.entries(lootTotals).sort((a,b)=>b[1]-a[1]).slice(0,10);
    const embed = new EmbedBuilder()
      .setTitle("💰 Top Loot Earners 💰")
      .setColor(0xFF0000)
      .setTimestamp();

    if (sorted.length===0) embed.setDescription("No loot recorded yet.");
    else sorted.forEach(([n,gp],i)=>embed.addFields({
      name:`${i+1}. ${n}`,
      value:`${gp.toLocaleString()} coins`,
      inline:false
    }));

    return msg.channel.send({ embeds:[embed] });
  }

  /* !listEvents */
  if (text === "!listevents") {
    const embed = new EmbedBuilder()
      .setTitle("📅 Available Events")
      .setDescription(
        Object.keys(events)
          .map(e=>`• ${e}${e===currentEvent?" *(current)*":""}`)
          .join("\n")
      )
      .setColor(0xFF0000)
      .setTimestamp();
    return msg.channel.send({ embeds:[embed] });
  }

  /* !createEvent <name> */
  if (text.startsWith("!createevent ")) {
    const name = msg.content.slice(13).trim();
    if (!name || events[name]) return msg.reply("Invalid or duplicate name.");
    events[name]={ deathCounts:{}, lootTotals:{}, gpTotal:{} };
    currentEvent=name;
    return msg.reply(`Event **${name}** created and selected.`);
  }

  /* !finishEvent */
  if (text === "!finishevent") {
    const file = `events/event_${currentEvent}_${new Date().toISOString().replace(/[:.]/g,"-")}.json`;
    saveJSON(file, events[currentEvent]);
    await commitToGitHub();
    delete events[currentEvent];
    currentEvent="default";

    const embed = new EmbedBuilder()
      .setTitle("📦 Event Finalised")
      .setDescription(`Saved as \`${file}\` and switched back to **default**.`)
      .setColor(0xFF0000)
      .setTimestamp();
    return msg.channel.send({ embeds:[embed] });
  }

  /* !register a,b,c */
  if (text.startsWith("!register ")) {
    const names = msg.content.slice(10).split(",").map(ci);
    names.forEach(n=>registeredNames.add(n));
    saveJSON("data/registered.json", Array.from(registeredNames));
    await commitToGitHub();
    return msg.reply(`Registered: ${names.join(", ")}`);
  }

  /* !unregister a,b,c */
  if (text.startsWith("!unregister ")) {
    const names = msg.content.slice(12).split(",").map(ci);
    names.forEach(n=>registeredNames.delete(n));
    saveJSON("data/registered.json", Array.from(registeredNames));
    await commitToGitHub();
    return msg.reply(`Unregistered: ${names.join(", ")}`);
  }

  /* !clanOnly on/off */
  if (text === "!clanonly on")  { clanOnlyMode=true;  return msg.reply("Clan-only mode **enabled**."); }
  if (text === "!clanonly off") { clanOnlyMode=false; return msg.reply("Clan-only mode **disabled**."); }

  /* !help */
  if (text === "!help") {
    const embed = new EmbedBuilder()
      .setTitle("🛠 Monday Madness Bot – Help")
      .addFields(
        { name:"📊 Stats",  value:"`!hiscores`, `!lootboard`", inline:false },
        { name:"🎯 Events", value:"`!createEvent <name>`, `!finishEvent`, `!listEvents`", inline:false },
        { name:"👥 Clan",   value:"`!register <names>`, `!unregister <names>`, `!clanOnly on/off`", inline:false },
        { name:"❓ Help",   value:"`!help`", inline:false }
      )
      .setColor(0xFF0000)
      .setTimestamp();
    return msg.channel.send({ embeds:[embed] });
  }
});

/* ───────────────────────── start bot ─────────────────────────────── */
client.login(DISCORD_BOT_TOKEN);
}