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
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN!;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID!;
const GITHUB_PAT         = process.env.GITHUB_PAT;  // leave undefined to disable
const REPO               = "craigmuzza/monday-madness-bot";
const BRANCH             = "main";
const COMMIT_MSG         = "auto: sync data";

// ── constants ───────────────────────────────────────────────────────
const DEDUP_MS = 10_000;   // 10s
const LOOT_RE  = /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\( *([\d,]+) *coins\).*/i;

// ── express + multer ─────────────────────────────────────────────────
const app    = express();
const upload = multer();    // for multipart/form-data

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
const registered = new Set<string>();  // lower-case names
const seen       = new Map<string,number>();  // dedup map
const events     = { default: { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} } };

const ci  = (s:string) => s.toLowerCase().trim();
const now = () => Date.now();

// ── load persisted registrations ───────────────────────────────────
try {
  const arr = JSON.parse(
    fs.readFileSync(path.join(__dirname, "data/registered.json"), "utf-8")
  );
  if (Array.isArray(arr)) arr.forEach(n => registered.add(ci(n)));
  console.log(`[init] loaded ${registered.size} registered names`);
} catch {
  console.log("[init] no registered.json yet");
}

// ── GitHub commit helper (never crash) ─────────────────────────────
async function commitToGitHub() {
  if (!GITHUB_PAT) return;
  try {
    const git = simpleGit();
    await git.add(".");
    await git.commit(COMMIT_MSG);
    // force username=repo owner
    await git.push(
      `https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`,
      BRANCH
    );
  } catch (err) {
    console.error("[git] commit/push failed:", err.message||err);
  }
}

// ── get or init current event data ─────────────────────────────────
function getEventData() {
  if (!events[currentEvent]) {
    events[currentEvent] = { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} };
  }
  return events[currentEvent];
}

// ── core loot processor ─────────────────────────────────────────────
async function processLoot(killer:string, victim:string, gp:number, dedupKey:string, res:any) {
  if (clanOnlyMode && (!registered.has(ci(killer)) || !registered.has(ci(victim)))) {
    return res.status(200).send("non-clan ignored");
  }
  if (seen.has(dedupKey) && now() - seen.get(dedupKey)! < DEDUP_MS) {
    return res.status(200).send("duplicate");
  }
  seen.set(dedupKey, now());

  const { lootTotals, gpTotal, kills } = getEventData();
  lootTotals[ci(killer)] = (lootTotals[ci(killer)]||0) + gp;
  gpTotal  [ci(killer)] = (gpTotal  [ci(killer)]||0) + gp;
  kills    [ci(killer)] = (kills    [ci(killer)]||0) + 1;

  const label = currentEvent === "default" ? "Total GP Earned" : "Event GP Gained";
  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({
      name: label,
      value: `${(currentEvent==="default" ? gpTotal[ci(killer)] : lootTotals[ci(killer)]).toLocaleString()} coins`,
      inline: true
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

// ── /logKill ────────────────────────────────────────────────────────
app.post("/logKill", async (req, res) => {
  const { killer, victim } = req.body||{};
  if (!killer||!victim) return res.status(400).send("bad data");
  if (clanOnlyMode && (!registered.has(ci(killer))||!registered.has(ci(victim)))) {
    return res.status(200).send("non-clan ignored");
  }
  const dup = `K|${ci(killer)}|${ci(victim)}`;
  if (seen.has(dup) && now()-seen.get(dup)!<DEDUP_MS) {
    return res.status(200).send("duplicate");
  }
  seen.set(dup, now());

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

// ── /dink (multipart/form-data) ───────────────────────────────────
app.post("/dink",
  upload.fields([
    { name:"payload_json", maxCount:1 },
    { name:"file",         maxCount:1 } // optional screenshot
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
      console.error("[dink] JSON parse error:", e);
      return res.status(400).send("bad JSON");
    }

    // who saw it + the line
    const rsn = data.playerName;
    const msg = data.extra?.message;
    if (typeof msg === "string") {
      console.log(`[dink] seen by=${rsn} | message=${msg}`);
    }

    if (
      data.type === "CHAT" &&
      (data.extra?.type==="CLAN_CHAT"||data.extra?.type==="CLAN_MESSAGE") &&
      typeof msg === "string"
    ) {
      const m = msg.match(LOOT_RE);
      if (m) {
        return processLoot(m[1], m[2], Number(m[3].replace(/,/g,"")), msg.trim(), res);
      }
    }
    return res.status(204).end();
  }
);

// ── start server after Discord ready ────────────────────────────────
client.once("ready", ()=>{
  console.log(`[discord] ready: ${client.user.tag}`);
  const port = process.env.PORT||3000;
  app.listen(port, ()=>console.log(`[http] listening on ${port}`));
});

// ── Discord commands ────────────────────────────────────────────────
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  const text = msg.content.trim();
  const lower = text.toLowerCase();
  const { deathCounts, lootTotals, kills } = getEventData();

  // — !hiscores [name]
  if (lower.startsWith("!hiscores")) {
    const parts = text.split(" ").slice(1);
    if (parts.length) {
      const query = ci(parts.join(" "));
      const k = kills[query]||0;
      const d = deathCounts[query]||0;
      if (k||d) {
        const kd = d===0? k : (k/d).toFixed(2);
        return msg.channel.send(`**${parts.join(" ")}** → Kills: ${k} | Deaths: ${d} | K/D: ${kd}`);
      } else {
        return msg.channel.send(`No hiscore data for **${parts.join(" ")}**`);
      }
    }
    // no arg → top 10
    const board = Object.entries(kills)
      .map(([n,k])=>{
        const d=deathCounts[n]||0;
        const ratio = d===0? k : (k/d).toFixed(2);
        return {n,k,d,ratio};
      })
      .sort((a,b)=>b.k-a.k)
      .slice(0,10);
    if (!board.length) return msg.channel.send("No kills yet.");
    const e = new EmbedBuilder()
      .setTitle("🏆 Hiscores")
      .setColor(0xFF0000)
      .setTimestamp();
    board.forEach((v,i)=> e.addFields({
      name:`${i+1}. ${v.n}`,
      value:`Kills ${v.k} | Deaths ${v.d} | K/D ${v.ratio}`
    }));
    return msg.channel.send({ embeds:[e] });
  }

  // — !lootboard [name]
  if (lower.startsWith("!lootboard")) {
    const parts = text.split(" ").slice(1);
    if (parts.length) {
      const query = ci(parts.join(" "));
      const gp = lootTotals[query]||0;
      if (gp) {
        return msg.channel.send(`**${parts.join(" ")}** → ${gp.toLocaleString()} coins`);
      } else {
        return msg.channel.send(`No GP data for **${parts.join(" ")}**`);
      }
    }
    // top 10
    const top = Object.entries(lootTotals)
      .sort((a,b)=>b[1]-a[1])
      .slice(0,10);
    if (!top.length) return msg.channel.send("No loot yet.");
    const e = new EmbedBuilder()
      .setTitle("💰 Top Loot Earners 💰")
      .setColor(0xFF0000)
      .setTimestamp();
    top.forEach(([n,gp],i)=> e.addFields({
      name:`${i+1}. ${n}`,
      value:`${gp.toLocaleString()} coins`
    }));
    return msg.channel.send({ embeds:[e] });
  }

  // — !listclan
  if (lower === "!listclan") {
    return msg.channel.send(
      registered.size
        ? `Registered clan members:\n• ${[...registered].join("\n• ")}`
        : "No clan members registered."
    );
  }

  // — existing !listevents, !createevent, !finishevent, !register, !unregister, !clanonly, !help …
  // (unchanged from previous — include them here as before)
});

client.login(DISCORD_BOT_TOKEN);
