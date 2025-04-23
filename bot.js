/*  ────────────────────────────────────────────────────────────────────
    Monday-Madness Discord bot  –  JSON-safe version
    ──────────────────────────────────────────────────────────────────── */

const express = require("express");
const {
  Client, GatewayIntentBits, EmbedBuilder, Events
} = require("discord.js");
const fs        = require("fs");
const path      = require("path");
const simpleGit = require("simple-git");
require("dotenv").config();

/* ── env ───────────────────────────────────────────────────────────── */
const {
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  GITHUB_PAT
} = process.env;

const REPO       = "craigmuzza/monday-madness-bot";
const BRANCH     = "main";
const COMMIT_MSG = "auto: sync data";

/* ── constants ─────────────────────────────────────────────────────── */
const DEDUP_MS = 10_000;                 // 10 s anti-spam window

/* ── express ───────────────────────────────────────────────────────── */
const app = express();

/* Put the JSON parser **first** so every POST is parsed correctly */
app.use(express.json({ limit: "1mb" })); // <-- FIX

/* Ping endpoint so you can curl GET /ping to confirm build */
app.get("/ping", (_,res)=>res.send("pong"));

/* ── discord client ────────────────────────────────────────────────── */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/* ── bot state ─────────────────────────────────────────────────────── */
let currentEvent   = "default";
let clanOnlyMode   = false;
let registered     = new Set();              // case-insensitive names
let chatKillCounts = {};                     // kills per player
const events = { default: { deaths:{}, loot:{}, gp:{} } };

/* de-duplication cache */
const seen = new Map();
setInterval(()=>{ const n=Date.now();
  for (const [k,t] of seen) if (n-t>DEDUP_MS) seen.delete(k);
}, 30_000);

/* helpers ------------------------------------------------------------ */
const ci = s => s.toLowerCase().trim();
const jsonFile = (p,d)=>{
  fs.mkdirSync(path.dirname(p),{recursive:true});
  fs.writeFileSync(p,JSON.stringify(d,null,2));
};
async function gitSync(){
  if(!GITHUB_PAT) return;
  const git=simpleGit();
  await git.add(".");
  await git.commit(COMMIT_MSG);
  await git.push(`https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`,BRANCH);
}

/* load registered list once */
try{
  const arr=JSON.parse(fs.readFileSync("./data/registered.json"));
  if(Array.isArray(arr)) arr.forEach(n=>registered.add(ci(n)));
}catch{}

/* ───────────────── HTTP ROUTES ────────────────────────────────────── */

function lootEmbed(killer,victim,gp,eventGp){
  return new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({name:"Event GP Gained",value:`${eventGp.toLocaleString()} coins`,inline:true})
    .setColor(0xFF0000)
    .setTimestamp();
}
function killEmbed(killer,victim,totalDeaths){
  return new EmbedBuilder()
    .setTitle("💀 Kill Logged")
    .setDescription(`**${killer}** killed **${victim}**`)
    .addFields({name:"Total Deaths",value:String(totalDeaths),inline:true})
    .setColor(0xFF0000)
    .setTimestamp();
}

function handleLoot(raw){
  const m=/^(.+?) has defeated (.+?) and received \(([\d,]+) coins\)/i.exec(raw);
  if(!m) return null;
  const [,killer,victim,gpStr]=m; const gp=Number(gpStr.replace(/,/g,""));
  return {killer,victim,gp};
}

/* POST /logKill ------------------------------------------------------ */
app.post("/logKill", async (req,res)=>{
  try{
    const {killer,victim}=req.body||{};
    if(!killer||!victim) return res.status(400).send("bad json");

    if(clanOnlyMode && (!registered.has(ci(killer))||!registered.has(ci(victim))))
      return res.sendStatus(204);

    const k=`K|${ci(killer)}|${ci(victim)}`;
    if(seen.has(k)&&Date.now()-seen.get(k)<DEDUP_MS) return res.sendStatus(204);
    seen.set(k,Date.now());

    const ev=events[currentEvent]||={deaths:{},loot:{},gp:{}};
    ev.deaths[ci(victim)]=(ev.deaths[ci(victim)]||0)+1;

    const ch=await client.channels.fetch(DISCORD_CHANNEL_ID).catch(()=>null);
    if(ch?.isTextBased()) await ch.send({embeds:[killEmbed(killer,victim,ev.deaths[ci(victim)])]});
    res.sendStatus(200);
  }catch(e){console.error(e);res.sendStatus(500);}
});

/* POST /logLoot (direct from plugin) -------------------------------- */
app.post("/logLoot", async(req,res)=>{
  try{
    if(!req.body?.lootMessage) return res.status(400).send("missing");
    const info=handleLoot(req.body.lootMessage); if(!info) return res.status(400).send("format");
    await processLoot(info,res);
  }catch(e){console.error(e);res.sendStatus(500);}
});

/* POST /dink (RuneLite Dink webhook) -------------------------------- */
app.post("/dink", async(req,res)=>{
  try{
    const p=req.body;
    if(p.type!=="CHAT"||p?.extra?.type!=="CLAN_CHAT") return res.sendStatus(204);
    const info=handleLoot(p.extra.message); if(!info) return res.sendStatus(204);
    await processLoot(info,res);
  }catch(e){console.error(e);res.sendStatus(500);}
});

/* shared loot processor --------------------------------------------- */
async function processLoot({killer,victim,gp},res){
  if(clanOnlyMode && (!registered.has(ci(killer))||!registered.has(ci(victim))))
    return res.sendStatus(204);

  const k=`L|${killer}|${victim}|${gp}`;
  if(seen.has(k)&&Date.now()-seen.get(k)<DEDUP_MS) return res.sendStatus(204);
  seen.set(k,Date.now());

  const ev=events[currentEvent]; ev.loot[ci(killer)]=(ev.loot[ci(killer)]||0)+gp;
  ev.gp[ci(killer)]  =(ev.gp  [ci(killer)]||0)+gp;
  chatKillCounts[ci(killer)]=(chatKillCounts[ci(killer)]||0)+1;

  const ch=await client.channels.fetch(DISCORD_CHANNEL_ID).catch(()=>null);
  if(ch?.isTextBased())
    await ch.send({embeds:[lootEmbed(killer,victim,gp,ev.loot[ci(killer)])]});
  res.sendStatus(200);
}

/* ───────────────── Discord command handlers (unchanged) ──────────── */
/* … KEEP YOUR EXISTING !hiscores, !lootboard, !createEvent, etc. …    */

/* ───────────────── launch ────────────────────────────────────────── */
client.once("ready",()=>{
  console.log(`Discord bot ready as ${client.user.tag}`);
  app.listen(3000,()=>console.log("HTTP up on 3000"));
});
client.login(DISCORD_BOT_TOKEN);
