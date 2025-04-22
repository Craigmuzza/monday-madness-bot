// bot.js — “event‑aware” running totals
//--------------------------------------------------
const express  = require("express");
const bodyParser = require("body-parser");
const { Client, GatewayIntentBits, EmbedBuilder, Events } = require("discord.js");
const fs        = require("fs");
const path      = require("path");
const simpleGit = require("simple-git");
require("dotenv").config();

// ---------- ENV -----------------------------------------------------------------
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT         = process.env.GITHUB_PAT;          // optional
const REPO               = "craigmuzza/monday-madness-bot"; // change if needed
const BRANCH             = "main";
const COMMIT_MSG         = "auto‑event‑save";

// ---------- EXPRESS -------------------------------------------------------------
const app = express();
app.use(bodyParser.json());

// ---------- DISCORD -------------------------------------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent]
});

// ---------- STATE ---------------------------------------------------------------
let currentEvent = "default";
let clanOnlyMode = false;
let registered   = new Set();            // saved between restarts

const events = {
  default: { killCounts:{}, deathCounts:{}, lootTotals:{} }
};

// helper to always return a per‑event object
function ev() {
  if (!events[currentEvent])
    events[currentEvent] = { killCounts:{}, deathCounts:{}, lootTotals:{} };
  return events[currentEvent];
}

// case‑insensitive key
const CK = s => s.toLowerCase();

// ---------- PERSISTENCE ---------------------------------------------------------
function saveJson(file, obj) {
  const fp = path.join(__dirname, file);
  fs.mkdirSync(path.dirname(fp), { recursive:true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
}

async function gitPush() {
  if (!GITHUB_PAT) return;
  const git = simpleGit();
  await git.add('.');
  await git.commit(COMMIT_MSG);
  await git.push(`https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`, BRANCH);
}

// load registered names on start
try {
  JSON.parse(fs.readFileSync(path.join(__dirname,"data/registered.json")))
      .forEach(n => registered.add(CK(n)));
} catch { /* first run */ }

// ---------- REST ENDPOINTS (RuneLite calls) ------------------------------------
client.once("ready", () => {
  console.log(`Discord ready as ${client.user.tag}`);

  // /logKill  (death message sent by PLUGIN)
  app.post("/logKill", async (req,res)=>{
    const { killer, victim } = req.body||{};
    if (!killer||!victim) return res.status(400).send("Missing killer/victim");

    if (clanOnlyMode && (!registered.has(CK(killer))||!registered.has(CK(victim))))
      return res.status(200).send("Ignored non‑clan kill");

    ev().deathCounts[CK(victim)] = (ev().deathCounts[CK(victim)]||0)+1;

    const embed = new EmbedBuilder()
      .setTitle("💀 Kill Logged")
      .setDescription(`**${killer}** killed **${victim}**`)
      .addFields({name:"Victim Deaths", value:String(ev().deathCounts[CK(victim)])})
      .setColor(0xFF0000).setTimestamp();

    try {
      const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
      if (ch?.isTextBased()) ch.send({embeds:[embed]});
    } catch(e){console.error(e);}
    res.sendStatus(200);
  });

  // /logLoot  (loot line from PLUGIN)
  app.post("/logLoot", async (req,res)=>{
    const { lootMessage } = req.body||{};
    if (!lootMessage) return res.status(400).send("Missing lootMessage");

    const m = lootMessage.match(/(.+?) has defeated (.+?) and received \(([\d,]+) coins\)/i);
    if (!m) return res.status(400).send("Bad format");

    const [, killer, victim, gpStr] = m;
    if (clanOnlyMode && (!registered.has(CK(killer))||!registered.has(CK(victim))))
      return res.status(200).send("Ignored non‑clan loot");

    const gp = +gpStr.replace(/,/g,"");
    ev().killCounts[CK(killer)] = (ev().killCounts[CK(killer)]||0)+1;
    ev().lootTotals[CK(killer)] = (ev().lootTotals[CK(killer)]||0)+gp;

    const embed = new EmbedBuilder()
      .setTitle("💰 Loot Detected")
      .setDescription(`**${killer}** → **${gp.toLocaleString()} coins**`)
      .addFields({name:"Event GP", value:`${ev().lootTotals[CK(killer)].toLocaleString()} coins`})
      .setColor(0xFFD700).setTimestamp();

    try {
      const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
      if (ch?.isTextBased()) ch.send({embeds:[embed]});
    } catch(e){console.error(e);}
    res.sendStatus(200);
  });

  app.listen(3000, ()=>console.log("REST up on 3000"));
});

// ---------- DISCORD COMMANDS ---------------------------------------------------
client.on(Events.MessageCreate, async msg=>{
  if (msg.author.bot) return;

  const e   = ev();                 // shorthand
  const cmd = msg.content.trim();

  /* ----- hiscores (per‑event) ----- */
  if (cmd==="!hiscores") {
    const rows = Object.entries(e.killCounts)
      .map(([n,k])=>{
        const d = e.deathCounts[n]||0;
        const kd = d? (k/d).toFixed(2): k;
        return {n,k,d,kd}; })
      .sort((a,b)=>b.k-a.k)
      .slice(0,10);

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Hiscores – ${currentEvent} 🏆`)
      .setColor(0xFF0000).setTimestamp();

    rows.forEach((r,i)=>embed.addFields({
      name:`${i+1}. ${r.n}`, value:`Kills: ${r.k}  Deaths: ${r.d}  K/D: ${r.kd}`, inline:false}));
    return msg.channel.send({embeds:[embed]});
  }

  /* ----- lootboard (per‑event) ----- */
  if (cmd==="!lootboard") {
    const rows = Object.entries(e.lootTotals).sort((a,b)=>b[1]-a[1]).slice(0,10);
    const embed = new EmbedBuilder()
      .setTitle(`💰 Lootboard – ${currentEvent} 💰`)
      .setColor(0xFF0000).setTimestamp();

    if (!rows.length) embed.setDescription("No loot yet.");
    else rows.forEach(([n,gp],i)=>embed.addFields({name:`${i+1}. ${n}`,value:`${gp.toLocaleString()} coins`}));
    return msg.channel.send({embeds:[embed]});
  }

  /* ----- event management ----- */
  if (cmd.startsWith("!createEvent ")) {
    const name = cmd.slice(13).trim();
    if (!name||events[name]) return msg.reply("Invalid or duplicate.");
    events[name]={killCounts:{},deathCounts:{},lootTotals:{}};
    currentEvent=name;
    return msg.reply(`Event **${name}** started.`);
  }

  if (cmd==="!finishEvent") {
    if (currentEvent==="default") return msg.reply("Not in an event.");
    const finished = events[currentEvent];
    const file = `events/event_${currentEvent}_${Date.now()}.json`;
    saveJson(file, finished);

    // merge into default running totals
    ["killCounts","deathCounts","lootTotals"].forEach(key=>{
      for (const [n,v] of Object.entries(finished[key]))
        events.default[key][n]=(events.default[key][n]||0)+v;
    });

    delete events[currentEvent];
    currentEvent="default";
    await gitPush();

    const embed=new EmbedBuilder()
      .setTitle("📦 Event finished")
      .setDescription(`Saved \`${file}\` and merged into default totals.`)
      .setColor(0xFF0000).setTimestamp();
    return msg.channel.send({embeds:[embed]});
  }

  if (cmd==="!listEvents") {
    const embed=new EmbedBuilder()
      .setTitle("📅 Events")
      .setDescription(Object.keys(events).map(e=>`• ${e}${e===currentEvent?" *(current)*":""}`).join("\n"))
      .setColor(0xFF0000).setTimestamp();
    return msg.channel.send({embeds:[embed]});
  }

  /* ----- clan registration & toggle ----- */
  if (cmd.startsWith("!register ")) {
    const names = cmd.slice(10).split(",").map(s=>CK(s.trim())).filter(Boolean);
    names.forEach(n=>registered.add(n));
    saveJson("data/registered.json", Array.from(registered));
    await gitPush();
    return msg.reply(`Registered: ${names.join(", ")}`);
  }
  if (cmd.startsWith("!unregister ")) {
    const names = cmd.slice(12).split(",").map(s=>CK(s.trim())).filter(Boolean);
    names.forEach(n=>registered.delete(n));
    saveJson("data/registered.json", Array.from(registered));
    await gitPush();
    return msg.reply(`Unregistered: ${names.join(", ")}`);
  }
  if (cmd==="!clanOnly on")  { clanOnlyMode=true;  return msg.reply("Clan‑only **enabled**."); }
  if (cmd==="!clanOnly off") { clanOnlyMode=false; return msg.reply("Clan‑only **disabled**."); }

  /* ----- help ----- */
  if (cmd==="!help") {
    const embed=new EmbedBuilder()
      .setTitle("🛠 Monday Madness Bot – Help")
      .addFields(
        {name:"📊 Stats",  value:"`!hiscores`, `!lootboard`", inline:false},
        {name:"🎯 Events", value:"`!createEvent <name>`, `!finishEvent`, `!listEvents`", inline:false},
        {name:"👥 Clan",   value:"`!register <names>`, `!unregister <names>`, `!clanOnly on/off`", inline:false},
        {name:"❓ Help",   value:"`!help`", inline:false})
      .setColor(0xFF0000).setTimestamp();
    return msg.channel.send({embeds:[embed]});
  }
});

// ---------- START --------------------------------------------------------------
client.login(DISCORD_BOT_TOKEN);
