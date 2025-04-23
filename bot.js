// bot.js  ────────────────────────────────────────────────────────────────
// core libs
const express    = require("express");
const bodyParser = require("body-parser");
const {
  Client, GatewayIntentBits, EmbedBuilder, Events
} = require("discord.js");
const fs         = require("fs");
const path       = require("path");
const simpleGit  = require("simple-git");
require("dotenv").config();

// ─────── environment ────────────────────────────────────────────────────
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const GITHUB_PAT = process.env.GITHUB_PAT ?? "";                // optional
const REPO   = "craigmuzza/monday-madness-bot";
const BRANCH = "main";
const COMMIT_MSG = "Automated event / clan update";

// ─────── constants ──────────────────────────────────────────────────────
const DEDUP_WINDOW_MS = 10_000;   // 10-second anti-spam window
const RED   = 0xFF0000;
const GOLD  = 0xFFD700;

// ─────── helpers ────────────────────────────────────────────────────────
const ci = (s = "") => s.toLowerCase().trim();          // case-insensitive key
const now = () => Date.now();

function saveJSON(relPath, obj) {
  const file = path.join(__dirname, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

async function commitGit() {
  if (!GITHUB_PAT) return;                               // skip if PAT absent
  const git = simpleGit();
  await git.add(".");
  await git.commit(COMMIT_MSG);
  await git.push(
    `https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`,
    BRANCH
  );
}

// ─────── load persistent clan list ──────────────────────────────────────
let registeredNames = new Set();
try {
  const stored = JSON.parse(
    fs.readFileSync(path.join(__dirname, "data/registered.json"))
  );
  if (Array.isArray(stored)) stored.forEach((n) => registeredNames.add(ci(n)));
  console.log(`Loaded ${registeredNames.size} registered names`);
} catch {
  /* first run – no file yet */
}

// ─────── in-memory state ────────────────────────────────────────────────
let currentEvent = "default";
let clanOnlyMode = false;
let chatKillCounts = {}; // kills counted from loot lines

const events = {
  default: { deathCounts: {}, lootTotals: {}, gpTotal: {} },
};

function getEvent() {
  if (!events[currentEvent]) {
    events[currentEvent] = { deathCounts: {}, lootTotals: {}, gpTotal: {} };
  }
  return events[currentEvent];
}

// ─────── de-duplication cache ───────────────────────────────────────────
const seenRecently = new Map(); // key → timestamp
setInterval(() => {
  const ts = now();
  for (const [k, t] of seenRecently)
    if (ts - t > DEDUP_WINDOW_MS) seenRecently.delete(k);
}, 30_000);

// ─────── Discord client ─────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─────── Express API ────────────────────────────────────────────────────
const app = express();
app.use(bodyParser.json());

// /logKill ----------------------------------------------------------------
app.post("/logKill", async (req, res) => {
  const { killer, victim } = req.body ?? {};
  if (!killer || !victim) return res.status(400).send("Missing killer/victim");

  if (
    clanOnlyMode &&
    (!registeredNames.has(ci(killer)) || !registeredNames.has(ci(victim)))
  )
    return res.status(200).send("Ignored non-clan kill");

  const dedupKey = `K|${ci(killer)}|${ci(victim)}`;
  if (seenRecently.has(dedupKey) && now() - seenRecently.get(dedupKey) < DEDUP_WINDOW_MS)
    return res.status(200).send("Duplicate kill suppressed");
  seenRecently.set(dedupKey, now());

  const { deathCounts } = getEvent();
  deathCounts[ci(victim)] = (deathCounts[ci(victim)] || 0) + 1;

  const embed = new EmbedBuilder()
    .setTitle("💀 Kill Logged")
    .setDescription(`**${killer}** killed **${victim}**`)
    .addFields({
      name: "Total Deaths",
      value: String(deathCounts[ci(victim)]),
      inline: true,
    })
    .setColor(RED)
    .setTimestamp();

  try {
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (channel?.isTextBased()) await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error("Discord send error:", e);
  }

  res.status(200).send("Kill logged");
});

// /logLoot ----------------------------------------------------------------
app.post("/logLoot", async (req, res) => {
  const { lootMessage } = req.body ?? {};
  if (!lootMessage) return res.status(400).send("Missing lootMessage");

  const lootRegex =
    /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\(([\d,]+)\s+coins\).*/i;
  const m = lootMessage.match(lootRegex);
  if (!m) return res.status(400).send("Invalid loot format");

  const [, killer, victim, gpStr] = m;

  if (
    clanOnlyMode &&
    (!registeredNames.has(ci(killer)) || !registeredNames.has(ci(victim)))
  )
    return res.status(200).send("Ignored non-clan loot");

  const dedupKey = `L|${lootMessage.trim()}`;
  if (seenRecently.has(dedupKey) && now() - seenRecently.get(dedupKey) < DEDUP_WINDOW_MS)
    return res.status(200).send("Duplicate loot suppressed");
  seenRecently.set(dedupKey, now());

  const gp = Number(gpStr.replace(/,/g, ""));
  const { lootTotals, gpTotal } = getEvent();
  lootTotals[ci(killer)] = (lootTotals[ci(killer)] || 0) + gp;
  gpTotal[ci(killer)] = (gpTotal[ci(killer)] || 0) + gp;
  chatKillCounts[ci(killer)] = (chatKillCounts[ci(killer)] || 0) + 1;

  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(
      `**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`
    )
    .addFields({
      name: "Event GP Gained",
      value: `${lootTotals[ci(killer)].toLocaleString()} coins`,
      inline: true,
    })
    .setColor(GOLD)
    .setTimestamp();

  try {
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (channel?.isTextBased()) await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error("Discord send error:", e);
  }

  res.status(200).send("Loot logged");
});

// ─────── Express listener ───────────────────────────────────────────────
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  app.listen(3000, () => console.log("HTTP listening on 3000"));
});

// ─────── Discord command handlers ───────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();

  const { deathCounts, lootTotals } = getEvent();

  // !hiscores ------------------------------------------------------------
  if (content === "!hiscores") {
    const kd = Object.entries(chatKillCounts).map(([n, k]) => {
      const d = deathCounts[n] || 0;
      const ratio = d === 0 ? k : (k / d).toFixed(2);
      return { n, k, d, ratio };
    });
    kd.sort((a, b) => b.k - a.k).splice(10); // top 10

    const embed = new EmbedBuilder()
      .setTitle("🏆 Monday Madness Hiscores 🏆")
      .setColor(RED)
      .setTimestamp();

    if (kd.length === 0) {
      embed.setDescription("No kills recorded yet.");
    } else {
      kd.forEach((e, i) =>
        embed.addFields({
          name: `${i + 1}. ${e.n}`,
          value: `Kills: ${e.k} | Deaths: ${e.d} | K/D: ${e.ratio}`,
          inline: false,
        })
      );
    }
    return void message.channel.send({ embeds: [embed] });
  }

  // !lootboard -----------------------------------------------------------
  if (content === "!lootboard") {
    const sorted = Object.entries(lootTotals).sort((a, b) => b[1] - a[1]).splice(10);

    const embed = new EmbedBuilder()
      .setTitle("💰 Top Loot Earners 💰")
      .setColor(RED)
      .setTimestamp();

    if (sorted.length === 0) {
      embed.setDescription("No loot recorded yet.");
    } else {
      sorted.forEach(([n, gp], i) =>
        embed.addFields({
          name: `${i + 1}. ${n}`,
          value: `${gp.toLocaleString()} coins`,
          inline: false,
        })
      );
    }
    return void message.channel.send({ embeds: [embed] });
  }

  // !listEvents ----------------------------------------------------------
  if (content === "!listEvents") {
    const embed = new EmbedBuilder()
      .setTitle("📅 Available Events")
      .setDescription(
        Object.keys(events)
          .map((e) => `• ${e}${e === currentEvent ? " *(current)*" : ""}`)
          .join("\n")
      )
      .setColor(RED)
      .setTimestamp();
    return void message.channel.send({ embeds: [embed] });
  }

  // !createEvent <name> ---------------------------------------------------
  if (content.startsWith("!createEvent ")) {
    const name = content.slice("!createEvent ".length).trim();
    if (!name || events[name])
      return void message.reply("Invalid or duplicate event name.");
    events[name] = { deathCounts: {}, lootTotals: {}, gpTotal: {} };
    currentEvent = name;
    return void message.reply(`Event **${name}** created and selected.`);
  }

  // !finishEvent ----------------------------------------------------------
  if (content === "!finishEvent") {
    const filename = `events/event_${currentEvent}_${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    saveJSON(filename, events[currentEvent]);
    await commitGit();

    delete events[currentEvent];
    currentEvent = "default";

    const embed = new EmbedBuilder()
      .setTitle("📦 Event Finalised")
      .setDescription(`Saved as \`${filename}\` and switched to **default**.`)
      .setColor(RED)
      .setTimestamp();
    return void message.channel.send({ embeds: [embed] });
  }

  // !register a,b,c -------------------------------------------------------
  if (content.startsWith("!register ")) {
    const names = content
      .slice("!register ".length)
      .split(",")
      .map((s) => ci(s))
      .filter(Boolean);
    names.forEach((n) => registeredNames.add(n));
    saveJSON("data/registered.json", Array.from(registeredNames));
    await commitGit();
    return void message.reply(`Registered: ${names.join(", ")}`);
  }

  // !unregister a,b -------------------------------------------------------
  if (content.startsWith("!unregister ")) {
    const names = content
      .slice("!unregister ".length)
      .split(",")
      .map((s) => ci(s))
      .filter(Boolean);
    names.forEach((n) => registeredNames.delete(n));
    saveJSON("data/registered.json", Array.from(registeredNames));
    await commitGit();
    return void message.reply(`Unregistered: ${names.join(", ")}`);
  }

  // !clanOnly on/off ------------------------------------------------------
  if (content === "!clanOnly on") {
    clanOnlyMode = true;
    return void message.reply("Clan-only mode **enabled**.");
  }
  if (content === "!clanOnly off") {
    clanOnlyMode = false;
    return void message.reply("Clan-only mode **disabled**.");
  }

  // !help -----------------------------------------------------------------
  if (content === "!help") {
    const embed = new EmbedBuilder()
      .setTitle("🛠 Robo-Rat – Help")
      .addFields(
        { name: "📊 Stats", value: "`!hiscores`, `!lootboard`", inline: false },
        {
          name: "🎯 Events",
          value: "`!createEvent <name>`, `!finishEvent`, `!listEvents`",
          inline: false,
        },
        {
          name: "👥 Clan",
          value: "`!register <names>`, `!unregister <names>`, `!clanOnly on/off`",
          inline: false,
        },
        { name: "❓ Help", value: "`!help`", inline: false }
      )
      .setColor(RED)
      .setTimestamp();
    return void message.channel.send({ embeds: [embed] });
  }
});

// ─────── start bot ──────────────────────────────────────────────────────
client.login(DISCORD_BOT_TOKEN);
