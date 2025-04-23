/*  ────────────────────────────────────────────────────────────────────
    Monday-Madness Discord bot – clan PvP tracker
    * de-duplication
    * RuneLite Dink multipart + JSON support
    * optional /ping health-check
    ──────────────────────────────────────────────────────────────────── */

const express   = require("express");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events
} = require("discord.js");
const formidable = require("formidable");           // ← correct import
const fs         = require("fs");
const path       = require("path");
const simpleGit  = require("simple-git");
require("dotenv").config();

/* ── env ───────────────────────────────────────────────────────────── */
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID= process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT        = process.env.GITHUB_PAT;            // optional
const REPO   = "craigmuzza/monday-madness-bot";
const BRANCH = "main";
const COMMIT = "auto: sync data";

/* ── constants ─────────────────────────────────────────────────────── */
const DEDUP_MS = 10_000;
const LOOT_RE  =
  /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\(([\d,]+)\s+coins\).*/i;

/* ── express ───────────────────────────────────────────────────────── */
const app = express();
app.use(express.json());
app.use(express.text({ type: "text/*" }));          // raw text fallback

/* ── discord client ────────────────────────────────────────────────── */
const client = new Client({
  intents: [ GatewayIntentBits.Guilds,
             GatewayIntentBits.GuildMessages,
             GatewayIntentBits.MessageContent ]
});

/* ── runtime state ─────────────────────────────────────────────────── */
let currentEvent = "default";
let clanOnly     = false;

const registered = new Set();              // lower-case names
const seen       = new Map();              // de-dup key → ts

const events = { default:{ deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} } };

const ci  = s => s.toLowerCase().trim();
const now = () => Date.now();

/* ── load persisted clan list ──────────────────────────────────────── */
try {
  const arr = JSON.parse(fs.readFileSync(path.join(__dirname,"data/registered.json")));
  if (Array.isArray(arr)) arr.forEach(n=>registered.add(ci(n)));
  console.log(`Loaded ${registered.size} registered names`);
} catch {/* ignore first run */}

/* ── helpers ───────────────────────────────────────────────────────── */
function getEvent() {
  if (!events[currentEvent])
    events[currentEvent] = { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} };
  return events[currentEvent];
}

function saveJSON(f,obj){
  const p = path.join(__dirname,f);
  fs.mkdirSync(path.dirname(p),{recursive:true});
  fs.writeFileSync(p,JSON.stringify(obj,null,2));
}

async function gitCommit(){
  if(!GITHUB_PAT) return;
  const git=simpleGit();
  await git.add(".");
  await git.commit(COMMIT);
  await git.push(`https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`,BRANCH);
}

/* purge de-dup every 30 s */
setInterval(()=>{ const t=now(); for(const[k,v] of seen) if(t-v>DEDUP_MS) seen.delete(k); },30_000);

/* ── core loot processor (shared) ──────────────────────────────────── */
async function processLoot(killer,victim,gp,dedupKey,res){
  if (clanOnly && (!registered.has(ci(killer)) || !registered.has(ci(victim))))
    return res?.status(200).send("non-clan");

  if (seen.has(dedupKey) && now()-seen.get(dedupKey)<DEDUP_MS)
    return res?.status(200).send("dup");
  seen.set(dedupKey,now());

  const {lootTotals,gpTotal,kills} = getEvent();
  lootTotals[ci(killer)] = (lootTotals[ci(killer)]||0)+gp;
  gpTotal  [ci(killer)] = (gpTotal  [ci(killer)]||0)+gp;
  kills    [ci(killer)] = (kills    [ci(killer)]||0)+1;

  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({ name:"Event GP Gained", value:`${lootTotals[ci(killer)].toLocaleString()} coins`, inline:true })
    .setColor(0xFF0000)
    .setTimestamp();

  try {
    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (ch?.isTextBased()) await ch.send({ embeds:[embed] });
  } catch(e){ console.error("[Discord] send err:",e); }

  return res?.status(200).send("ok");
}

/* ── routes ────────────────────────────────────────────────────────── */
app.post("/ping",(req,res)=>res.send("pong"));      // health-check

app.post("/logKill",async(req,res)=>{
  const { killer,victim }=req.body||{};
  if(!killer||!victim) return res.status(400).send("bad");

  if(clanOnly && (!registered.has(ci(killer))||!registered.has(ci(victim))))
    return res.status(200).send("non-clan");

  const key=`K|${ci(killer)}|${ci(victim)}`;
  if(seen.has(key)&&now()-seen.get(key)<DEDUP_MS)
    return res.status(200).send("dup");
  seen.set(key,now());

  const {deathCounts}=getEvent();
  deathCounts[ci(victim)]=(deathCounts[ci(victim)]||0)+1;

  const embed=new EmbedBuilder()
    .setTitle("💀 Kill Logged")
    .setDescription(`**${killer}** killed **${victim}**`)
    .addFields({ name:"Total Deaths", value:String(deathCounts[ci(victim)]), inline:true })
    .setColor(0xFF0000).setTimestamp();

  try{
    const ch=await client.channels.fetch(DISCORD_CHANNEL_ID);
    if(ch?.isTextBased()) await ch.send({embeds:[embed]});
  }catch(e){console.error("[Discord] send err:",e);}

  res.status(200).send("ok");
});

app.post("/logLoot",(req,res)=>{
  const txt=req.body?.lootMessage;
  if(!txt) return res.status(400).send("bad");
  const m=txt.match(LOOT_RE);
  if(!m)   return res.status(400).send("fmt");
  processLoot(m[1],m[2],Number(m[3].replace(/,/g,"")),txt,res);
});

/* -------- /dink ----------------------------------------------------- */
app.post("/dink", (req, res) => {
  const ct = req.headers["content-type"] || "";

  /* ── A) multipart/form-data ─────────────── */
  if (ct.startsWith("multipart/form-data")) {
    formidable({ multiples: false }).parse(req, (err, fields) => {
      if (err || !fields.payload) return res.status(400).send("Bad multipart");

      let data;
      try { data = JSON.parse(fields.payload); }
      catch { return res.status(400).send("Invalid JSON payload"); }

      return processDinkJson(data, res);
    });
    return;                                  // ☜ don’t fall through
  }

  /* ── B) application/json *or* text/plain ─ */
  let body = req.body;

  // ❶  If body arrived as a Buffer → make it a string
  if (Buffer.isBuffer(body)) body = body.toString("utf8");

  // ❷  If still a string → try to JSON-parse it
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { /* leave as raw string */ }
  }

  // ❸  JSON object path
  if (typeof body === "object" && body !== null) {
    return processDinkJson(body, res);
  }

  // ❹  raw CC message path
  if (typeof body === "string" && body.trim().length) {
    return handleLootLine(body.trim(), res);
  }

  return res.status(204).end();              // nothing we care about
});

/* helper : JSON payload from Dink */
function handleDinkJson(p,res){
  if(
    p?.type==="CHAT" &&
    p?.extra?.type==="CLAN_CHAT" &&
    typeof p.extra.message==="string"
  ){
    return handleLootLine(p.extra.message,res);
  }
  return res.status(204).end();
}

/* helper : raw CC line */
function handleLootLine(txt,res){
  const m=txt.match(LOOT_RE);
  if(!m) return res.status(204).end();           // not a kill line
  const gp=Number(m[3].replace(/,/g,""));
  return processLoot(m[1],m[2],gp,txt.trim(),res);
}

/* ── start express after Discord ready ─────────────────────────────── */
client.once("ready",()=>{
  console.log(`Logged in as ${client.user.tag}`);
  const port = process.env.PORT || 10000;
  app.listen(port,()=>console.log("HTTP listening on",port));
});

/* ── Discord commands (same as before) ─────────────────────────────── */
/* … keep your existing !hiscores / !lootboard / !register etc …      */

client.login(DISCORD_BOT_TOKEN);
