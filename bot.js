/*  ────────────────────────────────────────────────────────────────────
    Monday-Madness Discord bot – de-dupe + RuneLite-Dink support
    ──────────────────────────────────────────────────────────────────── */

import express              from "express";
import formidablePkg        from "formidable";              // ES-module import
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events
}                           from "discord.js";
import fs                   from "fs";
import path                 from "path";
import simpleGit            from "simple-git";
import dotenv               from "dotenv";
dotenv.config();

/* ── env ───────────────────────────────────────────────────────────── */
const DISCORD_BOT_TOKEN   = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID  = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT          = process.env.GITHUB_PAT;         // optional
const REPO                = "craigmuzza/monday-madness-bot";
const BRANCH              = "main";
const COMMIT_MSG          = "auto: sync data";

/* ── constants ─────────────────────────────────────────────────────── */
const DEDUP_MS = 10_000;   // anti-spam window
const LOOT_RE  = /.+? has defeated .+? and received .*?(\d[\d,]*) coins.*/i; // relaxed

/* ── express ───────────────────────────────────────────────────────── */
const app = express();
app.use(express.json());
app.use(express.text({ type:"text/*" }));          // plain-text fallback

/* ── Discord client ───────────────────────────────────────────────── */
const client = new Client({
  intents:[
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/* ── runtime state ─────────────────────────────────────────────────── */
let currentEvent = "default";
let clanOnly     = false;
const registered = new Set();    // lower-case clan names
const seen       = new Map();    // de-dup key → timestamp

const events = {
  default:{ deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} }
};

const ci  = s=>s.toLowerCase().trim();
const now = ()=>Date.now();

/* ── load persisted clan list ─────────────────────────────────────── */
try{
  const arr = JSON.parse(fs.readFileSync(path.join(process.cwd(),"data/registered.json")));
  if(Array.isArray(arr)) arr.forEach(n=>registered.add(ci(n)));
  console.log("[init] loaded", registered.size, "registered names");
}catch{/* first run */}

/* ── helpers ───────────────────────────────────────────────────────── */
function getEvent(){
  if(!events[currentEvent]) events[currentEvent] = {
    deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{}
  };
  return events[currentEvent];
}

function saveJSON(file,obj){
  const p = path.join(process.cwd(),file);
  fs.mkdirSync(path.dirname(p),{recursive:true});
  fs.writeFileSync(p,JSON.stringify(obj,null,2));
}

async function gitCommit(){
  if(!GITHUB_PAT) return;
  const git = simpleGit();
  await git.add(".");
  await git.commit(COMMIT_MSG);
  await git.push(`https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`,BRANCH);
}

/* de-dup purge */
setInterval(()=>{ const t=now(); for(const[k,v] of seen) if(t-v>DEDUP_MS) seen.delete(k); },30_000);

/* ── core loot processing ─────────────────────────────────────────── */
async function processLoot(killer,victim,gp,line,res){
  if(clanOnly && (!registered.has(ci(killer)) || !registered.has(ci(victim))))
    return res?.status(200).send("non-clan");

  const key=`L|${line}`;
  if(seen.has(key) && now()-seen.get(key)<DEDUP_MS)
    return res?.status(200).send("dup");
  seen.set(key,now());

  const {lootTotals,gpTotal,kills} = getEvent();
  lootTotals[ci(killer)] = (lootTotals[ci(killer)]||0) + gp;
  gpTotal  [ci(killer)] = (gpTotal  [ci(killer)]||0) + gp;
  kills    [ci(killer)] = (kills    [ci(killer)]||0) + 1;

  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({ name:"Event GP Gained", value:`${lootTotals[ci(killer)].toLocaleString()} coins`, inline:true })
    .setColor(0xFF0000)
    .setTimestamp();

  const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if(ch?.isTextBased()) await ch.send({embeds:[embed]});

  return res?.status(200).send("ok");
}

/* ── /logKill -------------------------------------------------------- */
app.post("/logKill",async(req,res)=>{
  const { killer,victim } = req.body || {};
  if(!killer || !victim) return res.status(400).send("bad");

  if(clanOnly && (!registered.has(ci(killer)) || !registered.has(ci(victim))))
    return res.status(200).send("non-clan");

  const key=`K|${ci(killer)}|${ci(victim)}`;
  if(seen.has(key) && now()-seen.get(key) < DEDUP_MS)
    return res.status(200).send("dup");
  seen.set(key,now());

  const { deathCounts } = getEvent();
  deathCounts[ci(victim)] = (deathCounts[ci(victim)]||0) + 1;

  const embed = new EmbedBuilder()
    .setTitle("💀 Kill Logged")
    .setDescription(`**${killer}** killed **${victim}**`)
    .addFields({ name:"Total Deaths", value:String(deathCounts[ci(victim)]), inline:true })
    .setColor(0xFF0000)
    .setTimestamp();

  const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if(ch?.isTextBased()) await ch.send({embeds:[embed]});

  res.status(200).send("ok");
});

/* ── /logLoot (legacy plain JSON) ----------------------------------- */
app.post("/logLoot",(req,res)=>{
  const txt = req.body?.lootMessage;
  if(!txt) return res.status(400).send("bad");
  const m = txt.match(LOOT_RE);
  if(!m)   return res.status(400).send("fmt");
  processLoot(m[1],m[2],Number(m[1]??m[2]??m[3].replace(/,/g,"")),txt,res);
});

/* ── /dink : multipart OR JSON -------------------------------------- */
app.post("/dink",(req,res)=>{
  const ct = req.headers["content-type"] || "";

  /* A) multipart/form-data ------------------------------------------ */
  if(ct.startsWith("multipart/form-data")){
    formidablePkg({ multiples:false }).parse(req,(err,fields)=>{
      if(err || !fields.payload_json) return res.status(400).send("multipart err");
      let data;
      try { data = JSON.parse(fields.payload_json); }
      catch { return res.status(400).send("bad json"); }
      return processDinkJson(data,res);
    });
    return;
  }

  /* B) pure JSON body ------------------------------------------------ */
  if(typeof req.body === "object"){
    return processDinkJson(req.body,res);
  }

  /* C) raw text line ------------------------------------------------- */
  if(typeof req.body === "string"){
    const m=req.body.match(LOOT_RE);
    if(m) return processLoot(m[1],m[2],Number(m[3].replace(/,/g,"")),req.body,res);
  }

  return res.status(204).end();
});

/* helper: handle the JSON object coming from Dink */
function processDinkJson(p,res){
  // diagnostic line you asked for:
  console.log("[dink] json", JSON.stringify(p).slice(0,120));    // ← NEW

  if(p?.type==="CHAT" && p?.extra?.type==="CLAN_CHAT" && typeof p.extra.message==="string"){
    const msg = p.extra.message;
    const m   = msg.match(LOOT_RE);
    if(!m) return res.status(204).end();
    return processLoot(m[1],m[2],Number(m[3].replace(/,/g,"")),msg,res);
  }
  return res.status(204).end();
}

/* ── ready & listen ───────────────────────────────────────────────── */
client.once("ready",()=>{
  console.log("[discord] ready:", client.user.tag);
  const port = process.env.PORT || 10000;   // Render injects PORT
  app.listen(port,()=>console.log("[http] listening on",port));
});

/* ── start bot ────────────────────────────────────────────────────── */
client.login(DISCORD_BOT_TOKEN);
