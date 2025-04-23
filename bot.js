/*  ────────────────────────────────────────────────────────────────────
    Monday-Madness Discord bot – de-dupe + RuneLite-Dink support
    ──────────────────────────────────────────────────────────────────── */

const express  = require("express");
const { Client, GatewayIntentBits, EmbedBuilder, Events } = require("discord.js");
const fs       = require("fs");
const path     = require("path");
const simpleGit= require("simple-git");
require("dotenv").config();

/* ── env ───────────────────────────────────────────────────────────── */
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID= process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT        = process.env.GITHUB_PAT;          // optional
const REPO   = "craigmuzza/monday-madness-bot";
const BRANCH = "main";
const COMMIT_MSG = "auto: sync data";

/* ── constants ─────────────────────────────────────────────────────── */
const DEDUP_MS = 10_000;               // 10-second anti-spam window
const LOOT_RE  = /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\(([\d,]+)\s+coins\).*/i;

/* ── express ───────────────────────────────────────────────────────── */
const app = express();
app.use(express.json());               // application/json
app.use(express.text({ type:"text/*" })); // raw text

/* ── discord client ────────────────────────────────────────────────── */
const client = new Client({
  intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]
});

/* ── runtime state ─────────────────────────────────────────────────── */
let currentEvent = "default";
let clanOnly     = false;

const registered = new Set();          // lower-case clan names
const seen       = new Map();          // de-dup key → lastTime

const events = { default:{ deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} } };

const ci = s=>s.toLowerCase().trim();
const now= ()=>Date.now();

/* ── load persisted clan list ──────────────────────────────────────── */
try{
  const arr = JSON.parse(fs.readFileSync(path.join(__dirname,"data/registered.json")));
  if(Array.isArray(arr)) arr.forEach(n=>registered.add(ci(n)));
}catch{/* first run */}

/* ── helpers ───────────────────────────────────────────────────────── */
function getEvent(){ if(!events[currentEvent]) events[currentEvent]={deathCounts:{},lootTotals:{},gpTotal:{},kills:{}}; return events[currentEvent]; }

function saveJSON(f,obj){
  const p=path.join(__dirname,f);
  fs.mkdirSync(path.dirname(p),{recursive:true});
  fs.writeFileSync(p,JSON.stringify(obj,null,2));
}

async function gitCommit(){
  if(!GITHUB_PAT) return;
  const git=simpleGit();
  await git.add(".");
  await git.commit(COMMIT_MSG);
  await git.push(`https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`,BRANCH);
}

/* ── de-dup purge every 30 s ───────────────────────────────────────── */
setInterval(()=>{ const t=now(); for(const[k,v] of seen) if(t-v>DEDUP_MS) seen.delete(k); },30_000);

/* ── core loot processor ───────────────────────────────────────────── */
async function processLoot(killer,victim,gp,line,res){
  if(clanOnly && (!registered.has(ci(killer))||!registered.has(ci(victim))))
    return res?.status(200).send("non-clan ignored");

  const key=`L|${line}`;
  if(seen.has(key)&&now()-seen.get(key)<DEDUP_MS)
    return res?.status(200).send("dup");
  seen.set(key,now());

  const {lootTotals,gpTotal,kills}=getEvent();
  lootTotals[ci(killer)] = (lootTotals[ci(killer)]||0)+gp;
  gpTotal  [ci(killer)] = (gpTotal  [ci(killer)]||0)+gp;
  kills    [ci(killer)] = (kills    [ci(killer)]||0)+1;

  const embed=new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({name:"Event GP Gained",value:`${lootTotals[ci(killer)].toLocaleString()} coins`,inline:true})
    .setColor(0xFF0000).setTimestamp();

  const ch=await client.channels.fetch(DISCORD_CHANNEL_ID);
  if(ch?.isTextBased()) await ch.send({embeds:[embed]});

  return res?.status(200).send("ok");
}

/* ── /logKill -------------------------------------------------------- */
app.post("/logKill",async(req,res)=>{
  const{killer,victim}=req.body||{};
  if(!killer||!victim) return res.status(400).send("bad");

  if(clanOnly && (!registered.has(ci(killer))||!registered.has(ci(victim))))
    return res.status(200).send("non-clan");

  const key=`K|${ci(killer)}|${ci(victim)}`;
  if(seen.has(key)&&now()-seen.get(key)<DEDUP_MS)
    return res.status(200).send("dup");
  seen.set(key,now());

  const{deathCounts}=getEvent();
  deathCounts[ci(victim)]=(deathCounts[ci(victim)]||0)+1;

  const embed=new EmbedBuilder()
    .setTitle("💀 Kill Logged")
    .setDescription(`**${killer}** killed **${victim}**`)
    .addFields({name:"Total Deaths",value:String(deathCounts[ci(victim)]),inline:true})
    .setColor(0xFF0000).setTimestamp();

  const ch=await client.channels.fetch(DISCORD_CHANNEL_ID);
  if(ch?.isTextBased()) await ch.send({embeds:[embed]});

  res.status(200).send("ok");
});

/* ── /logLoot (legacy HTTP) ----------------------------------------- */
app.post("/logLoot",(req,res)=>{
  const txt=req.body?.lootMessage;
  if(!txt) return res.status(400).send("bad");
  const m=txt.match(LOOT_RE);
  if(!m)   return res.status(400).send("fmt");
  processLoot(m[1],m[2],Number(m[3].replace(/,/g,"")),txt,res);
});

/* ── /dink (RuneLite-Dink webhook) ---------------------------------- */
app.post("/dink",(req,res)=>{
  /* JSON payload branch */
  if(typeof req.body==="object" && req.body){
    const p=req.body;
    if(p.type==="CHAT" && p.extra?.type==="CLAN_CHAT" && typeof p.extra.message==="string"){
      const m=p.extra.message.match(LOOT_RE);
      if(!m) return res.status(204).end();
      return processLoot(m[1],m[2],Number(m[3].replace(/,/g,"")),p.extra.message,res);
    }
  }
  /* Raw-text branch */
  if(typeof req.body==="string"){
    const txt=req.body.trim();
    const m=txt.match(LOOT_RE);
    if(!m) return res.status(204).end();
    return processLoot(m[1],m[2],Number(m[3].replace(/,/g,"")),txt,res);
  }
  return res.status(204).end();
});

/* ── boot http after Discord ready ─────────────────────────────────── */
client.once("ready",()=>{
  console.log(`Logged in as ${client.user.tag}`);
  app.listen(3000,()=>console.log("HTTP listening on 3000"));
});

/* ── Discord commands (same as before, kills now from events[..].kills) */
client.on(Events.MessageCreate,async m=>{
  if(m.author.bot) return;
  const t=m.content.toLowerCase();
  const{deathCounts,lootTotals,kills}=getEvent();

  if(t==="!hiscores"){
    const board=Object.entries(kills).map(([n,k])=>{
      const d=deathCounts[n]||0, kd=d? (k/d).toFixed(2):k;
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

  /* … keep the rest of your !createevent, !finishevent, !register, etc … */
});

/* ── start bot ─────────────────────────────────────────────────────── */
client.login(DISCORD_BOT_TOKEN);
