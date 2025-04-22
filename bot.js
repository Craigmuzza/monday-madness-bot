// bot.js
// --------------------------------------------------
// core libs
const express  = require("express");
const bodyParser = require("body-parser");
const { Client, GatewayIntentBits, EmbedBuilder, Events } = require("discord.js");
const fs        = require("fs");
const path      = require("path");
const simpleGit = require("simple-git");
require("dotenv").config();

// --------------------------------------------------
// env
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT   = process.env.GITHUB_PAT;
const REPO         = "craigmuzza/monday-madness-bot";
const BRANCH       = "main";
const COMMIT_MSG   = "Muz";

// --------------------------------------------------
// express
const app = express();
app.use(bodyParser.json());

// --------------------------------------------------
// discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// --------------------------------------------------
// in‑memory state
let currentEvent   = "default";
let clanOnlyMode   = false;
let registeredNames = new Set();
let chatKillCounts  = {};                   // kills deduced from loot line
const events = {
  default: { deathCounts: {}, lootTotals: {}, gpTotal: {} }
};

// --------------------------------------------------
// helpers
function ci(name) { return name?.toLowerCase(); }     // case‑insensitive key

function getEventData() {
  if (!events[currentEvent]) {
    events[currentEvent] = { deathCounts: {}, lootTotals: {}, gpTotal: {} };
  }
  return events[currentEvent];
}

function saveJSON(file, dataObj) {
  const p = path.join(__dirname, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(dataObj, null, 2));
}

async function commitToGitHub() {
  if (!GITHUB_PAT) return;                 // fail‑soft if PAT not supplied
  const git = simpleGit();
  await git.add(".");
  await git.commit(COMMIT_MSG);
  await git.push(`https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`, BRANCH);
}

// --------------------------------------------------
// load persistent registered names at start‑up
try {
  const stored = JSON.parse(fs.readFileSync(path.join(__dirname, "data/registered.json")));
  if (Array.isArray(stored)) stored.forEach(n => registeredNames.add(ci(n)));
  console.log(`Loaded ${registeredNames.size} registered clan names`);
} catch { /* first run – no file yet */ }

// --------------------------------------------------
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);

  // ---------- /logKill --------------------------------------------------
  app.post("/logKill", async (req, res) => {
    const { killer, victim } = req.body || {};
    if (!killer || !victim) return res.status(400).send("Missing killer or victim");

    // clan filter
    if (clanOnlyMode && (!registeredNames.has(ci(killer)) || !registeredNames.has(ci(victim)))) {
      return res.status(200).send("Ignored non‑clan kill");
    }

    const { deathCounts } = getEventData();
    deathCounts[ci(victim)] = (deathCounts[ci(victim)] || 0) + 1;

    const embed = new EmbedBuilder()
      .setTitle("💀 Kill Logged")
      .setDescription(`**${killer}** killed **${victim}**`)
      .addFields({ name: "Total Deaths", value: String(deathCounts[ci(victim)]), inline: true })
      .setColor(0xFF0000)
      .setTimestamp();

    try {
      const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
      if (channel?.isTextBased()) await channel.send({ embeds:[embed] });
    } catch(e) { console.error("Discord error while sending kill:", e); }

    res.status(200).send("Kill logged");
  });

  // ---------- /logLoot --------------------------------------------------
  app.post("/logLoot", async (req, res) => {
    const { lootMessage } = req.body || {};
    if (!lootMessage) return res.status(400).send("Missing loot message");

    /* FIXED REGEX  – allows any suffix (e.g. 'worth of loot!') */
    const regex = /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\(([\d,]+)\s+coins\).*/i;
    const m = lootMessage.match(regex);
    if (!m) {
      console.warn("Loot regex did not match:", lootMessage);
      return res.status(400).send("Invalid loot message format");
    }

    const [, killer, victim, gpStr] = m;
    if (clanOnlyMode && (!registeredNames.has(ci(killer)) || !registeredNames.has(ci(victim)))) {
      return res.status(200).send("Ignored non‑clan loot");
    }

    const gp = Number(gpStr.replace(/,/g,""));
    const { lootTotals, gpTotal } = getEventData();
    lootTotals[ci(killer)] = (lootTotals[ci(killer)] || 0) + gp;
    gpTotal   [ci(killer)] = (gpTotal   [ci(killer)] || 0) + gp;
    chatKillCounts[ci(killer)] = (chatKillCounts[ci(killer)] || 0) + 1;

    const embed = new EmbedBuilder()
      .setTitle("💰 Loot Detected")
      .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
      .addFields({ name:"Event GP Gained", value: `${lootTotals[ci(killer)].toLocaleString()} coins`, inline: true })
      .setColor(0xFFD700)
      .setTimestamp();

    try {
      const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
      if (channel?.isTextBased()) await channel.send({ embeds:[embed] });
    } catch(e) { console.error("Discord error while sending loot:", e); }

    res.status(200).send("Loot logged");
  });

  // express up
  app.listen(3000, ()=>console.log("Server listening on 3000"));
});

// --------------------------------------------------
// discord command handling
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const { deathCounts, lootTotals } = getEventData();

  // ---------- !hiscores
  if (message.content === "!hiscores") {
    const scoreboard = Object.entries(chatKillCounts).map(([n,k])=>{
      const d = deathCounts[n] || 0;
      const ratio = d===0 ? k : (k/d).toFixed(2);
      return { n,k,d,ratio };
    }).sort((a,b)=>b.k-a.k).slice(0,10);

    const embed = new EmbedBuilder()
      .setTitle("🏆 Monday Madness Hiscores 🏆")
      .setColor(0xFF0000)
      .setTimestamp();

    scoreboard.forEach((e,i)=>{
      embed.addFields({ name:`${i+1}. ${e.n}`, value:`Kills: ${e.k}  Deaths: ${e.d}  K/D: ${e.ratio}`, inline:false });
    });

    return message.channel.send({ embeds:[embed] });
  }

  // ---------- !lootboard
  if (message.content === "!lootboard") {
    const sorted = Object.entries(lootTotals).sort((a,b)=>b[1]-a[1]).slice(0,10);

    const embed = new EmbedBuilder()
      .setTitle("💰 Top Loot Earners 💰")
      .setColor(0xFF0000)
      .setTimestamp();

    if (sorted.length===0) embed.setDescription("No loot recorded yet.");
    else sorted.forEach(([n,gp],i)=>embed.addFields({ name:`${i+1}. ${n}`, value:`${gp.toLocaleString()} coins`, inline:false }));

    return message.channel.send({ embeds:[embed] });
  }

  // ---------- !listEvents
  if (message.content === "!listEvents") {
    const embed = new EmbedBuilder()
      .setTitle("📅 Available Events")
      .setDescription(Object.keys(events).map(e=>`• ${e}${e===currentEvent?" *(current)*":""}`).join("\n"))
      .setColor(0xFF0000)
      .setTimestamp();
    return message.channel.send({ embeds:[embed] });
  }

  // ---------- !createEvent
  if (message.content.startsWith("!createEvent ")) {
    const name = message.content.slice(13).trim();
    if (!name || events[name]) return message.reply("Invalid or duplicate event name.");
    events[name]={ deathCounts:{}, lootTotals:{}, gpTotal:{} };
    currentEvent=name;
    return message.reply(`Event **${name}** created and selected.`);
  }

  // ---------- !finishEvent
  if (message.content === "!finishEvent") {
    const file = `events/event_${currentEvent}_${new Date().toISOString().replace(/[:.]/g,"-")}.json`;
    saveJSON(file, events[currentEvent]);
    await commitToGitHub();
    delete events[currentEvent];
    currentEvent="default";

    const embed = new EmbedBuilder()
      .setTitle("📦 Event Finalised")
      .setDescription(`Saved as \`${file}\` and switched back to **default**.`)
      .setColor(0xFF0000)
      .setTimestamp();
    return message.channel.send({ embeds:[embed] });
  }

  // ---------- !register
  if (message.content.startsWith("!register ")) {
    const names = message.content.slice(10).split(",").map(s=>ci(s.trim())).filter(Boolean);
    names.forEach(n=>registeredNames.add(n));
    saveJSON("data/registered.json", Array.from(registeredNames));
    await commitToGitHub();
    return message.reply(`Registered: ${names.join(", ")}`);
  }

  // ---------- !unregister
  if (message.content.startsWith("!unregister ")) {
    const names = message.content.slice(12).split(",").map(s=>ci(s.trim())).filter(Boolean);
    names.forEach(n=>registeredNames.delete(n));
    saveJSON("data/registered.json", Array.from(registeredNames));
    await commitToGitHub();
    return message.reply(`Unregistered: ${names.join(", ")}`);
  }

  // ---------- !clanOnly
  if (message.content === "!clanOnly on")  { clanOnlyMode=true;  return message.reply("Clan‑only mode **enabled**."); }
  if (message.content === "!clanOnly off") { clanOnlyMode=false; return message.reply("Clan‑only mode **disabled**."); }

  // ---------- !help
  if (message.content === "!help") {
    const embed = new EmbedBuilder()
      .setTitle("🛠 Monday Madness Bot – Help")
      .addFields(
        { name:"📊 Stats", value:"`!hiscores`, `!lootboard`", inline:false },
        { name:"🎯 Events", value:"`!createEvent <name>`, `!finishEvent`, `!listEvents`", inline:false },
        { name:"👥 Clan",  value:"`!register <names>`, `!unregister <names>`, `!clanOnly on/off`", inline:false },
        { name:"❓ Help",  value:"`!help`", inline:false }
      )
      .setColor(0xFF0000)
      .setTimestamp();
    return message.channel.send({ embeds:[embed] });
  }
});

// --------------------------------------------------
client.login(DISCORD_BOT_TOKEN);
