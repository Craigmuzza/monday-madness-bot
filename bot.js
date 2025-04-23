// bot.js  – red embeds + de-dupe
// --------------------------------------------------
const express  = require("express");
const bodyParser = require("body-parser");
const { Client, GatewayIntentBits, EmbedBuilder, Events } = require("discord.js");
const fs        = require("fs");
const path      = require("path");
const simpleGit = require("simple-git");
require("dotenv").config();

// ──────────────────────────────────────────────────
// env
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT   = process.env.GITHUB_PAT;
const REPO         = "craigmuzza/monday-madness-bot";
const BRANCH       = "main";
const COMMIT_MSG   = "Muz";

// de-duplication: any identical key within this window is ignored
const DEDUP_WINDOW_MS = 10_000;

// ──────────────────────────────────────────────────
const app = express();
app.use(bodyParser.json());

// discord client
const client = new Client({
  intents: [ GatewayIntentBits.Guilds,
             GatewayIntentBits.GuildMessages,
             GatewayIntentBits.MessageContent ]
});

// in-memory state --------------------------------------------------------
let currentEvent     = "default";
let clanOnlyMode     = false;
let registeredNames  = new Set();
let chatKillCounts   = {};               // kills inferred from loot line
const events = {
  default: { deathCounts:{}, lootTotals:{}, gpTotal:{} }
};

// de-duplication cache ---------------------------------------------------
const seenRecently = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k,t] of seenRecently)
    if (now - t > DEDUP_WINDOW_MS) seenRecently.delete(k);
}, 30_000);

// helpers ---------------------------------------------------------------
const ci = (s='') => s.toLowerCase().trim();

function getEventData() {
  if (!events[currentEvent])
    events[currentEvent] = { deathCounts:{}, lootTotals:{}, gpTotal:{} };
  return events[currentEvent];
}

function saveJSON(file, data) {
  const p = path.join(__dirname, file);
  fs.mkdirSync(path.dirname(p), { recursive:true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

async function commitToGitHub() {
  if (!GITHUB_PAT) return;
  const git = simpleGit();
  await git.add(".");
  await git.commit(COMMIT_MSG);
  await git.push(`https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`, BRANCH);
}

// load stored clan list --------------------------------------------------
try {
  const stored = JSON.parse(fs.readFileSync(path.join(__dirname,"data/registered.json")));
  if (Array.isArray(stored)) stored.forEach(n=>registeredNames.add(ci(n)));
  console.log(`Loaded ${registeredNames.size} registered clan names`);
} catch {/* first run – no file yet */}

// ──────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);

  /* ---------- /logKill ---------------------------------------------- */
  app.post("/logKill", async (req,res)=>{
    const { killer, victim } = req.body || {};
    if (!killer || !victim) return res.status(400).send("Missing killer or victim");

    if (clanOnlyMode &&
        (!registeredNames.has(ci(killer)) || !registeredNames.has(ci(victim))))
      return res.status(200).send("Ignored non-clan kill");

    // ----- de-dupe
    const key = `K|${ci(killer)}|${ci(victim)}`;
    if (seenRecently.has(key) && Date.now() - seenRecently.get(key) < DEDUP_WINDOW_MS)
      return res.status(200).send("Duplicate kill suppressed");
    seenRecently.set(key, Date.now());
    // ------------------------------------------

    const { deathCounts } = getEventData();
    deathCounts[ci(victim)] = (deathCounts[ci(victim)] || 0) + 1;

    const embed = new EmbedBuilder()
      .setTitle("💀 Kill Logged")
      .setDescription(`**${killer}** killed **${victim}**`)
      .addFields({ name:"Total Deaths", value:String(deathCounts[ci(victim)]), inline:true })
      .setColor(0xFF0000)
      .setTimestamp();

    try {
      const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
      if (ch?.isTextBased()) await ch.send({ embeds:[embed] });
    } catch(e){ console.error("Discord send error (kill):", e); }

    res.status(200).send("Kill logged");
  });

  /* ---------- /logLoot ---------------------------------------------- */
  app.post("/logLoot", async (req,res)=>{
    const { lootMessage } = req.body || {};
    if (!lootMessage) return res.status(400).send("Missing loot message");

    const rx=/(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\(([\d,]+)\s+coins\).*/i;
    const m = lootMessage.match(rx);
    if (!m) return res.status(400).send("Invalid loot message format");

    const [, killer, victim, gpStr] = m;
    if (clanOnlyMode &&
        (!registeredNames.has(ci(killer)) || !registeredNames.has(ci(victim))))
      return res.status(200).send("Ignored non-clan loot");

    // ----- de-dupe
    const key = `L|${lootMessage.trim()}`;
    if (seenRecently.has(key) && Date.now() - seenRecently.get(key) < DEDUP_WINDOW_MS)
      return res.status(200).send("Duplicate loot suppressed");
    seenRecently.set(key, Date.now());
    // ------------------------------------------

    const gp = Number(gpStr.replace(/,/g,""));
    const { lootTotals, gpTotal } = getEventData();
    lootTotals[ci(killer)] = (lootTotals[ci(killer)] || 0) + gp;
    gpTotal  [ci(killer)] = (gpTotal  [ci(killer)] || 0) + gp;
    chatKillCounts[ci(killer)] = (chatKillCounts[ci(killer)] || 0) + 1;

    const embed = new EmbedBuilder()
      .setTitle("💰 Loot Detected")
      .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
      .addFields({
        name:"Event GP Gained",
        value:`${lootTotals[ci(killer)].toLocaleString()} coins`,
        inline:true
      })
      .setColor(0xFF0000)   // red stripe
      .setTimestamp();

    try {
      const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
      if (ch?.isTextBased()) await ch.send({ embeds:[embed] });
    } catch(e){ console.error("Discord send error (loot):", e); }

    res.status(200).send("Loot logged");
  });

  app.listen(3000, ()=>console.log("HTTP listening on 3000"));
});

// -----------------------------------------------------------------------
//  >>>  keep all your existing command handlers here  <<<
//  ( !hiscores, !lootboard, !createEvent, !finishEvent, !help, etc. )
// -----------------------------------------------------------------------

client.login(DISCORD_BOT_TOKEN);
