/**************************************************************************
 * Monday-Madness Discord bot – Dink-ready (multipart) + legacy endpoints
 * CommonJS edition (no ESM warnings, no router errors)
 **************************************************************************/

const express      = require("express");
const formidableMw = require("express-formidable");   // ★
const {
  Client, GatewayIntentBits, EmbedBuilder, Events
} = require("discord.js");
const fs           = require("fs");
const path         = require("path");
const simpleGit    = require("simple-git");
require("dotenv").config();

/* ─── env & constants ────────────────────────────────────────────── */

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  GITHUB_PAT = "",
  PORT = process.env.PORT || 10000          // Render provides PORT
} = process.env;

const REPO        = "craigmuzza/monday-madness-bot";
const BRANCH      = "main";
const COMMIT_MSG  = "auto: data sync";
const WINDOW_MS   = 10_000;                 // de-dup window
const LOOT_RE     = /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\(([\d,]+)\s+coins\).*/i;

/* ─── state ──────────────────────────────────────────────────────── */

let currentEvent = "default";
let clanOnly     = false;

const registered = new Set();               // lower-case clan names
const seen       = new Map();               // dedup key → timestamp
const events     = { default:{ death:{}, loot:{}, gp:{}, kills:{} } };

const ci  = s => s.toLowerCase().trim();
const now = () => Date.now();

function bucket() {
  if (!events[currentEvent])
    events[currentEvent] = { death:{}, loot:{}, gp:{}, kills:{} };
  return events[currentEvent];
}

/* ─── persist helpers ────────────────────────────────────────────── */

function save(file, obj) {
  fs.mkdirSync("data", { recursive:true });
  fs.writeFileSync(path.join("data", file), JSON.stringify(obj,null,2));
}

async function commitGit() {
  if (!GITHUB_PAT) return;
  const git = simpleGit();
  await git.add(".");
  await git.commit(COMMIT_MSG);
  await git.push(`https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`, BRANCH);
}

/* ─── load clan list (ignore first run) ──────────────────────────── */

try {
  JSON.parse(fs.readFileSync("data/registered.json"))
       .forEach(n => registered.add(ci(n)));
} catch {}

/* ─── de-dup cleaner ─────────────────────────────────────────────── */

setInterval(() => {
  const t = now();
  for (const [k,v] of seen) if (t - v > WINDOW_MS) seen.delete(k);
}, 30_000);

/* ─── Discord client ─────────────────────────────────────────────── */

const client = new Client({
  intents:[
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/* ─── Express app ───────────────────────────────────────────────── */

const app = express();
app.use(express.json());                 // legacy JSON
app.use(express.text({ type:"text/*" })); // raw text
app.use("/dink", formidableMw());        // ★ multipart at /dink only

/* ─── core loot recorder ────────────────────────────────────────── */

async function recordLoot(killer,victim,gp,key,res){
  if(clanOnly&&(!registered.has(ci(killer))||!registered.has(ci(victim))))
    return res?.status(200).send("clan");

  if(seen.get(key)&&now()-seen.get(key)<WINDOW_MS)
    return res?.status(200).send("dup");
  seen.set(key, now());

  const b=bucket();
  b.loot [ci(killer)]=(b.loot [ci(killer)]||0)+gp;
  b.gp   [ci(killer)]=(b.gp   [ci(killer)]||0)+gp;
  b.kills[ci(killer)]=(b.kills[ci(killer)]||0)+1;

  const embed=new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({name:"Event GP",value:`${b.loot[ci(killer)].toLocaleString()} coins`,inline:true})
    .setColor(0xFF0000).setTimestamp();

  try{
    const ch=await client.channels.fetch(DISCORD_CHANNEL_ID);
    if(ch?.isTextBased()) await ch.send({embeds:[embed]});
  }catch{}

  return res?.status(200).send("ok");
}

function lootFromLine(line,res){
  const m=line.match(LOOT_RE);
  if(!m) return res?.status(204).end();
  recordLoot(m[1],m[2],Number(m[3].replace(/,/g,"")),`L|${line}`,res);
}

/* ─── /dink  (multipart, json, or text) ─────────────────────────── */

app.post("/dink",(req,res)=>{
  /* A) multipart: express-formidable puts field on req.fields */
  if (req.fields?.payload_json){
    try{ return processDink(JSON.parse(req.fields.payload_json),res); }
    catch{ return res.status(400).send("json"); }
  }
  /* B) application/json */
  if (typeof req.body === "object") return processDink(req.body,res);
  /* C) raw text line */
  if (typeof req.body === "string") return lootFromLine(req.body.trim(),res);
  return res.status(204).end();
});

function processDink(p,res){
  if(
    p?.type==="CHAT" &&
    p?.extra?.type==="CLAN_CHAT" &&
    typeof p.extra.message === "string"
  ) return lootFromLine(p.extra.message,res);
  return res.status(204).end();
}

/* ─── legacy endpoints remain (optional) -------------------------- */

app.post("/logLoot",(req,res)=>{
  const line=req.body?.lootMessage;
  if(!line) return res.status(400).send("bad");
  lootFromLine(line,res);
});
app.post("/logKill",(req,res)=>{
  const{killer,victim}=req.body||{};
  if(!killer||!victim) return res.status(400).send("bad");

  if(clanOnly&&(!registered.has(ci(killer))||!registered.has(ci(victim))))
    return res.status(200).send("clan");

  const key=`K|${ci(killer)}|${ci(victim)}`;
  if(seen.get(key)&&now()-seen.get(key)<WINDOW_MS)
    return res.status(200).send("dup");
  seen.set(key, now());

  bucket().death[ci(victim)]=(bucket().death[ci(victim)]||0)+1;

  const embed=new EmbedBuilder()
    .setTitle("💀 Kill Logged")
    .setDescription(`**${killer}** killed **${victim}**`)
    .addFields({name:"Total Deaths",value:String(bucket().death[ci(victim)]),inline:true})
    .setColor(0xFF0000).setTimestamp();

  client.channels.fetch(DISCORD_CHANNEL_ID).then(c=>{
    if(c?.isTextBased()) c.send({embeds:[embed]});
  }).catch(()=>{});

  res.status(200).send("ok");
});

/* ─── Discord commands (unchanged) -------------------------------- */
/* add your !hiscores, !lootboard, !register, etc. exactly as before */

/* ─── start ─────────────────────────────────────────────────────── */

client.once("ready",()=>{
  console.log("[discord] ready:", client.user.tag);
  app.listen(PORT,()=>console.log("[http] listening on",PORT));
});
client.login(DISCORD_BOT_TOKEN);
