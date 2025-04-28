// bot.js
import express from "express";
import { spawnSync } from "child_process";
import multer from "multer";
import { fileURLToPath } from "url";
import path from "path";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
  AttachmentBuilder,
  Collection
} from "discord.js";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ── __dirname for ESM ────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Persistent data directory (Render volume) ───────────────
const DATA_DIR = "/data";

// ── Ensure correct origin remote ──────────────────────────────
;(function fixOrigin() {
  try {
    const res = spawnSync("git", [
      "remote", "set-url", "origin",
      "https://github.com/Craigmuzza/monday-madness-bot.git"
    ], { cwd: __dirname, stdio: "inherit" });
    console.log(res.status === 0
      ? "[git] origin remote set to correct URL"
      : "[git] failed to set origin remote");
  } catch (err) {
    console.error("[git] error setting origin remote:", err);
  }
})();

// ── Configure Git user for commits (Render doesn’t set these) ─
;(function setGitIdentity() {
  try {
    spawnSync("git", ["config", "user.email", "bot@localhost"], { cwd: __dirname });
    spawnSync("git", ["config", "user.name",  "Robo-Rat Bot"],    { cwd: __dirname });
    console.log("[git] configured local user.name & user.email");
  } catch (err) {
    console.error("[git] error setting git identity:", err);
  }
})();

// ── Environment ───────────────────────────────────────────────
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT         = process.env.GITHUB_PAT;
const REPO               = "craigmuzza/monday-madness-bot";
const BRANCH             = "main";
const COMMIT_MSG         = "auto: sync data";

// ── Constants & Regex ─────────────────────────────────────────
const DEDUP_MS         = 10_000;
const COMMAND_COOLDOWN = 3_000;
const BACKUP_INTERVAL  = 5 * 60 * 1000;
const LOOT_RE = /^(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\( *([\d,]+) *coins\).*$/i;

// ── Express + Multer setup ────────────────────────────────────
const app    = express();
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
const seen       = new Map();
const events     = {
  default: { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} }
};
const commandCooldowns = new Collection();
const killLog = [];
const lootLog = [];

// ── Helpers ───────────────────────────────────────────────────
const ci  = s => (s||"").toLowerCase().trim();
const now = () => Date.now();

// ── Send an embed to a channel ────────────────────────────────
function sendEmbed(channel, title, desc, color = 0xFF0000) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor(color)
    .setTimestamp();
  return channel.send({ embeds: [embed] });
}

// ── GitHub commit helper ───────────────────────────────────────
function commitToGitHub() {
  if (!GITHUB_PAT) return;

  let res = spawnSync("git", ["add", "."], { cwd: __dirname, stdio: "inherit" });
  if (res.status !== 0) {
    console.error("[git] Failed to stage changes");
    return;
  }

  res = spawnSync("git", ["commit", "-m", COMMIT_MSG], { cwd: __dirname, stdio: "inherit" });
  if (res.status !== 0) {
    console.warn("[git] No changes to commit");
  }

  const url = `https://x-access-token:${GITHUB_PAT}@github.com/${REPO}.git`;
  res = spawnSync("git", ["push", url, BRANCH], { cwd: __dirname, stdio: "inherit" });
  if (res.status !== 0) {
    console.error("[git] Push failed—check your PAT and URL");
    return;
  }

  console.log("[git] Successfully pushed changes");
}

// ── Save & Load data ──────────────────────────────────────────
function saveData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    fs.writeFileSync(
      path.join(DATA_DIR, "state.json"),
      JSON.stringify({ currentEvent, clanOnlyMode, events, killLog, lootLog }, null, 2)
    );
    fs.writeFileSync(
      path.join(DATA_DIR, "registered.json"),
      JSON.stringify([...registered], null, 2)
    );

    commitToGitHub();
  } catch (err) {
    console.error("[save] Failed to save data:", err);
  }
}

function loadData() {
  try {
    const regPath = path.join(DATA_DIR, "registered.json");
    if (fs.existsSync(regPath)) {
      const arr = JSON.parse(fs.readFileSync(regPath));
      if (Array.isArray(arr)) arr.forEach(n => registered.add(ci(n)));
      console.log(`[init] loaded ${registered.size} registered names`);
    }

    const statePath = path.join(DATA_DIR, "state.json");
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

// ── Rate limiting ─────────────────────────────────────────────
function checkCooldown(userId) {
  if (commandCooldowns.has(userId)) {
    const expires = commandCooldowns.get(userId) + COMMAND_COOLDOWN;
    if (now() < expires) return false;
  }
  commandCooldowns.set(userId, now());
  return true;
}

// ── Ensure event bucket exists ─────────────────────────────────
function getEventData() {
  if (!events[currentEvent]) {
    events[currentEvent] = { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} };
  }
  return events[currentEvent];
}

// ── Core processors ───────────────────────────────────────────
async function processLoot(killer, victim, gp, dedupKey, res) {
  try {
    if (!killer||!victim||typeof gp!=="number"||isNaN(gp)) {
      return res.status(400).send("invalid data");
    }
    if (seen.has(dedupKey) && now()-seen.get(dedupKey)<DEDUP_MS) {
      return res.status(200).send("duplicate");
    }
    seen.set(dedupKey, now());

    const isClan = registered.has(ci(killer)) && registered.has(ci(victim));
    const { lootTotals, gpTotal, kills, deathCounts } = getEventData();

    // update loot stats
    lootTotals[ci(killer)] = (lootTotals[ci(killer)]||0) + gp;
    gpTotal  [ci(killer)]  = (gpTotal  [ci(killer)]||0) + gp;
    kills     [ci(killer)]  = (kills     [ci(killer)]||0) + 1;
    lootLog.push({ killer, gp, timestamp: now(), isClan });
	
	// **record the kill** so !hiscores will pick it up
    deathCounts[ci(victim)] = (deathCounts[ci(victim)]||0) + 1;
    killLog.push({ killer, victim, timestamp: now(), isClan });

    // send embed...
    const embed = new EmbedBuilder()
      .setTitle(isClan ? "💎 Clan Loot Detected!" : "💰 Loot Detected")
      // ...
    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] });

    // auto-register killer if new...
    // save data...
    return res.status(200).send("ok");
  } catch (err) {
    console.error("[processLoot] Error:", err);
    return res.status(500).send("internal error");
  }
}

async function processKill(killer, victim, dedupKey, res) {
  try {
    if (!killer||!victim) {
      return res.status(400).send("invalid data");
    }
    if (seen.has(dedupKey) && now()-seen.get(dedupKey)<DEDUP_MS) {
      return res.status(200).send("duplicate");
    }
    seen.set(dedupKey, now());

    const isClan = registered.has(ci(killer)) && registered.has(ci(victim));
    const { deathCounts, kills } = getEventData();

    // update kill/death stats
    kills       [ci(killer)] = (kills       [ci(killer)]||0) + 1;
    deathCounts [ci(victim)] = (deathCounts [ci(victim)]||0) + 1;
    killLog.push({ killer, victim, timestamp: now(), isClan });

    const embed = new EmbedBuilder()
      .setTitle(isClan ? "✨ Clan Kill Logged!" : "💀 Kill Logged")
      // ...
    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] });

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
  return processLoot(
    m[1],
    m[2],
    Number(m[3].replace(/,/g, "")),
    txt.trim(),
    res
  );
});

app.post("/logKill", async (req, res) => {
  const { killer, victim } = req.body || {};
  if (!killer || !victim) return res.status(400).send("bad data");
  return processKill(
    killer,
    victim,
    `K|${ci(killer)}|${ci(victim)}`,
    res
  );
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

    const rsn = data.playerName,
          msg = data.extra?.message;
    if (typeof msg === "string")
      console.log(`[dink] seen by=${rsn}|msg=${msg}`);

    if (
      data.type === "CHAT" &&
      ["CLAN_CHAT", "CLAN_MESSAGE"].includes(data.extra?.type) &&
      typeof msg === "string"
    ) {
      const m = msg.match(LOOT_RE);
      if (m) return processLoot(m[1], m[2], Number(m[3].replace(/,/g, "")), msg.trim(), res);
    }
    return res.status(204).end();
  }
);


// ── Time & CSV helpers ─────────────────────────────────────────
function filterByPeriod(log, period) {
  const cutoffs = {
    daily:   24*60*60*1000,
    weekly:  7*24*60*60*1000,
    monthly:30*24*60*60*1000,
    all:     Infinity
  };
  const cutoff = cutoffs[period] ?? Infinity;
  if (cutoff === Infinity) return log;
  const nowTs = now();
  return log.filter(e => nowTs - e.timestamp <= cutoff);
}
function toCSV(rows, headers) {
  const esc = v => `"${String(v).replace(/"/g,'""')}"`;
  return [headers.join(","), ...rows.map(r => headers.map(h => esc(r[h])).join(","))].join("\n");
}

// ── Discord commands ─────────────────────────────────────────
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;

  const text = msg.content.trim();
  // Ignore everything that isn’t a command
  if (!text.startsWith("!")) return;

  // Now it's a command—apply rate-limit
  if (!checkCooldown(msg.author.id)) {
    return sendEmbed(msg.channel, "⏳ On Cooldown", "Please wait a few seconds between commands.");
  }

  const lc   = text.toLowerCase();
  const args = text.split(/\s+/);
  const cmd  = args.shift();
  
  try {
    // ── !hiscores ────────────────────────────────────────────────
    if (cmd === "!hiscores") {
      let period = "all";
      if (args[0] && ["daily","weekly","monthly","all"].includes(args[0].toLowerCase())) {
        period = args.shift().toLowerCase();
      }
      const nameFilter = args.join(" ").toLowerCase() || null;
      const all = filterByPeriod(killLog, period);
      const normal = all.filter(e => !e.isClan);
      const clan   = all.filter(e => e.isClan);

      const makeBoard = (arr) => {
        const counts = {};
        arr.forEach(({ killer }) => {
          const k = killer.toLowerCase();
          if (nameFilter && k !== nameFilter) return;
          counts[k] = (counts[k]||0) + 1;
        });
        return Object.entries(counts)
          .sort((a,b) => b[1] - a[1])
          .slice(0,10)
          .map(([n,v],i) => ({ rank:i+1, name:n, kills:v }));
      };

      const normalBoard = makeBoard(normal);
      const clanBoard   = makeBoard(clan);

      const e1 = new EmbedBuilder()
        .setTitle(`🏆 Hiscores (${period})`)
        .setColor(0xFF0000)
        .setTimestamp();
      if (!normalBoard.length) e1.setDescription("No kills in that period.");
      else normalBoard.forEach(r =>
        e1.addFields({ name:`${r.rank}. ${r.name}`, value:`Kills: ${r.kills}`, inline:false })
      );

      const e2 = new EmbedBuilder()
        .setTitle(`✨ Clan Hiscores (${period})`)
        .setColor(0x00CC88)
        .setTimestamp();
      if (!clanBoard.length) e2.setDescription("No clan-vs-clan kills.");
      else clanBoard.forEach(r =>
        e2.addFields({ name:`${r.rank}. ${r.name}`, value:`Kills: ${r.kills}`, inline:false })
      );

      return msg.channel.send({ embeds: [e1, e2] });
    }

    // ── !totalgp / !totalloot ────────────────────────────────────
    if (cmd === "!totalgp" || cmd === "!totalloot") {
      const { gpTotal } = getEventData();
      const totalGP = Object.values(gpTotal).reduce((s,g)=>s+g,0);
      return sendEmbed(
        msg.channel,
        "💰 Total Loot",
        `Total GP across all players: **${totalGP.toLocaleString()}** coins`
      );
    }

    // ── !lootboard ────────────────────────────────────────────────
    if (cmd === "!lootboard") {
      let period = "all";
      if (args[0] && ["daily","weekly","monthly","all"].includes(args[0].toLowerCase())) {
        period = args.shift().toLowerCase();
      }
      const nameFilter = args.join(" ").toLowerCase() || null;
      const all    = filterByPeriod(lootLog, period);
      const normal = all.filter(e => !e.isClan);
      const clan   = all.filter(e => e.isClan);

      const makeLootBoard = (arr) => {
        const sums = {};
        arr.forEach(({ killer, gp }) => {
          const k = killer.toLowerCase();
          if (nameFilter && k !== nameFilter) return;
          sums[k] = (sums[k]||0) + gp;
        });
        return Object.entries(sums)
          .sort((a,b) => b[1] - a[1])
          .slice(0,10)
          .map(([n,v],i) => ({ rank:i+1, name:n, gp:v }));
      };

      const normalBoard = makeLootBoard(normal);
      const clanBoard   = makeLootBoard(clan);

      const e1 = new EmbedBuilder()
        .setTitle(`💰 Lootboard (${period})`)
        .setColor(0xFF0000)
        .setTimestamp();
      if (!normalBoard.length) e1.setDescription("No loot in that period.");
      else normalBoard.forEach(r =>
        e1.addFields({ name:`${r.rank}. ${r.name}`, value:`${r.gp.toLocaleString()} coins`, inline:false })
      );

      const e2 = new EmbedBuilder()
        .setTitle(`💎 Clan Lootboard (${period})`)
        .setColor(0x00CC88)
        .setTimestamp();
      if (!clanBoard.length) e2.setDescription("No clan-vs-clan loot.");
      else clanBoard.forEach(r =>
        e2.addFields({ name:`${r.rank}. ${r.name}`, value:`${r.gp.toLocaleString()} coins`, inline:false })
      );

      return msg.channel.send({ embeds: [e1, e2] });
    }

    // ── !export ───────────────────────────────────────────────────
    if (cmd === "!export") {
      const what   = args.shift()?.toLowerCase();
      const period = args.shift()?.toLowerCase() || "all";
      if (!["hiscores","lootboard"].includes(what)) {
        return sendEmbed(msg.channel, "❓ Usage", "`!export hiscores|lootboard [daily|weekly|monthly|all]`");
      }
      let rows, headers;
      if (what === "hiscores") {
        const filtered = filterByPeriod(killLog, period);
        const counts   = {};
        filtered.forEach(({ killer }) => counts[killer] = (counts[killer]||0) + 1);
        rows = Object.entries(counts).map(([n,k]) => ({ name:n, kills:k }));
        headers = ["name","kills"];
      } else {
        const filtered = filterByPeriod(lootLog, period);
        const sums     = {};
        filtered.forEach(({ killer, gp }) => sums[killer] = (sums[killer]||0) + gp);
        rows = Object.entries(sums).map(([n,gp]) => ({ name:n, gp }));
        headers = ["name","gp"];
      }
      const csv    = toCSV(rows, headers);
      const buffer = Buffer.from(csv, "utf8");
      const file   = new AttachmentBuilder(buffer, { name:`${what}-${period}.csv` });
      return msg.channel.send({ files: [file] });
    }

    // ── !listclan ────────────────────────────────────────────────
    if (cmd === "!listclan") {
      if (!registered.size) {
        return sendEmbed(msg.channel, "👥 Clan List", "No one registered yet.");
      }
      return sendEmbed(
        msg.channel,
        "👥 Clan List",
        `Registered members:\n${[...registered].join(", ")}`
      );
    }

    // ── !register / !unregister ──────────────────────────────────
    if (cmd === "!register" || cmd === "!unregister") {
      const names = text.slice(cmd.length + 1)
        .split(",")
        .map(ci)
        .filter(Boolean);
      if (!names.length) {
        return sendEmbed(msg.channel, "⚠️ Error", "Provide one or more comma-separated names.");
      }
      names.forEach(n => {
        if (cmd === "!register") registered.add(n);
        else                registered.delete(n);
      });
      fs.writeFileSync(
        path.join(__dirname,"data/registered.json"),
        JSON.stringify([...registered],null,2)
      );
      await commitToGitHub();
      return sendEmbed(
        msg.channel,
        cmd === "!register" ? "➕ Registered" : "➖ Unregistered",
        names.join(", ")
      );
    }

    // ── !clanonly ────────────────────────────────────────────────
    if (lc === "!clanonly on") {
      clanOnlyMode = true; saveData();
      return sendEmbed(msg.channel, "🔒 Clan-Only Mode", "Now **ON** ✅");
    }
    if (lc === "!clanonly off") {
      clanOnlyMode = false; saveData();
      return sendEmbed(msg.channel, "🔓 Clan-Only Mode", "Now **OFF** ❌");
    }

    // ── Events ──────────────────────────────────────────────────
    if (lc === "!listevents") {
      return sendEmbed(
        msg.channel,
        "📅 Events",
        Object.keys(events).map(e => `• ${e}${e === currentEvent ? " (current)" : ""}`).join("\n")
      );
    }
    if (lc.startsWith("!createevent ")) {
      const name = text.slice(13).trim();
      if (!name || events[name]) {
        return sendEmbed(msg.channel, "⚠️ Event Error", "Invalid or duplicate event name.");
      }
      events[name] = { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} };
      currentEvent = name; saveData();
      return sendEmbed(msg.channel, "📅 Event Created", `**${name}** is now current.`);
    }
    if (lc === "!finishevent") {
      const file = `events/event_${currentEvent}_${new Date().toISOString().replace(/[:.]/g,"-")}.json`;
      fs.mkdirSync(path.dirname(path.join(__dirname,file)),{ recursive:true });
      fs.writeFileSync(path.join(__dirname,file), JSON.stringify(events[currentEvent],null,2));
      await commitToGitHub();
      delete events[currentEvent];
      currentEvent = "default";
      saveData();
      return sendEmbed(msg.channel, "✅ Event Finished", `Saved to \`${file}\`, back to **default**.`);
    }

    // ── !help ───────────────────────────────────────────────────
    if (lc === "!help") {
      const help = new EmbedBuilder()
        .setTitle("🛠 Robo-Rat Help")
        .setColor(0xFF0000)
        .setTimestamp()
        .addFields([
          { name: "Stats", value: "`!hiscores [daily|weekly|monthly|all] [name]`\n`!lootboard [period] [name]`\n`!totalgp`", inline:false },
          { name: "Export CSV", value:"`!export hiscores|lootboard [period]`", inline:false },
          { name: "Clan", value:"`!register <n1,n2>`\n`!unregister <n1,n2>`\n`!listclan`\n`!clanonly on/off`", inline:false },
          { name: "Events", value:"`!createevent <name>`\n`!finishevent`\n`!listevents`", inline:false },
          { name: "Misc", value:"`!help`", inline:false }
        ]);
      return msg.channel.send({ embeds: [help] });
    }

  } catch (err) {
    console.error("[command] Error processing command:", cmd, err);
    return sendEmbed(msg.channel, "❌ Command Error", "An error occurred while processing your command.");
  }
});

// ── Auto backup, load, cleanup, launch ────────────────────────
setInterval(saveData, BACKUP_INTERVAL);
loadData();
setInterval(() => {
  const nowTs = now();
  for (const [k,t] of seen.entries()) {
    if (nowTs - t > DEDUP_MS * 2) seen.delete(k);
  }
}, DEDUP_MS);

client.once("ready", () => {
  console.log(`[discord] ready: ${client.user.tag}`);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[http] listening on ${port}`));
});

client.on("error", error => console.error("[discord] Client error:", error));
client.on("disconnect", () => console.log("[discord] Client disconnected"));

client.login(DISCORD_BOT_TOKEN).catch(err => {
  console.error("[discord] Failed to login:", err);
  process.exit(1);
});