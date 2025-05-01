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

// ── Ensure correct origin remote ─────────────────────────────
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

// ── Configure Git user for commits (Render doesn't set these) ─
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
const raglist = new Set();
const seen       = new Map();
const events     = {
  default: { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} }
};
const commandCooldowns = new Collection();
const killLog = [];
const lootLog = [];
/**
 *  bounties = {
 *    "victim-name": {
 *       total:   25_000_000,           // total GP on that head
 *       posters: { userId: amount }    // per-Discord-user contribution
 *    },
 *    …
 *  }
 */
const bounties = Object.create(null);

// ── Helpers ───────────────────────────────────────────────────
const ci  = s => (s||"").toLowerCase().trim();
const now = () => Date.now();
function parseGPString(s) {
  if (typeof s !== "string") return NaN;
  const m = s.trim().toLowerCase().match(/^([\d,.]+)([kmb])?$/);
  if (!m) return NaN;
  let n = Number(m[1].replace(/,/g, ""));
  if (isNaN(n)) return NaN;
  const suffix = m[2];
  if (suffix === "k") n *= 1e3;
  if (suffix === "m") n *= 1e6;
  if (suffix === "b") n *= 1e9;
  return n;
}

// **New**: abbreviate GP into K/M/B notation
function abbreviateGP(n) {
  if (n >= 1e9) return (n/1e9).toFixed(2).replace(/\.?0+$/,"") + "B";
  if (n >= 1e6) return (n/1e6).toFixed(2).replace(/\.?0+$/,"") + "M";
  if (n >= 1e3) return (n/1e3).toFixed(2).replace(/\.?0+$/,"") + "K";
  return String(n);
}

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
      JSON.stringify(
       { currentEvent, clanOnlyMode, events, killLog, lootLog, bounties },
       null,
       2
	   )
    );
    fs.writeFileSync(
      path.join(DATA_DIR, "registered.json"),
      JSON.stringify([...registered], null, 2)
    );
    fs.writeFileSync(
      path.join(DATA_DIR, "raglist.json"),
      JSON.stringify([...raglist], null, 2)
    );
	fs.writeFileSync(
	  path.join(DATA_DIR, "bounties.json"),
      JSON.stringify(bounties, null, 2)
  );
    
    commitToGitHub();  // Commit the data to GitHub
  } catch (err) {
    console.error("[save] Failed to save data:", err);  // Handle any errors
  }
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_DIR)) return console.log("[init] no data dir yet");

    const regPath = path.join(DATA_DIR, "registered.json");
    if (fs.existsSync(regPath)) {
      const arr = JSON.parse(fs.readFileSync(regPath));
      if (Array.isArray(arr)) arr.forEach(n => registered.add(ci(n)));
      console.log(`[init] loaded ${registered.size} registered names`);
    }

    const raglistPath = path.join(DATA_DIR, "raglist.json");
    if (fs.existsSync(raglistPath)) {
      const arr = JSON.parse(fs.readFileSync(raglistPath));
      if (Array.isArray(arr)) arr.forEach(n => raglist.add(ci(n)));
      console.log(`[init] loaded ${raglist.size} raglist names`);
    }

    const statePath = path.join(DATA_DIR, "state.json");
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath));
      currentEvent = state.currentEvent || "default";
      clanOnlyMode = state.clanOnlyMode || false;
      Object.assign(events, state.events || {});
      killLog.push(...(state.killLog || []));
      lootLog.push(...(state.lootLog || []));
	   if (state.bounties) {
		Object.assign(bounties, state.bounties);
	    } 
      console.log("[init] loaded saved state");
    }
	const bountyPath = path.join(DATA_DIR, "bounties.json");
	if (fs.existsSync(bountyPath)) {
	Object.assign(bounties, JSON.parse(fs.readFileSync(bountyPath)));
	 // add a sanity check for legacy "number" values
	Object.entries(bounties).forEach(([k, v]) => {
	  if (typeof v === "number") {
       bounties[k] = { total: v, posters: {} };
   }
 });
      console.log(`[init] loaded ${Object.keys(bounties).length} bounties`);
  }
	
  } catch (err) {
    console.error("[init] Failed to load data:", err);  // Handle any errors
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
    if (!killer || !victim || typeof gp !== "number" || isNaN(gp)) {
      return res.status(400).send("invalid data");
    }
    if (seen.has(dedupKey) && now() - seen.get(dedupKey) < DEDUP_MS) {
      return res.status(200).send("duplicate");
    }
    seen.set(dedupKey, now());

    const isClan = registered.has(ci(killer)) && registered.has(ci(victim));
    const { lootTotals, gpTotal, kills, deathCounts } = getEventData();

    lootTotals[ci(killer)] = (lootTotals[ci(killer)]||0) + gp;
    gpTotal  [ci(killer)]  = (gpTotal  [ci(killer)]||0) + gp;
    kills     [ci(killer)] = (kills     [ci(killer)]||0) + 1;
    lootLog.push({ killer, gp, timestamp: now(), isClan });

    deathCounts[ci(victim)] = (deathCounts[ci(victim)]||0) + 1;
    killLog.push({ killer, victim, timestamp: now(), isClan });

    const totalForDisplay = isClan
      ? lootTotals[ci(killer)]
      : (currentEvent === "default"
          ? gpTotal[ci(killer)]
          : lootTotals[ci(killer)]);

    const embed = new EmbedBuilder()
      .setTitle(isClan ? "💎 Clan Loot Detected!" : "💰 Loot Detected")
      .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
      .addFields({
        name: isClan
          ? "Clan GP Earned"
          : (currentEvent === "default" ? "Total GP Earned" : "Event GP Gained"),
        value: `${totalForDisplay.toLocaleString()} coins (${abbreviateGP(totalForDisplay)} GP)`,
        inline: true
      })
      .setColor(isClan ? 0x00CC88 : 0xFF0000)
      .setTimestamp();

    if (isClan) embed.setFooter({ text: "🔥 Clan-vs-Clan action!" });

        // Send the main loot-detected embed
    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] });

    // ── Raglist alert ─────────────────────────────────────────
    if (raglist.has(ci(victim))) {
      const bountyObj   = bounties[ci(victim)];
      const bountyTotal = bountyObj ? bountyObj.total : 0;

      const bountyLine = bountyTotal
        ? `\nCurrent bounty: **${bountyTotal.toLocaleString()} coins (${abbreviateGP(bountyTotal)})**`
        : "";

      await sendEmbed(
        ch,
        "⚔️ Raglist Alert!",
        `@here **${victim}** is on the Raglist! Time to hunt them down!${bountyLine}`
      );
    }

    // ── Bounty claimed ────────────────────────────────────────
    const bounty = bounties[ci(victim)];
    if (bounty && bounty.total > 0) {
      const mentions = Object.keys(bounty.posters)
        .map(id => `<@${id}>`)
        .join(" ");

      const claimEmbed = new EmbedBuilder()
        .setTitle("💸 Bounty Claimed!")
        .setDescription(
          `**${victim}** was killed by **${killer}**.\n` +
          `Total bounty paid out: **${bounty.total.toLocaleString()} coins (${abbreviateGP(bounty.total)})**`
        )
        .setColor(0xFFAA00)
        .setTimestamp();

      await ch.send({ content: mentions, embeds: [claimEmbed] });

      delete bounties[ci(victim)];   // clear the bounty
      saveData();
    }

    // persist everything done above
    saveData();
    return res.status(200).send("ok");
  } catch (err) {
    console.error("[processLoot] Error:", err);
    return res.status(500).send("internal error");
  }
}

async function processKill(killer, victim, dedupKey, res) {
  try {
    if (!killer || !victim) {
      return res.status(400).send("invalid data");
    }
    if (seen.has(dedupKey) && now() - seen.get(dedupKey) < DEDUP_MS) {
      return res.status(200).send("duplicate");
    }
    seen.set(dedupKey, now());

    const isClan = registered.has(ci(killer)) && registered.has(ci(victim));
    const { deathCounts, kills } = getEventData();

    kills       [ci(killer)] = (kills       [ci(killer)]||0) + 1;
    deathCounts [ci(victim)] = (deathCounts [ci(victim)]||0) + 1;
    killLog.push({ killer, victim, timestamp: now(), isClan });

    const embed = new EmbedBuilder()
      .setTitle(isClan ? "✨ Clan Kill Logged!" : "💀 Kill Logged");
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
    { name: "file",         maxCount: 1 }
  ]),
  async (req, res) => {
    let raw = req.body.payload_json;
    if (Array.isArray(raw)) raw = raw[0];
    if (!raw) return res.status(400).send("no payload_json");

    let data;
    try { data = JSON.parse(raw); }
    catch { return res.status(400).send("bad JSON"); }

    const rsn = data.playerName,
          msg = data.extra?.message;
    if (typeof msg === "string")
      console.log(`[dink] seen by=${rsn}|msg=${msg}`);

    if (
      data.type === "CHAT" &&
      ["CLAN_CHAT","CLAN_MESSAGE"].includes(data.extra?.type) &&
      typeof msg === "string"
    ) {
      const m = msg.match(LOOT_RE);
      if (m) return processLoot(m[1], m[2], Number(m[3].replace(/,/g, "")), msg.trim(), res);
    }

    return res.status(204).end();
  }
);

// ── Startup ───────────────────────────────────────────────────
loadData();
setInterval(() => {
  try {
    saveData();
  } catch (err) {
    console.error("[save] periodic save failed:", err);
  }
}, BACKUP_INTERVAL);


const port = process.env.PORT;
if (!port) {
  console.error("❌ PORT env var is required by Render");
  process.exit(1);
}
app.listen(port, () => console.log(`[http] listening on ${port}`));

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
  const lines = [ headers.join(",") ];
  for (const row of rows) {
    lines.push(headers.map(h => esc(row[h])).join(","));
  }
  return lines.join("\n");
}

// ── Discord commands ─────────────────────────────────────────
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  const text = msg.content.trim();
  if (!text.startsWith("!")) return;
  if (!checkCooldown(msg.author.id)) {
    return sendEmbed(msg.channel, "⏳ On Cooldown", "Please wait a few seconds between commands.");
  }

  const lc   = text.toLowerCase();
  const args = text.split(/\s+/);
  const cmd  = args.shift();

  // helper for lootboard
  const makeLootBoard = arr => {
    const sums = {};
    arr.forEach(({ killer, gp }) => {
      const k = killer.toLowerCase();
      sums[k] = (sums[k]||0) + gp;
    });
    return Object.entries(sums)
      .sort((a,b) => b[1] - a[1])
      .slice(0,10)
      .map(([n,v],i) => ({ rank:i+1, name:n, gp:v }));
  };

  try {
    if (cmd === "!hiscores") {
      let period = "all";
      if (args[0] && ["daily","weekly","monthly","all"].includes(args[0].toLowerCase())) {
        period = args.shift().toLowerCase();
      }
      const nameFilter = args.join(" ").toLowerCase() || null;

      const all = filterByPeriod(killLog, period);
      const normal = all.filter(e => !e.isClan);
      const clan   = all.filter(e => e.isClan);

      // build boards
      const makeBoard = arr => {
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

      // send normal hiscores
      const e1 = new EmbedBuilder()
        .setTitle(`🏆 Hiscores (${period})`)
        .setColor(0xFF0000)
        .setTimestamp();
      if (!normalBoard.length) {
        e1.setDescription("No kills in that period.");
      } else {
        normalBoard.forEach(r =>
          e1.addFields({ name:`${r.rank}. ${r.name}`, value:`Kills: ${r.kills}`, inline:false })
        );
      }

      // collect embeds to send
      const embeds = [e1];

      // only show clan board if we're in an event
      if (currentEvent !== "default") {
        const e2 = new EmbedBuilder()
          .setTitle(`✨ Clan Hiscores (${period}) — Event: ${currentEvent}`)
          .setColor(0x00CC88)
          .setTimestamp();
        if (!clanBoard.length) {
          e2.setDescription("No clan-vs-clan kills in that period.");
        } else {
          clanBoard.forEach(r =>
            e2.addFields({ name:`${r.rank}. ${r.name}`, value:`Kills: ${r.kills}`, inline:false })
          );
        }
        embeds.push(e2);
	  }

      return msg.channel.send({ embeds });
    }

    // ── !totalgp / !totalloot ────────────────────────────────────
    if (cmd === "!totalgp" || cmd === "!totalloot") {
      const { gpTotal } = getEventData();
      const totalGP = Object.values(gpTotal).reduce((s,g)=>s+g,0);
      return sendEmbed(
        msg.channel,
        "💰 Total Loot",
        `Total GP across all players: **${totalGP.toLocaleString()} coins (${abbreviateGP(totalGP)} GP)**`
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

      // build top-10
      const makeLootBoard = arr => {
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

      // normal lootboard embed
      const e1 = new EmbedBuilder()
        .setTitle(`💰 Lootboard (${period})`)
        .setColor(0xFF0000)
        .setTimestamp();
      if (!normalBoard.length) {
        e1.setDescription("No loot in that period.");
      } else {
        normalBoard.forEach(r =>
          e1.addFields({
            name:  `${r.rank}. ${r.name}`,
            value: `${r.gp.toLocaleString()} coins (${abbreviateGP(r.gp)})`,
            inline: false
          })
        );
      }

      const embeds = [e1];

      // only show clan lootboard when in an event
      if (currentEvent !== "default") {
        const e2 = new EmbedBuilder()
          .setTitle(`💎 Clan Lootboard (${period}) — Event: ${currentEvent}`)
          .setColor(0x00CC88)
          .setTimestamp();
        if (!clanBoard.length) {
          e2.setDescription("No clan-vs-clan loot in that period.");
        } else {
          clanBoard.forEach(r =>
            e2.addFields({
              name:  `${r.rank}. ${r.name}`,
              value: `${r.gp.toLocaleString()} coins (${abbreviateGP(r.gp)})`,
              inline: false
            })
          );
        }
        embeds.push(e2);
      }

      return msg.channel.send({ embeds });
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
		try {
		const names = text.slice(cmd.length + 1)
		  .split(",")
		  .map(ci)
		  .filter(Boolean);
		if (!names.length) {
		  return sendEmbed(msg.channel, "⚠️ Error", "Provide one or more comma-separated names.");
		}
		names.forEach(n => {
		  if (cmd === "!register") registered.add(n);
		  else                     registered.delete(n);
		});
		fs.writeFileSync(
			path.join(DATA_DIR, "registered.json"),        // ← point to the same volume
			JSON.stringify([...registered], null, 2)
		);
		await commitToGitHub();
		return sendEmbed(
		  msg.channel,
		  cmd === "!register" ? "➕ Registered" : "➖ Unregistered",
		  names.join(", ")
		);
	  } catch (err) {
		console.error(`[${cmd}] Error:`, err);
		return sendEmbed(msg.channel, "⚠️ Error", `Failed to ${cmd.slice(1)}: ${err.message}`);
	  }
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
        Object.keys(events).map(e => `• ${e}${e===currentEvent?" (current)":""}`).join("\n")
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
      fs.mkdirSync(path.dirname(path.join(__dirname,file)), { recursive:true });
      fs.writeFileSync(path.join(__dirname,file), JSON.stringify(events[currentEvent],null,2));
      await commitToGitHub();
      delete events[currentEvent];
      currentEvent = "default";
      saveData();
      return sendEmbed(msg.channel, "✅ Event Finished", `Saved to \`${file}\`, back to **default**.`);
    }

		// ── !raglist command ─────────────────────────────────────────────
	if (lc.startsWith("!raglist")) {
	  if (lc === "!raglist") {
		return sendEmbed(msg.channel, "⚔️ Raglist", 
		  raglist.size ? `Raglist: ${[...raglist].join(", ")}` : "No players in the raglist."
		);
	  }

	  // Add a player to the raglist
	  if (lc.startsWith("!raglist add")) {
		const name = text.slice("!raglist add".length).trim();
		if (!name) return sendEmbed(msg.channel, "⚠️ Error", "Please provide a name to add.");
		raglist.add(ci(name));
		saveData();
		return sendEmbed(msg.channel, "➕ Added to Raglist", name);
	  }

	  // Remove a player from the raglist
	  if (lc.startsWith("!raglist remove")) {
		const name = text.slice("!raglist remove".length).trim();
		if (!name) return sendEmbed(msg.channel, "⚠️ Error", "Please provide a name to remove.");
		if (!raglist.has(ci(name))) {
		  return sendEmbed(msg.channel, "⚠️ Error", "That name is not in the raglist.");
		}
		raglist.delete(ci(name));
		saveData();
		return sendEmbed(msg.channel, "➖ Removed from Raglist", name);
	  }
	}

    // ── !bounty ────────────────────────────────────────────────
    if (cmd === "!bounty") {
      const sub = (args.shift() || "").toLowerCase();

      // !bounty list
      if (sub === "list") {
        if (!Object.keys(bounties).length) {
          return sendEmbed(msg.channel, "💰 Bounties", "No active bounties.");
        }
        const e = new EmbedBuilder()
          .setTitle("💰 Active Bounties")
          .setColor(0xFFAA00)
          .setTimestamp();
        Object.entries(bounties)
		  .sort((a, b) => b[1].total - a[1].total)
		  .forEach(([n, obj]) =>
            e.addFields({
              name: n,
              value:
			`   ${obj.total.toLocaleString()} coins (${abbreviateGP(obj.total)})\n` +
			    Object.entries(obj.posters)
			     .map(([uid, amt]) => `• <@${uid}> — ${abbreviateGP(amt)}`)
			     .join("\n"),
              inline: false
            })
          );
        return msg.channel.send({ embeds: [e] });
      }

      // !bounty add/remove <name> <amount>
      if (["add", "remove"].includes(sub)) {
        const name   = (args.shift() || "").trim();
        const amount = parseGPString(args.shift());
        if (!name || isNaN(amount) || amount <= 0) {
          return sendEmbed(
            msg.channel,
            "⚠️ Usage",
            "`!bounty add|remove <raglist-name> <amount>`  (e.g. `!bounty add ZammyTroll 10m`)"
          );
        }
        if (!raglist.has(ci(name))) {
          return sendEmbed(msg.channel, "⚠️ Error", "That name is not in the raglist.");
        }

        const key = ci(name);
        if (!bounties[key]) bounties[key] = { total: 0, posters: {} };
		if (sub === "add") {
		  bounties[key].total            += amount;
		  bounties[key].posters[msg.author.id] =
			(bounties[key].posters[msg.author.id] || 0) + amount;
		} else {                   // remove
		  bounties[key].total            = Math.max(0, bounties[key].total - amount);
		  bounties[key].posters[msg.author.id] =
			Math.max(0, (bounties[key].posters[msg.author.id] || 0) - amount);
		  if (bounties[key].posters[msg.author.id] === 0)
			delete bounties[key].posters[msg.author.id];
		  if (bounties[key].total === 0) delete bounties[key];
		}
        saveData();
                return sendEmbed(
          msg.channel,
          sub === "add" ? "➕ Bounty Added" : "➖ Bounty Reduced",
          `**${name}** ➜ ${
            bounties[key]
              ? `${bounties[key].total.toLocaleString()} coins (${abbreviateGP(bounties[key].total)})`
              : "no bounty"
          }`
        );
      }                               // ← closes add/remove branch

      // unknown sub-command
      return sendEmbed(
        msg.channel,
        "⚠️ Usage",
        "`!bounty list` or `!bounty add|remove <name> <amount>`"
      );
    }                                 // ← closes the whole !bounty block



	   // ── !help ───────────────────────────────────────────────────
	if (lc === "!help") {
	  const help = new EmbedBuilder()
		.setTitle("🛠 Robo-Rat Help")
		.setColor(0xFF0000)  // Set the embed colour to yellow
		.setTimestamp()
		.addFields([
		  { name: "Stats", value: "`!hiscores [daily|weekly|monthly|all] [name]`\n`!lootboard [period] [name]`\n`!totalgp`", inline:false },
		  { name: "Export CSV", value:"`!export hiscores|lootboard [period]`", inline:false },
		  { name: "Clan", value:"`!register <n1,n2>`\n`!unregister <n1,n2>`\n`!listclan`\n`!clanonly on/off`", inline:false },
		  { name: "Events", value:"`!createevent <name>`\n`!finishevent`\n`!listevents`", inline:false },
		  { name: "Raglist", value:"`!raglist` - View raglist\n`!raglist add <name>` - Add player to raglist\n`!raglist remove <name>` - Remove player from raglist", inline:false },
		  { name: "Bounty",  value:"`!bounty list`\n`!bounty add <name> <amount>`\n`!bounty remove <name> <amount>`", inline:false },
		  { name: "Misc", value:"`!help`", inline:false }
		]);
	  return msg.channel.send({ embeds: [help] });
	}
} catch (err) {
  console.error("[command] Error handling command:", err);
  return sendEmbed(msg.channel, "⚠️ Error", "An error occurred while processing your command.");
}
});

client.once("ready", () => console.log(`[discord] ready: ${client.user.tag}`));
client.on("error", err => console.error("[discord] Client error:", err));
client.on("disconnect", () => console.log("[discord] Client disconnected"));

client.login(DISCORD_BOT_TOKEN).catch(err => {
  console.error("[discord] Failed to login:", err);
  process.exit(1);
});