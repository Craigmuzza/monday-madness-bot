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

// ── __dirname fix for ESM ───────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── env ───────────────────────────────────────────────────
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT         = process.env.GITHUB_PAT;           // optional
const REPO               = "craigmuzza/monday-madness-bot";
const BRANCH             = "main";
const COMMIT_MSG         = "auto: sync data";

// ── constants ─────────────────────────────────────────────
const DEDUP_MS = 10_000;   // 10s
const LOOT_RE  = /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\( *([\d,]+) *coins\).*/i;

// ── express + multer ───────────────────────────────────────
const app    = express();
const upload = multer();
app.use(express.json());
app.use(express.text({ type: "text/*" }));

// ── discord client ────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// ── bot state ──────────────────────────────────────────────
let currentEvent = "default";
let clanOnlyMode = false;
const registered = new Set();    // lower-case clan names
const seen       = new Map();    // dedup cache
const events     = { default: { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} } };

const ci  = s => (s||"").toLowerCase().trim();
const now = () => Date.now();

// ── load persisted registrations ───────────────────────────
try {
  const arr = JSON.parse(fs.readFileSync(path.join(__dirname,"data/registered.json")));
  if (Array.isArray(arr)) arr.forEach(n=>registered.add(ci(n)));
  console.log(`[init] loaded ${registered.size} registered names`);
} catch {
  console.log("[init] no registered.json yet");
}

// ── commit helper ─────────────────────────────────────────
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

// ── get or init event data ────────────────────────────────
function getEventData() {
  if (!events[currentEvent]) {
    events[currentEvent] = { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} };
  }
  return events[currentEvent];
}

// ── core loot processor ───────────────────────────────────
async function processLoot(killer, victim, gp, key, res) {
  if (clanOnlyMode && (!registered.has(ci(killer)) || !registered.has(ci(victim)))) {
    return res.status(200).send("non-clan ignored");
  }
  if (seen.has(key) && now()-seen.get(key)<DEDUP_MS) {
    return res.status(200).send("duplicate");
  }
  seen.set(key, now());

  const { lootTotals, gpTotal, kills } = getEventData();
  lootTotals[ci(killer)] = (lootTotals[ci(killer)]||0)+gp;
  gpTotal  [ci(killer)] = (gpTotal[ci(killer)]||0)+gp;
  kills    [ci(killer)] = (kills[ci(killer)]  ||0)+1;

  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({
      name: "Event GP Gained",
      value:`${lootTotals[ci(killer)].toLocaleString()} coins`,
      inline:true
    })
    .setColor(0xFF0000)
    .setTimestamp();

  const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if (ch?.isTextBased()) {
    await ch.send({ embeds:[embed] });
    console.log("[discord] sent loot embed");
  }
  return res.status(200).send("ok");
}

// ── /logKill ───────────────────────────────────────────────
app.post("/logKill", async (req,res)=>{
  const { killer, victim } = req.body||{};
  if (!killer||!victim) return res.status(400).send("bad data");
  const key=`K|${ci(killer)}|${ci(victim)}`;
  if (seen.has(key)&&now()-seen.get(key)<DEDUP_MS) return res.status(200).send("duplicate");
  seen.set(key,now());
  const { deathCounts } = getEventData();
  deathCounts[ci(victim)] = (deathCounts[ci(victim)]||0)+1;

  const embed = new EmbedBuilder()
    .setTitle("💀 Kill Logged")
    .setDescription(`**${killer}** killed **${victim}**`)
    .addFields({ name:"Total Deaths", value:String(deathCounts[ci(victim)]), inline:true })
    .setColor(0xFF0000).setTimestamp();
  const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if (ch?.isTextBased()) {
    await ch.send({ embeds:[embed] });
    console.log("[discord] sent kill embed");
  }
  res.status(200).send("ok");
});

// ── /logLoot (legacy) ───────────────────────────────────────
app.post("/logLoot",(req,res)=>{
  const txt=req.body?.lootMessage;
  if (!txt) return res.status(400).send("bad");
  const m=txt.match(LOOT_RE);
  if (!m) return res.status(400).send("fmt");
  return processLoot(m[1],m[2],Number(m[3].replace(/,/g,"")),txt.trim(),res);
});

// ── /dink multipart/form-data ──────────────────────────────
app.post(
  "/dink",
  upload.fields([{ name:"payload_json", maxCount:1 }]),
  async (req,res) => {
    let raw = req.body.payload_json;
    if (Array.isArray(raw)) raw = raw[0];
    if (!raw) {
      console.error("[dink] no payload_json");
      return res.status(400).send("no payload_json");
    }

    let data;
    try { data = JSON.parse(raw); }
    catch(e){
      console.error("[dink] bad JSON", e);
      return res.status(400).send("bad JSON");
    }

    // log only the clan chat text
    const msg = data.extra?.message;
    if (typeof msg==="string") console.log("[dink] clan chat message:", msg);

    if (
      data.type==="CHAT" &&
      (data.extra?.type==="CLAN_CHAT"||data.extra?.type==="CLAN_MESSAGE") &&
      typeof msg==="string"
    ) {
      const m = msg.match(LOOT_RE);
      if (m) {
        return processLoot(m[1],m[2],Number(m[3].replace(/,/g,"")),msg.trim(),res);
      }
    }

    return res.status(204).end();
  }
);

// ── start server after Discord ready ────────────────────────────
client.once("ready",()=>{
  console.log(`[discord] ready: ${client.user.tag}`);
  const port = process.env.PORT||3000;
  app.listen(port,()=>console.log(`[http] listening on ${port}`));
});

// ── Discord commands ───────────────────────────────────────────
client.on(Events.MessageCreate, async msg=>{
  if (msg.author.bot) return;
  const text = msg.content.toLowerCase();
  const { deathCounts, lootTotals, kills } = getEventData();

  if (text === "!hiscores") {
    const board = Object.entries(kills)
      .map(([n,k]) => {
        const d = deathCounts[n]||0;
        return { n, k, d, ratio: d? (k/d).toFixed(2) : k };
      })
      .sort((a,b)=>b.k-a.k).slice(0,10);
    const e = new EmbedBuilder()
      .setTitle("🏆 Hiscores 🏆")
      .setColor(0xFF0000).setTimestamp();
    if (!board.length) e.setDescription("No kills recorded yet.");
    else board.forEach((v,i)=>e.addFields({
      name:`${i+1}. ${v.n}`,
      value:`Kills: ${v.k} | Deaths: ${v.d} | K/D: ${v.ratio}`,
      inline:false
    }));
    return msg.channel.send({ embeds:[e] });
  }

  if (text === "!lootboard") {
    const sorted = Object.entries(lootTotals)
      .sort((a,b)=>b[1]-a[1]).slice(0,10);
    const e = new EmbedBuilder()
      .setTitle("💰 Top Loot Earners 💰")
      .setColor(0xFF0000).setTimestamp();
    if (!sorted.length) e.setDescription("No loot recorded yet.");
    else sorted.forEach(([n,gp],i)=>e.addFields({
      name:`${i+1}. ${n}`,
      value:`${gp.toLocaleString()} coins`,
      inline:false
    }));
    return msg.channel.send({ embeds:[e] });
  }

  if (text === "!listevents") {
    const e = new EmbedBuilder()
      .setTitle("📅 Events")
      .setDescription(Object.keys(events)
        .map(ev=>`• ${ev}${ev===currentEvent?" (current)":""}`)
        .join("\n"))
      .setColor(0xFF0000).setTimestamp();
    return msg.channel.send({ embeds:[e] });
  }

  if (text.startsWith("!createevent ")) {
    const name = msg.content.slice(13).trim();
    if (!name||events[name]) return msg.reply("Invalid or duplicate.");
    events[name] = { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} };
    currentEvent = name;
    return msg.reply(`Event **${name}** created & selected.`);
  }

  if (text === "!finishevent") {
    const file = `events/event_${currentEvent}_${new Date()
      .toISOString().replace(/[:.]/g,"-")}.json`;
    fs.mkdirSync("events",{ recursive:true });
    fs.writeFileSync(file,JSON.stringify(getEventData(),null,2));
    await commitToGitHub();
    delete events[currentEvent];
    currentEvent="default";
    return msg.channel.send(`Event saved as \`${file}\` and reset.`);
  }

  if (text.startsWith("!register ")) {
    const names = msg.content.slice(10).split(",").map(ci).filter(Boolean);
    names.forEach(n=>registered.add(n));
    fs.writeFileSync(
      path.join(__dirname,"data/registered.json"),
      JSON.stringify([...registered],null,2)
    );
    await commitToGitHub();
    return msg.reply(`Registered: ${names.join(", ")}`);
  }

  if (text.startsWith("!unregister ")) {
    const names = msg.content.slice(12).split(",").map(ci).filter(Boolean);
    names.forEach(n=>registered.delete(n));
    fs.writeFileSync(
      path.join(__dirname,"data/registered.json"),
      JSON.stringify([...registered],null,2)
    );
    await commitToGitHub();
    return msg.reply(`Unregistered: ${names.join(", ")}`);
  }

  if (text === "!clanonly on")  { clanOnlyMode=true;  return msg.reply("Clan‐only ON"); }
  if (text === "!clanonly off") { clanOnlyMode=false; return msg.reply("Clan‐only OFF"); }

  if (text === "!help") {
    const e = new EmbedBuilder()
      .setTitle("🛠 Help")
      .addFields(
        { name:"Stats", value:"`!hiscores`, `!lootboard`", inline:false },
        { name:"Events",value:"`!createevent <n>`, `!finishevent`, `!listevents`", inline:false },
        { name:"Clan",  value:"`!register`, `!unregister`, `!clanonly on/off`", inline:false },
        { name:"Help",  value:"`!help`", inline:false }
      )
      .setColor(0xFF0000).setTimestamp();
    return msg.channel.send({ embeds:[e] });
  }
});

client.login(DISCORD_BOT_TOKEN);
