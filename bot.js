// bot.js
import express from "express";
import multer from "multer";
import { fileURLToPath } from "url";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
  AttachmentBuilder,
  Collection
} from "discord.js";
import fs from "fs";
import path from "path";
import simpleGit from "simple-git";
import dotenv from "dotenv";
dotenv.config();

// ── __dirname for ESM ────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Environment ───────────────────────────────────────────────
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT = process.env.GITHUB_PAT;
const REPO = "craigmuzza/monday-madness-bot";
const BRANCH = "main";
const COMMIT_MSG = "auto: sync data";

// ── Constants & Regex ─────────────────────────────────────────
const DEDUP_MS = 10_000;
const COMMAND_COOLDOWN = 3000;
const BACKUP_INTERVAL = 5 * 60 * 1000;
const LOOT_RE = /^(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\( *([\d,]+) *coins\).*$/i;

// ── Express + Multer setup ────────────────────────────────────
const app = express();
const upload = multer();

app.use(express.json());
app.use(express.text({ type: "text/*" }));

// ── Discord client ────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ── Bot state & storage ───────────────────────────────────────
let currentEvent = "default";
let clanOnlyMode = false;
const registered = new Set();
const seen = new Map();
const events = {
  default: { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} }
};
const commandCooldowns = new Collection();
const killLog = [];
const lootLog = [];

const ci = s => (s || "").toLowerCase().trim();
const now = () => Date.now();

// ── Data persistence helpers ─────────────────────────────────────
function saveData() {
  try {
    const dataDir = path.join(__dirname, "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(
      path.join(dataDir, "state.json"),
      JSON.stringify({
        currentEvent,
        clanOnlyMode,
        events,
        killLog,
        lootLog
      }, null, 2)
    );

    fs.writeFileSync(
      path.join(dataDir, "registered.json"),
      JSON.stringify([...registered], null, 2)
    );

    commitToGitHub().catch(console.error);
  } catch (err) {
    console.error("[save] Failed to save data:", err);
  }
}

// ── Load persisted data ──────────────────────────────────────────
function loadData() {
  try {
    const regPath = path.join(__dirname, "data/registered.json");
    if (fs.existsSync(regPath)) {
      const arr = JSON.parse(fs.readFileSync(regPath));
      if (Array.isArray(arr)) arr.forEach(n => registered.add(ci(n)));
      console.log(`[init] loaded ${registered.size} registered names`);
    }

    const statePath = path.join(__dirname, "data/state.json");
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath));
      currentEvent = state.currentEvent || "default";
      clanOnlyMode = state.clanOnlyMode || false;
      Object.assign(events, state.events || {});
      killLog.push(...(state.killLog || []));
      lootLog.push(...(state.lootLog || []));
      console.log("[init] loaded saved state");
    }
  } catch (err) {
    console.error("[init] Failed to load data:", err);
  }
}

// ── Command rate limiting ─────────────────────────────────────────
function checkCooldown(userId) {
  if (commandCooldowns.has(userId)) {
    const expirationTime = commandCooldowns.get(userId) + COMMAND_COOLDOWN;
    if (now() < expirationTime) {
      return false;
    }
  }
  commandCooldowns.set(userId, now());
  return true;
}

// ── GitHub commit helper ───────────────────────────────────────────
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
    console.log("[git] Successfully pushed changes");
  } catch (err) {
    console.error("[git] Failed to push:", err);
  }
}

// ── Ensure current event data exists ───────────────────────────────
function getEventData() {
  if (!events[currentEvent]) {
    events[currentEvent] = { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} };
  }
  return events[currentEvent];
}

// ── Core loot processor ────────────────────────────────────────────
async function processLoot(killer, victim, gp, dedupKey, res) {
  try {
    if (!killer || !victim || typeof gp !== 'number' || isNaN(gp)) {
      return res.status(400).send("invalid data");
    }

    if (clanOnlyMode && (!registered.has(ci(killer)) || !registered.has(ci(victim)))) {
      return res.status(200).send("non-clan ignored");
    }

    if (seen.has(dedupKey) && now() - seen.get(dedupKey) < DEDUP_MS) {
      return res.status(200).send("duplicate");
    }

    seen.set(dedupKey, now());

    const { lootTotals, gpTotal, kills } = getEventData();
    lootTotals[ci(killer)] = (lootTotals[ci(killer)] || 0) + gp;
    gpTotal[ci(killer)] = (gpTotal[ci(killer)] || 0) + gp;
    kills[ci(killer)] = (kills[ci(killer)] || 0) + 1;

    lootLog.push({ killer, gp, timestamp: now() });

    const label = currentEvent === "default" ? "Total GP Earned" : "Event GP Gained";

    const embed = new EmbedBuilder()
      .setTitle("💰 Loot Detected")
      .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
      .addFields({ name: label, value: `${(currentEvent === "default" ? gpTotal[ci(killer)] : lootTotals[ci(killer)]).toLocaleString()} coins`, inline: true })
      .setColor(0xFF0000)
      .setTimestamp();

    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (ch?.isTextBased()) {
      await ch.send({ embeds: [embed] }).catch(err => 
        console.error("[discord] Failed to send loot embed:", err)
      );
    }

    saveData();
    return res.status(200).send("ok");
  } catch (err) {
    console.error("[processLoot] Error:", err);
    return res.status(500).send("internal error");
  }
}

// ── Core kill processor ────────────────────────────────────────────
async function processKill(killer, victim, dedupKey, res) {
  try {
    if (!killer || !victim) {
      return res.status(400).send("invalid data");
    }

    if (clanOnlyMode && (!registered.has(ci(killer)) || !registered.has(ci(victim)))) {
      return res.status(200).send("non-clan ignored");
    }

    if (seen.has(dedupKey) && now() - seen.get(dedupKey) < DEDUP_MS) {
      return res.status(200).send("duplicate");
    }

    seen.set(dedupKey, now());

    const { deathCounts, kills } = getEventData();
    deathCounts[ci(victim)] = (deathCounts[ci(victim)] || 0) + 1;
    kills[ci(killer)] = (kills[ci(killer)] || 0) + 1;

    killLog.push({ killer, victim, timestamp: now() });

    const embed = new EmbedBuilder()
      .setTitle("💀 Kill Logged")
      .setDescription(`**${killer}** killed **${victim}**`)
      .addFields({ name: "Total Deaths", value: String(deathCounts[ci(victim)]), inline: true })
      .setColor(0xFF0000)
      .setTimestamp();

    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (ch?.isTextBased()) {
      await ch.send({ embeds: [embed] }).catch(err => 
        console.error("[discord] Failed to send kill embed:", err)
      );
    }

    saveData();
    return res.status(200).send("ok");
  } catch (err) {
    console.error("[processKill] Error:", err);
    return res.status(500).send("internal error");
  }
}

// ── HTTP Endpoints ────────────────────────────────────────────

app.post("/logLoot", (req, res) => {
  const txt = req.body?.lootMessage;
  if (!txt) return res.status(400).send("bad");
  const m = txt.match(LOOT_RE);
  if (!m) return res.status(400).send("fmt");
  return processLoot(m[1], m[2], Number(m[3].replace(/,/g, "")), txt.trim(), res);
});

app.post("/logKill", async (req, res) => {
  const { killer, victim } = req.body || {};
  if (!killer || !victim) return res.status(400).send("bad data");
  return processKill(killer, victim, `K|${ci(killer)}|${ci(victim)}`, res);
});

app.post(
  "/dink",
  upload.fields([
    { name: "payload_json", maxCount: 1 },
    { name: "file", maxCount: 1 }
  ]),
  async (req, res) => {
    let raw = req.body.payload_json;
    if (Array.isArray(raw)) raw = raw[0];
    if (!raw) return res.status(400).send("no payload_json");
    
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(400).send("bad JSON");
    }

    const rsn = data.playerName;
    const msg = data.extra?.message;
    if (typeof msg === "string") {
      console.log(`[dink] seen by=${rsn} | message=${msg}`);
    }

    if (
      data.type === "CHAT" &&
      (data.extra?.type === "CLAN_CHAT" || data.extra?.type === "CLAN_MESSAGE") &&
      typeof msg === "string"
    ) {
      const m = msg.match(LOOT_RE);
      if (m) return processLoot(m[1], m[2], Number(m[3].replace(/,/g, "")), msg.trim(), res);
    }
    return res.status(204).end();
  }
);

// ── Helpers for time-based leaderboards ─────────────────────────
function filterByPeriod(log, period) {
  const cutoff = {
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
    monthly: 30 * 24 * 60 * 60 * 1000,
    all: Infinity
  }[period] || Infinity;
  if (cutoff === Infinity) return log;
  const nowTs = now();
  return log.filter(e => nowTs - e.timestamp <= cutoff);
}

// ── CSV export utility ─────────────────────────────────────────
function toCSV(rows, headers) {
  const esc = v => `"${String(v).replace(/"/g, '""')}"`;
  return [headers.join(","), ...rows.map(r => headers.map(h => esc(r[h])).join(","))].join("\n");
}

// ── Discord commands ───────────────────────────────────────────
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  
  // Rate limit check
  if (!checkCooldown(msg.author.id)) {
    return msg.reply("Please wait a few seconds between commands.").catch(console.error);
  }

  const text = msg.content.trim();
  const lc = text.toLowerCase();
  const args = text.split(/\s+/);
  const cmd = args.shift().toLowerCase();

  try {
    // ── !hiscores [period] ───────────────────────────────────────
    if (cmd === "!hiscores") {
      let period = "all";
      if (args[0] && ["daily", "weekly", "monthly", "all"].includes(args[0].toLowerCase())) {
        period = args.shift().toLowerCase();
      }
      const nameFilter = args.join(" ").toLowerCase() || null;

      const filtered = filterByPeriod(killLog, period);
      const counts = {};
      filtered.forEach(({ killer }) => {
        const k = killer.toLowerCase();
        if (nameFilter && k !== nameFilter) return;
        counts[k] = (counts[k] || 0) + 1;
      });
      const board = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([n, k], i) => ({ rank: i + 1, name: n, kills: k }));

      const embed = new EmbedBuilder()
        .setTitle(`🏆 Hiscores (${period})`)
        .setColor(0xFF0000)
        .setTimestamp();
      if (board.length === 0) embed.setDescription("No kills in that period.");
      else board.forEach(e =>
        embed.addFields({ name: `${e.rank}. ${e.name}`, value: `Kills: ${e.kills}`, inline: false })
      );
      return msg.channel.send({ embeds: [embed] });
    }

	// ── !totalloot ───────────────────────────────────────────────
	if (cmd === "!totalgp") {
	// get the per-user GP totals for the current event
		const { gpTotal } = getEventData();
	// sum them up
		const totalGP = Object.values(gpTotal).reduce((sum, gp) => sum + gp, 0);

	// build and send an embed
		const embed = new EmbedBuilder()
			.setTitle("💰 Total Loot")
			.setDescription(`Total GP across all players: **${totalGP.toLocaleString()}** coins`)
			.setColor(0xFF0000)
			.setTimestamp();

		return msg.channel.send({ embeds: [embed] });
}

    // ── !lootboard [period] ──────────────────────────────────────
    if (cmd === "!lootboard") {
      let period = "all";
      if (args[0] && ["daily", "weekly", "monthly", "all"].includes(args[0].toLowerCase())) {
        period = args.shift().toLowerCase();
      }
      const nameFilter = args.join(" ").toLowerCase() || null;

      const filtered = filterByPeriod(lootLog, period);
      const sums = {};
      filtered.forEach(({ killer, gp }) => {
        const k = killer.toLowerCase();
        if (nameFilter && k !== nameFilter) return;
        sums[k] = (sums[k] || 0) + gp;
      });
      const board = Object.entries(sums)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([n, gp], i) => ({ rank: i + 1, name: n, gp }));

      const embed = new EmbedBuilder()
        .setTitle(`💰 Lootboard (${period})`)
        .setColor(0xFF0000)
        .setTimestamp();
      if (board.length === 0) embed.setDescription("No loot in that period.");
      else board.forEach(e =>
        embed.addFields({ name: `${e.rank}. ${e.name}`, value: `${e.gp.toLocaleString()} coins`, inline: false })
      );
      return msg.channel.send({ embeds: [embed] });
    }

    // ── !export hiscores|lootboard [period] ──────────────────────
    if (cmd === "!export") {
      const what = args.shift()?.toLowerCase();
      const period = args.shift()?.toLowerCase() || "all";
      if (!["hiscores", "lootboard"].includes(what)) {
        return msg.reply("Usage: !export hiscores|lootboard [daily|weekly|monthly|all]");
      }

      let rows, headers;
      if (what === "hiscores") {
        const filtered = filterByPeriod(killLog, period);
        const counts = {};
        filtered.forEach(({ killer }) => counts[killer] = (counts[killer] || 0) + 1);
        rows = Object.entries(counts).map(([n, k]) => ({ name: n, kills: k }));
        headers = ["name", "kills"];
      } else {
        const filtered = filterByPeriod(lootLog, period);
        const sums = {};
        filtered.forEach(({ killer, gp }) => sums[killer] = (sums[killer] || 0) + gp);
        rows = Object.entries(sums).map(([n, gp]) => ({ name: n, gp }));
        headers = ["name", "gp"];
      }
      const csv = toCSV(rows, headers);
      const buffer = Buffer.from(csv, "utf8");
      const file = new AttachmentBuilder(buffer, { name: `${what}-${period}.csv` });
      return msg.channel.send({ files: [file] });
    }

    // ── !listclan ─────────────────────────────────────────────────
    if (cmd === "!listclan") {
      if (registered.size === 0) return msg.reply("No one registered yet.");
      return msg.reply(`Registered clan members: ${[...registered].join(", ")}`);
    }

    // ── !register / !unregister ──────────────────────────────────
    if (cmd === "!register" || cmd === "!unregister") {
      const names = text.slice(cmd.length + 1).split(",").map(ci).filter(Boolean);
      if (!names.length) return msg.reply("Provide one or more comma-separated names.");
      names.forEach(n => {
        if (cmd === "!register") registered.add(n);
        else registered.delete(n);
      });
      fs.writeFileSync(
        path.join(__dirname, "data/registered.json"),
        JSON.stringify([...registered], null, 2)
      );
      await commitToGitHub();
      return msg.reply(`${cmd === "!register" ? "Added" : "Removed"}: ${names.join(", ")}`);
    }

    // ── !clanonly on/off ─────────────────────────────────────────
    if (lc === "!clanonly on") {
      clanOnlyMode = true;
      saveData();
      return msg.reply("Clan-only mode ✅");
    }
    if (lc === "!clanonly off") {
      clanOnlyMode = false;
      saveData();
      return msg.reply("Clan-only mode ❌");
    }

    // ── Event commands ────────────────────────────────────────────
    if (lc === "!listevents") {
      return msg.channel.send({
        embeds: [new EmbedBuilder()
          .setTitle("📅 Events")
          .setDescription(Object.keys(events).map(e => `• ${e}${e === currentEvent ? " (current)" : ""}`).join("\n"))
          .setColor(0xFF0000)
        ]
      });
    }

    if (lc.startsWith("!createevent ")) {
      const name = text.slice(13).trim();
      if (!name || events[name]) return msg.reply("Invalid or duplicate event name.");
      events[name] = { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} };
      currentEvent = name;
      saveData();
      return msg.reply(`Event **${name}** created & selected.`);
    }

    if (lc === "!finishevent") {
      const file = `events/event_${currentEvent}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      fs.mkdirSync(path.dirname(path.join(__dirname, file)), { recursive: true });
      fs.writeFileSync(
        path.join(__dirname, file),
        JSON.stringify(events[currentEvent], null, 2)
      );
      await commitToGitHub();
      delete events[currentEvent];
      currentEvent = "default";
      saveData();
      return msg.reply(`Saved event to \`${file}\`, back to default.`);
    }

    // ── !help ─────────────────────────────────────────────────────
    if (lc === "!help") {
      const embed = new EmbedBuilder()
        .setTitle("🛠 Robo-Rat Help")
        .setColor(0xFF0000)
        .addFields(
          { name: "Stats", value: "`!hiscores [daily|weekly|monthly|all] [name]`, `!lootboard [period] [name]`, `!totalgp`", inline: false },
          { name: "Export CSV", value: "`!export hiscores|lootboard [period]`", inline: false },
          { name: "Clan", value: "`!register <n1,n2>`, `!unregister <n1,n2>`, `!listclan`, `!clanonly on/off`", inline: false },
          { name: "Events", value: "`!createevent <name>`, `!finishevent`, `!listevents`", inline: false },
          { name: "Misc", value: "`!help`", inline: false }
        );
      return msg.channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error("[command] Error processing command:", cmd, err);
    return msg.reply("An error occurred while processing your command.").catch(console.error);
  }
});

// ── Automatic backup ────────────────────────────────────────────
setInterval(saveData, BACKUP_INTERVAL);

// ── Initial data load ───────────────────────────────────────────
loadData();

// ── Clean up old seen entries periodically ─────────────────────
setInterval(() => {
  const nowTs = now();
  for (const [key, timestamp] of seen.entries()) {
    if (nowTs - timestamp > DEDUP_MS * 2) {
      seen.delete(key);
    }
  }
}, DEDUP_MS);

// ── Start server once Discord is ready ──────────────────────────
client.once("ready", () => {
  console.log(`[discord] ready: ${client.user.tag}`);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[http] listening on ${port}`));
});

// ── Error handling for Discord client ─────────────────────────────
client.on("error", error => {
  console.error("[discord] Client error:", error);
});

client.on("disconnect", () => {
  console.log("[discord] Client disconnected");
});

// ── Login ───────────────────────────────────────────────────────
client.login(DISCORD_BOT_TOKEN).catch(err => {
  console.error("[discord] Failed to login:", err);
  process.exit(1);
});