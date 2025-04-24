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

// ── __dirname for ESM ──────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Environment ────────────────────────────────────────────────────
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT         = process.env.GITHUB_PAT;  // optional
const REPO               = "craigmuzza/monday-madness-bot";
const BRANCH             = "main";
const COMMIT_MSG         = "auto: sync data";

// ── Constants ───────────────────────────────────────────────────────
const DEDUP_MS = 10_000; // 10s
const LOOT_RE  = /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\( *([\d,]+) *coins\).*/i;

// ── Express + Multer ────────────────────────────────────────────────
const app    = express();
const upload = multer(); // parse multipart/form-data
app.use(express.json());
app.use(express.text({ type: "text/*" }));

// ── Discord client ─────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ── Bot state ───────────────────────────────────────────────────────
let currentEvent = "default";
let clanOnlyMode = false;
const registered = new Set();
const seen       = new Map();
const events     = { default: { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} } };

const ci  = s => (s||"").toLowerCase().trim();
const now = () => Date.now();

// ── Load or create registered.json ─────────────────────────────────
const regFile = path.join(__dirname, "data/registered.json");
try {
  if (!fs.existsSync(path.dirname(regFile))) fs.mkdirSync(path.dirname(regFile), { recursive: true });
  if (!fs.existsSync(regFile)) fs.writeFileSync(regFile, JSON.stringify([], null, 2));
  JSON.parse(fs.readFileSync(regFile)).forEach(n => registered.add(ci(n)));
  console.log(`[init] loaded ${registered.size} registered names`);
} catch (e) {
  console.error("[init] failed to load registered.json:", e);
}

// ── Commit helper (failsafe) ───────────────────────────────────────
async function commitToGitHub() {
  if (!GITHUB_PAT) return;
  try {
    const git = simpleGit();
    await git.add(".");
    await git.commit(COMMIT_MSG);
    await git.push(
      `https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`,
      BRANCH
    );
  } catch (e) {
    console.warn("[git] commit or push failed, skipping:", e.message);
  }
}

// ── Ensure event bucket ─────────────────────────────────────────────
function getEventData() {
  if (!events[currentEvent]) {
    events[currentEvent] = { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} };
  }
  return events[currentEvent];
}

// ── Core loot processor ─────────────────────────────────────────────
async function processLoot(killer, victim, gp, dedupKey, res) {
  if (clanOnlyMode && (!registered.has(ci(killer)) || !registered.has(ci(victim)))) {
    return res.status(200).send("non-clan ignored");
  }
  if (seen.has(dedupKey) && now() - seen.get(dedupKey) < DEDUP_MS) {
    return res.status(200).send("duplicate");
  }
  seen.set(dedupKey, now());

  const { lootTotals, gpTotal, kills } = getEventData();
  lootTotals[ci(killer)] = (lootTotals[ci(killer)] || 0) + gp;
  gpTotal  [ci(killer)] = (gpTotal[ci(killer)]   || 0) + gp;
  kills    [ci(killer)] = (kills[ci(killer)]     || 0) + 1;

  const title = "💰 Loot Detected";
  const fieldName = currentEvent === "default" ? "Total GP Earned" : "Event GP Gained";

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({
      name: fieldName,
      value: `${lootTotals[ci(killer)].toLocaleString()} coins`,
      inline: true
    })
    .setColor(0xFF0000)
    .setTimestamp();

  const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if (ch?.isTextBased()) {
    await ch.send({ embeds: [embed] });
    console.log("[discord] sent loot embed");
  }

  return res.status(200).send("ok");
}

// ── /logKill ────────────────────────────────────────────────────────
app.post("/logKill", async (req, res) => {
  const { killer, victim } = req.body || {};
  if (!killer || !victim) return res.status(400).send("bad data");

  if (clanOnlyMode && (!registered.has(ci(killer)) || !registered.has(ci(victim)))) {
    return res.status(200).send("non-clan ignored");
  }

  const dupKey = `K|${ci(killer)}|${ci(victim)}`;
  if (seen.has(dupKey) && now() - seen.get(dupKey) < DEDUP_MS) {
    return res.status(200).send("duplicate");
  }
  seen.set(dupKey, now());

  const { deathCounts } = getEventData();
  deathCounts[ci(victim)] = (deathCounts[ci(victim)] || 0) + 1;

  const embed = new EmbedBuilder()
    .setTitle("💀 Kill Logged")
    .setDescription(`**${killer}** killed **${victim}**`)
    .addFields({ name: "Total Deaths", value: String(deathCounts[ci(victim)]), inline: true })
    .setColor(0xFF0000)
    .setTimestamp();

  const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if (ch?.isTextBased()) {
    await ch.send({ embeds: [embed] });
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
  return processLoot(m[1], m[2], Number(m[3].replace(/,/g, "")), txt.trim(), res);
});

// ── /dink (multipart/form-data) ───────────────────────────────────
app.post(
  "/dink",
  upload.none(),
  async (req, res) => {
    let raw = req.body.payload_json;
    if (Array.isArray(raw)) raw = raw[0];
    if (!raw) return res.status(400).send("no payload_json");

    let data;
    try { data = JSON.parse(raw); }
    catch { return res.status(400).send("bad JSON"); }

    const msg = data.extra?.message;
    if (typeof msg === "string") console.log("[dink] clan chat message:", msg);

    if (
      data.type === "CHAT" &&
      ["CLAN_CHAT","CLAN_MESSAGE"].includes(data.extra?.type) &&
      typeof msg === "string"
    ) {
      const m = msg.match(LOOT_RE);
      if (m) {
        return processLoot(
          m[1], m[2], Number(m[3].replace(/,/g, "")),
          msg.trim(), res
        );
      }
    }
    return res.status(204).end();
  }
);

// ── start server after Discord ready ────────────────────────────────
client.once("ready", () => {
  console.log(`[discord] ready: ${client.user.tag}`);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[http] listening on ${port}`));
});

// ── Discord commands ────────────────────────────────────────────────
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  const text = msg.content;
  const cmd  = text.split(" ")[0].toLowerCase();
  const args = text.slice(cmd.length).trim(); // preserves spaces in names
  const { deathCounts, lootTotals, kills } = getEventData();

  // !hiscores [name]
  if (cmd === "!hiscores") {
    if (!args) {
      // global top 10
      const board = Object.entries(kills)
        .map(([n,k]) => {
          const d = deathCounts[n]||0;
          return { n,k,d,kd: d? (k/d).toFixed(2):k };
        })
        .sort((a,b)=>b.k-a.k).slice(0,10);
      const e = new EmbedBuilder().setTitle("🏆 Hiscores").setColor(0xFF0000).setTimestamp();
      if (!board.length) e.setDescription("No kills yet.");
      else board.forEach((v,i)=> e.addFields({
        name:`${i+1}. ${v.n}`, value:`Kills ${v.k} | Deaths ${v.d} | K/D ${v.kd}`
      }));
      return msg.channel.send({ embeds:[e] });
    } else {
      const key = ci(args);
      const k = kills[key]||0;
      if (!k) return msg.reply(`No kills recorded for "${args}".`);
      const d = deathCounts[key]||0;
      const kd = d? (k/d).toFixed(2):k;
      const e = new EmbedBuilder()
        .setTitle(`Hiscores for ${args}`)
        .addFields(
          { name:"Kills", value:String(k), inline:true },
          { name:"Deaths",value:String(d), inline:true },
          { name:"K/D",   value:String(kd),inline:true }
        )
        .setColor(0xFF0000).setTimestamp();
      return msg.channel.send({ embeds:[e] });
    }
  }

  // !lootboard [name]
  if (cmd === "!lootboard") {
    if (!args) {
      const sorted = Object.entries(lootTotals)
        .sort((a,b)=>b[1]-a[1]).slice(0,10);
      const e = new EmbedBuilder().setTitle("💰 Top Loot Earners").setColor(0xFF0000).setTimestamp();
      if (!sorted.length) e.setDescription("No loot yet.");
      else sorted.forEach(([n,gp],i)=> e.addFields({
        name:`${i+1}. ${n}`, value:`${gp.toLocaleString()} coins`
      }));
      return msg.channel.send({ embeds:[e] });
    } else {
      const key = ci(args);
      const gp  = lootTotals[key]||0;
      if (!gp) return msg.reply(`No loot recorded for "${args}".`);
      const e = new EmbedBuilder()
        .setTitle(`Lootboard for ${args}`)
        .addFields({ name:"GP Earned", value:`${gp.toLocaleString()} coins`})
        .setColor(0xFF0000).setTimestamp();
      return msg.channel.send({ embeds:[e] });
    }
  }

  // !listclan
  if (cmd === "!listclan") {
    if (!registered.size) return msg.reply("No registered clan members.");
    return msg.reply("Registered clan: " + [...registered].join(", "));
  }

  // !listevents, !createevent, !finishevent, !register, !unregister, !clanonly on/off, !help
  if (cmd === "!listevents") {
    const e = new EmbedBuilder()
      .setTitle("📅 Available Events")
      .setDescription(Object.keys(events).map(ev=>`• ${ev}${ev===currentEvent?" *(current)*":""}`).join("\n"))
      .setColor(0xFF0000).setTimestamp();
    return msg.channel.send({ embeds:[e] });
  }
  if (cmd === "!createevent") {
    const name = args;
    if (!name||events[name]) return msg.reply("Invalid or duplicate event name.");
    events[name]={ deathCounts:{},lootTotals:{},gpTotal:{},kills:{} };
    currentEvent=name;
    return msg.reply(`Event **${name}** created and selected.`);
  }
  if (cmd === "!finishevent") {
    const file = `events/event_${currentEvent}_${new Date().toISOString().replace(/[:.]/g,"-")}.json`;
    fs.mkdirSync(path.dirname(path.join(__dirname,file)),{recursive:true});
    fs.writeFileSync(path.join(__dirname,file),JSON.stringify(events[currentEvent],null,2));
    await commitToGitHub();
    delete events[currentEvent];
    currentEvent="default";
    const e = new EmbedBuilder()
      .setTitle("📦 Event Finalised")
      .setDescription(`Saved as \`${file}\` and switched back to **default**.`)
      .setColor(0xFF0000).setTimestamp();
    return msg.channel.send({ embeds:[e] });
  }
  if (cmd === "!register") {
    const names = args.split(",").map(ci).filter(Boolean);
    names.forEach(n=>registered.add(n));
    fs.writeFileSync(regFile, JSON.stringify([...registered],null,2));
    await commitToGitHub();
    return msg.reply("Registered: "+names.join(", "));
  }
  if (cmd === "!unregister") {
    const names = args.split(",").map(ci).filter(Boolean);
    names.forEach(n=>registered.delete(n));
    fs.writeFileSync(regFile, JSON.stringify([...registered],null,2));
    await commitToGitHub();
    return msg.reply("Unregistered: "+names.join(", "));
  }
  if (cmd === "!clanonly") {
    if (args==="on")  { clanOnlyMode=true;  return msg.reply("Clan-only mode enabled."); }
    if (args==="off") { clanOnlyMode=false; return msg.reply("Clan-only mode disabled."); }
  }
  if (cmd === "!help") {
    const e = new EmbedBuilder()
      .setTitle("🛠 Robo-Rat – Help")
      .addFields(
        { name:"Stats",  value:"`!hiscores [name]`, `!lootboard [name]`" },
        { name:"Clan",   value:"`!register a,b`, `!unregister a,b`, `!listclan`, `!clanonly on/off`" },
        { name:"Events", value:"`!listevents`,`!createevent x`,`!finishevent`" },
        { name:"More",   value:"`!help`" }
      )
      .setColor(0xFF0000).setTimestamp();
    return msg.channel.send({ embeds:[e] });
  }
});

// ── Login ───────────────────────────────────────────────────────────
client.login(DISCORD_BOT_TOKEN);
