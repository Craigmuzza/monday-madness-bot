/*  ────────────────────────────────────────────────────────────────────
    Monday-Madness Discord bot
    ──────────────────────────────────────────────────────────────────── */

const express    = require("express");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events
} = require("discord.js");
const fs          = require("fs");
const path        = require("path");
const simpleGit   = require("simple-git");
const { formidable } = require("formidable");   // v4
require("dotenv").config();

/* ── env ───────────────────────────────────────────────────────────── */
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT         = process.env.GITHUB_PAT;   // optional
const REPO   = "craigmuzza/monday-madness-bot";
const BRANCH = "main";
const COMMIT = "auto: sync data";

/* ── constants ─────────────────────────────────────────────────────── */
const DEDUP_MS = 10_000;   // anti-spam window
const LOOT_RE  = /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\(([\d,]+)\s+coins\).*/i;

/* ── server + discord client ──────────────────────────────────────── */
const app = express();
app.use(express.json());
app.use(express.text({ type: "text/*" })); // for raw text bodies

const client = new Client({
  intents: [GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent]
});

/* ── state ─────────────────────────────────────────────────────────── */
let currentEvent = "default";
let clanOnly     = false;

const registered = new Set();        // saved clan list (lower-case)
const seen       = new Map();        // de-dup key → timestamp(ms)

const events = { default: makeEvent() };

function makeEvent() {
  return { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} };
}
function ci(s=""){ return s.toLowerCase().trim(); }
function getEvent(){ if(!events[currentEvent]) events[currentEvent]=makeEvent(); return events[currentEvent]; }
function now(){ return Date.now(); }

/* ── load persisted clan list ─────────────────────────────────────── */
try{
  const arr = JSON.parse(fs.readFileSync(path.join(__dirname,"data/registered.json")));
  if(Array.isArray(arr)) arr.forEach(n=>registered.add(ci(n)));
  console.log(`Loaded ${registered.size} registered names`);
}catch{/* first run */}

/* ── util helpers ─────────────────────────────────────────────────── */
function saveJSON(f,obj){
  const p=path.join(__dirname,f);
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
/* purge dedup cache */
setInterval(()=>{const t=now();for(const[k,v] of seen) if(t-v>DEDUP_MS) seen.delete(k);},30_000);

/* ── core loot processor ──────────────────────────────────────────── */
async function processLoot(killer,victim,gp,dedupKey,res){
  if(clanOnly && (!registered.has(ci(killer))||!registered.has(ci(victim))))
    return res?.status(200).send("non-clan");

  if(seen.has(dedupKey) && now()-seen.get(dedupKey)<DEDUP_MS)
    return res?.status(200).send("dup");
  seen.set(dedupKey,now());

  const {lootTotals,gpTotal,kills}=getEvent();
  lootTotals[ci(killer)] = (lootTotals[ci(killer)]||0)+gp;
  gpTotal  [ci(killer)] = (gpTotal  [ci(killer)]||0)+gp;
  kills    [ci(killer)] = (kills    [ci(killer)]||0)+1;

  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({ name:"Event GP Gained", value:`${lootTotals[ci(killer)].toLocaleString()} coins`, inline:true })
    .setColor(0xFF0000)
    .setTimestamp();

  try{
    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if(ch?.isTextBased()) await ch.send({ embeds:[embed] });
  }catch(e){ console.error("[Discord] send error:",e); }

  return res?.status(200).send("ok");
}

/* helper for raw CC text line */
function handleLootLine(txt,res){
  const m=txt.match(LOOT_RE);
  if(!m) return res?.status(400).send("no-match");
  const gp=Number(m[3].replace(/,/g,""));
  return processLoot(m[1],m[2],gp,txt.trim(),res);
}

/* ── routes: /logKill ------------------------------------------------ */
app.post("/logKill",async(req,res)=>{
  const { killer,victim } = req.body||{};
  if(!killer||!victim) return res.status(400).send("bad");

  if(clanOnly && (!registered.has(ci(killer))||!registered.has(ci(victim))))
    return res.status(200).send("non-clan");

  const key=`K|${ci(killer)}|${ci(victim)}`;
  if(seen.has(key)&&now()-seen.get(key)<DEDUP_MS)
    return res.status(200).send("dup");
  seen.set(key,now());

  const {deathCounts}=getEvent();
  deathCounts[ci(victim)]=(deathCounts[ci(victim)]||0)+1;

  const embed = new EmbedBuilder()
    .setTitle("💀 Kill Logged")
    .setDescription(`**${killer}** killed **${victim}**`)
    .addFields({ name:"Total Deaths", value:String(deathCounts[ci(victim)]), inline:true })
    .setColor(0xFF0000)
    .setTimestamp();

  try{
    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if(ch?.isTextBased()) await ch.send({ embeds:[embed] });
  }catch(e){ console.error("[Discord] send error:",e); }

  res.status(200).send("ok");
});

/* /logLoot (legacy direct JSON) ------------------------------------ */
app.post("/logLoot",(req,res)=>{
  const txt=req.body?.lootMessage;
  if(!txt) return res.status(400).send("bad");
  handleLootLine(txt,res);
});

/* /dink – handles multipart **and** JSON/text ----------------------- */
app.post("/dink",(req,res)=>{
  const ct=req.headers["content-type"]||"";

  /* A) multipart/form-data (RuneLite default) */
  if(ct.startsWith("multipart/form-data")){
    formidable({ multiples:false }).parse(req,(err,fields)=>{
      if(err||!fields.payload) return res.status(400).send("multipart err");
      let p; try{p=JSON.parse(fields.payload);}catch{return res.status(400).send("json err");}
      return processDinkJson(p,res);
    });
    return;
  }

  /* B) JSON body */
  if(typeof req.body==="object")  return processDinkJson(req.body,res);

  /* C) plain text */
  if(typeof req.body==="string")  return handleLootLine(req.body,res);

  return res.status(204).end();
});

function processDinkJson(p,res){
  if(
    p?.type==="CHAT" &&
    p?.extra?.type==="CLAN_CHAT" &&
    typeof p.extra.message==="string"
  ){
    return handleLootLine(p.extra.message,res);
  }
  return res.status(204).end();
}

/* ── start HTTP after Discord is live ─────────────────────────────── */
client.once("ready",()=>{
  console.log(`Logged in as ${client.user.tag}`);
  app.listen(3000,()=>console.log("HTTP listening on 3000"));
});

/* ── Discord commands (same as before) ────────────────────────────── */
client.on(Events.MessageCreate,async m=>{
  if(m.author.bot) return;
  const t=m.content.toLowerCase();
  const{deathCounts,lootTotals,kills}=getEvent();

  if(t==="!hiscores"){
    const board=Object.entries(kills).map(([n,k])=>{
      const d=deathCounts[n]||0, kd=d?(k/d).toFixed(2):k;
      return{n,k,d,kd};
    }).sort((a,b)=>b.k-a.k).slice(0,10);

    const e=new EmbedBuilder().setTitle("🏆 Hiscores").setColor(0xFF0000).setTimestamp();
    if(!board.length) e.setDescription("No kills yet.");
    else board.forEach((v,i)=>e.addFields({name:`${i+1}. ${v.n}`,value:`Kills ${v.k} | Deaths ${v.d} | K/D ${v.kd}`,inline:false}));
    return m.channel.send({embeds:[e]});
  }

  if(t==="!lootboard"){
    const sorted=Object.entries(lootTotals).sort((a,b)=>b[1]-a[1]).slice(0,10);
    const e=new EmbedBuilder().setTitle("💰 Top Loot Earners 💰").setColor(0xFF0000).setTimestamp();
    if(!sorted.length) e.setDescription("No loot yet.");
    else sorted.forEach(([n,gp],i)=>e.addFields({name:`${i+1}. ${n}`,value:`${gp.toLocaleString()} coins`,inline:false}));
    return m.channel.send({embeds:[e]});
  }

  /* … keep !createevent, !finishevent, !register, !help, etc … */
});

/* ── go ───────────────────────────────────────────────────────────── */
client.login(DISCORD_BOT_TOKEN);
