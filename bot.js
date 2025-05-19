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

// ── Keeping it in the clan ────────────────────────────────────
const CLAN_FILTER = "a rat pact";        // lower‑case, for easy compare

// ── Constants & Regex ─────────────────────────────────────────
const EMBED_ICON = "https://i.imgur.com/jFZozPJ.gif";
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

// ── Per-Discord-user RuneScape account links  ─────────────────────────────
const accounts = {};   // { [userId: string]: string[] }

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
	.setThumbnail(EMBED_ICON)
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
      path.join(DATA_DIR, "accounts.json"),
      JSON.stringify(accounts, null, 2)
    );

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

/* ── Save & Load data ───────────────────────────────────────────────── */
function loadData() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      console.log("[init] no data dir yet");
      return;
    }

    /* ── registered + raglist ──────────────────────────────── */
    const regPath = path.join(DATA_DIR, "registered.json");
    if (fs.existsSync(regPath)) {
      JSON.parse(fs.readFileSync(regPath))
        .forEach(n => registered.add(ci(n)));
      console.log(`[init] loaded ${registered.size} registered names`);
    }
	
	// accounts.json (optional, user→[rsns])
    const acctPath = path.join(DATA_DIR, "accounts.json");
    if (fs.existsSync(acctPath)) {
      Object.assign(accounts, JSON.parse(fs.readFileSync(acctPath)));
      console.log(`[init] loaded account links for ${Object.keys(accounts).length} users`);
    }


    const ragPath = path.join(DATA_DIR, "raglist.json");
    if (fs.existsSync(ragPath)) {
      JSON.parse(fs.readFileSync(ragPath))
        .forEach(n => raglist.add(ci(n)));
      console.log(`[init] loaded ${raglist.size} raglist names`);
    }

    /* ── main state (events, logs, etc.) ───────────────────── */
    const statePath = path.join(DATA_DIR, "state.json");
    if (fs.existsSync(statePath)) {
      const st = JSON.parse(fs.readFileSync(statePath));
      currentEvent = st.currentEvent || "default";
      clanOnlyMode = st.clanOnlyMode || false;
      Object.assign(events, st.events || {});
      killLog.push(...(st.killLog || []));
      lootLog.push(...(st.lootLog || []));
      if (st.bounties) Object.assign(bounties, st.bounties);
      console.log("[init] loaded saved state");
    }

    /* ── bounties.json  (may be absent) ────────────────────── */
    const bountyPath = path.join(DATA_DIR, "bounties.json");
    if (fs.existsSync(bountyPath)) {
      Object.assign(bounties, JSON.parse(fs.readFileSync(bountyPath)));

      /* ── normalise every record into { once:{}, persistent:{} } ─ */
      Object.entries(bounties).forEach(([k, v]) => {
        /* A. very old flat shape */
        if (typeof v.total === "number") {
          bounties[k] = {
            once:       { total: v.persistent ? 0 : v.total, posters: v.posters || {} },
            persistent: { total: v.persistent ? v.total    : 0,       posters: v.posters || {} }
          };
          return;
        }

        /* B. early hybrid ({ once:{…}, persistent:true/false }) */
        if (typeof v.persistent === "boolean") {
          bounties[k] = {
            once:       v.once || { total: 0, posters: {} },
            persistent: v.persistent ? { total: v.total || 0, posters: v.posters || {} }
                                     : { total: 0, posters: {} }
          };
          return;
        }

        /* C. numeric‑only legacy */
        if (typeof v === "number") {
          bounties[k] = {
            once:       { total: v, posters: {} },
            persistent: { total: 0, posters: {} }
          };
        }
      });

      console.log(`[init] loaded & normalised ${Object.keys(bounties).length} bounties`);
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
	  lootLog.push({
		killer, gp,
		timestamp: now(),
		isClan,
		event: currentEvent          // ← NEW
	  });

    deathCounts[ci(victim)] = (deathCounts[ci(victim)]||0) + 1;
	  killLog.push({
		killer, victim,
		timestamp: now(),
		isClan,
		event: currentEvent          // ← NEW
	  });

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
	  .setThumbnail(EMBED_ICON)
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

      // build a proper embed without the @here
      const ragEmbed = new EmbedBuilder()
        .setTitle("⚔️ Raglist Alert!")
        .setDescription(`**${victim}** is on the Raglist! Time to hunt them down!${bountyLine}`)
        .setThumbnail(EMBED_ICON)
        .setColor(0xFF0000)
        .setTimestamp();
    }

// ── Bounty claimed ────────────────────────────────────────
const record = bounties[ci(victim)];
if (record) {
  const oneShot    = record.once.total    || 0;
  const persistent = record.persistent.total || 0;
  const paid       = oneShot + persistent;

  if (paid > 0) {
    // mention everyone who put up a bounty
    const mentions = Object.keys({
      ...record.once.posters,
      ...record.persistent.posters
    }).map(id => `<@${id}>`).join(" ");

    const claimEmbed = new EmbedBuilder()
      .setTitle("💸 Bounty Claimed!")
      .setDescription(
        `**${victim}** was killed by **${killer}**.\n` +
        `Total bounty paid out: **${paid.toLocaleString()} coins (${abbreviateGP(paid)})**`
      )
      .setColor(0xFFAA00)
      .setThumbnail(EMBED_ICON)
      .setTimestamp();

    await ch.send({ content: mentions, embeds: [claimEmbed] });

    // clear one-shot pool, leave persistent for next kill
    record.once.total = 0;
    record.once.posters = {};

    // if no persistent bounty either, delete the record
    if (record.persistent.total === 0) {
      delete bounties[ci(victim)];
    }
    saveData();
  }
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

/* ───────────────────────────  RuneLite “dink” webhook  ────────────────────────── */
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

/* -----------------------------------------------------------------
   Only process clan‑chat that comes from the clan “A Rat Pact”.
------------------------------------------------------------------ */
if (
  data.type === "CHAT" &&
  ["CLAN_CHAT", "CLAN_MESSAGE"].includes(data.extra?.type) &&
  typeof msg === "string"
) {
  const clanName =
    (
      data.extra?.clanName   ||   // RuneLite ≥1.10
      data.extra?.clan_name  ||   // older forks
      data.extra?.source     ||   // ← NEW: where yours is found
      data.extra?.clanTag    ||   // other odd variants
      data.extra?.clan       ||   // generic fallback
      ""
    ).toLowerCase();

  if (clanName !== CLAN_FILTER) {          // not our clan – ignore
    console.log(`[dink] skipped clan: "${clanName}"`);
    return res.status(204).end();
  }

	// AUTO-REGISTER: add this player to `registered` if they're not already in it
	const key = ci(rsn);
	if (!registered.has(key)) {
	  registered.add(key);
	  saveData();                                 // write out registered.json
	  console.log(`[auto-register] added "${key}"`);
	}

  /* our clan — parse the loot message */
  const m = msg.match(LOOT_RE);
  if (m) {
    return processLoot(
      m[1],                               // killer
      m[2],                               // victim
      Number(m[3].replace(/,/g, "")),     // gp
      msg.trim(),                         // dedup key
      res
    );
  }
}


    /* nothing to do */
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

	  const all = filterByPeriod(
		killLog.filter(e => currentEvent === "default" ? true : e.event === currentEvent),
		period
	);
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
		.setThumbnail(EMBED_ICON)
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
		  .setThumbnail(EMBED_ICON)
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

	// ── !addgp / !removegp ───────────────────────────────────────
	if (cmd === "!addgp" || cmd === "!removegp") {
		
	  msg.delete().catch(() => {/* missing perms, oh well */});	
	
	  const isAdd = cmd === "!addgp";
	  // pull off the amount and parse it
	  const amount = parseGPString(args.pop());
	  // the rest is the player name (allowing spaces)
	  const name   = args.join(" ").trim();

	  if (!name || isNaN(amount) || amount <= 0) {
		return sendEmbed(
		  msg.channel,
		  "⚠️ Usage",
		  "`!addgp <name> <amount>`\n`!removegp <name> <amount>`"
		);
	  }

	  // record a synthetic lootLog entry (negative for remove)
	  lootLog.push({
		killer:    name,
		gp:        isAdd ? amount : -amount,
		timestamp: now(),
		isClan:    false,              // these are manual adjustments
		event:     currentEvent
	  });
	  saveData();

	  // recompute the new total for that name in this event
	  const total = lootLog
		.filter(e =>
		  e.killer.toLowerCase() === name.toLowerCase() &&
		  (currentEvent === "default" ? true : e.event === currentEvent)
		)
		.reduce((sum, e) => sum + e.gp, 0);

	  return sendEmbed(
		msg.channel,
		isAdd ? "➕ GP Added" : "➖ GP Removed",
		`**${name}** ➜ ${total.toLocaleString()} coins (${abbreviateGP(total)})`
	  );
	}

// ── !addacc / !removeacc / !listacc ───────────────────────────────
if (cmd === "!addacc" || cmd === "!removeacc" || cmd === "!listacc") {
  const myId = msg.author.id;

  // ── LIST
  if (cmd === "!listacc") {
    const list = accounts[myId] || [];
    const desc = list.length
      ? list.map((r,i) => `${i+1}. ${r}`).join("\n")
      : "You have no linked accounts.";
    return sendEmbed(msg.channel, "🔗 Your RSN Links", desc);
  }

	  // ── ADD / REMOVE
	  // grab everything after the command, split on commas, trim each
	  const raw = text.slice(cmd.length).trim();            // e.g. " alice, bob rsn ,charlie"
	  const names = raw
		.split(",")
		.map(s => s.trim())
		.filter(Boolean);                                   // e.g. ["alice","bob rsn","charlie"]

	  if (!names.length) {
		return sendEmbed(msg.channel, "⚠️ Usage", "`!addacc <rsn1>, <rsn2>, ...` or `!removeacc <rsn1>, <rsn2>, ...`");
	  }

	  accounts[myId] = accounts[myId] || [];

	  if (cmd === "!addacc") {
		for (const rsn of names) {
		  const key = rsn.toLowerCase();
		  if (!accounts[myId].includes(key)) {
			accounts[myId].push(key);
		  }
		}
	  } else {
		// remove any matching
		const toRemove = names.map(n => n.toLowerCase());
		accounts[myId] = accounts[myId].filter(x => !toRemove.includes(x));
	  }

	  saveData();

	  return sendEmbed(
		msg.channel,
		cmd === "!addacc" ? "➕ Account(s) Added" : "➖ Account(s) Removed",
		`You now have ${accounts[myId].length} linked account(s).`
	  );
	}


// ── !lootboard ────────────────────────────────────────────────
if (cmd === "!lootboard") {
  // 1) period & nameFilter as before
  let period = "all";
  if (args[0] && ["daily","weekly","monthly","all"].includes(args[0].toLowerCase())) {
    period = args.shift().toLowerCase();
  }
  const nameFilter = args.join(" ").toLowerCase() || null;

  // 2) invert your accounts map so rsn→discordId
  const rsnToDiscord = {};
  for (const [uid, rsns] of Object.entries(accounts)) {
    for (const rsn of rsns) {
      rsnToDiscord[rsn.toLowerCase()] = uid;
    }
  }

  // 3) gather & filter your raw lootLog
  const raw = lootLog.filter(e =>
    (currentEvent === "default" ? true : e.event === currentEvent) &&
    (!nameFilter || e.killer.toLowerCase() === nameFilter)
  );
  const all = filterByPeriod(raw, period);

  // 4) sum GP by “owner” = discordId if linked, else by RSN
  const sums = {};
  all.forEach(({ killer, gp }) => {
    const key = killer.toLowerCase();
    const owner = rsnToDiscord[key] || key;
    sums[owner] = (sums[owner] || 0) + gp;
  });

  // 5) turn into a sorted top-10 array
  const board = Object.entries(sums)
    .sort((a,b) => b[1] - a[1])
    .slice(0,10)
    .map(([owner,gp],i) => {
      const isUser = /^\d+$/.test(owner);
      return {
        rank: i+1,
        owner,
        display: isUser ? `<@${owner}>` : owner,
        gp
      };
    });

  // 6) Build the normal lootboard embed
  const e1 = new EmbedBuilder()
    .setTitle(`💰 Lootboard (${period})`)
    .setColor(0xFF0000)
    .setThumbnail(EMBED_ICON)
    .setTimestamp();
  if (!board.length) {
    e1.setDescription("No loot in that period.");
  } else {
    board.forEach(r =>
      e1.addFields({
        name:  `${r.rank}. ${r.display}`,
        value: `${r.gp.toLocaleString()} coins (${abbreviateGP(r.gp)})`,
        inline: false
      })
    );
  }

  const embeds = [e1];

  // 7) And your clan-only board (if in an event)
  if (currentEvent !== "default") {
    const clanOnly = board.filter(r => {
      // find at least one entry where isClan was true
      return all.some(e =>
        (rsnToDiscord[e.killer.toLowerCase()] || e.killer.toLowerCase()) === r.owner &&
        e.isClan
      );
    });
    const e2 = new EmbedBuilder()
      .setTitle(`💎 Clan Lootboard (${period}) — Event: ${currentEvent}`)
      .setColor(0x00CC88)
      .setThumbnail(EMBED_ICON)
      .setTimestamp();

    if (!clanOnly.length) {
      e2.setDescription("No clan-vs-clan loot in that period.");
    } else {
      clanOnly.forEach(r =>
        e2.addFields({
          name:  `${r.rank}. ${r.display}`,
          value: `${r.gp.toLocaleString()} coins (${abbreviateGP(r.gp)})`,
          inline: false
        })
      );
    }
    embeds.push(e2);
  }

  // 8) send with allowedMentions so <@id> actually pings
  const toMention = board
    .filter(r => /^\d+$/.test(r.owner))
    .map(r => r.owner);
  return msg.channel.send({
    embeds,
    allowedMentions: { users: toMention }
  });

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

/* ──────────────────────────  BOUNTY COMMAND  ───────────────────────── */
if (cmd === "!bounty") {
  const sub = (args.shift() || "").toLowerCase();   // first word after !bounty

  /* ---------------------------------------------------------------
     Optional "@someone" (or "<@123456789>") right at the end.
     If present, we’ll credit that user for the bounty.
  ---------------------------------------------------------------- */
  let posterId = msg.author.id;          // default: command author
  let maybeMention = args[args.length - 1];   // look at last token

  if (maybeMention) {
    // raw mention format: <@123…>  or  <@!123…>
    const m = maybeMention.match(/^<@!?(?<id>\d+)>$/);
    if (m?.groups?.id) {
      posterId = m.groups.id;
      args.pop();                       // remove it from the arg list
    } else if (maybeMention.startsWith("@") && msg.guild) {
      // a literal “@Name” — try to resolve in this guild
      const nick = maybeMention.slice(1).toLowerCase();
      const member = msg.guild.members.cache.find(
        m =>
          m.user.username.toLowerCase() === nick ||
          (m.nickname && m.nickname.toLowerCase() === nick)
      );
      if (member) {
        posterId = member.id;
        args.pop();                     // remove the mention token
      }
    }
  }

  // helper that shows the correct syntax
  const showUsage = () =>
    sendEmbed(
      msg.channel,
      "⚠️ Usage",
      "`!bounty list`  │  " +
      "`!bounty add <name> <amount>`  │  `!bounty addp <name> <amount>`\n" +
      "`!bounty remove <name> <amount>`  │  `!bounty removep <name> <amount>`"
    );

  /* ---------- LIST --------------------------------------------------- */
  if (sub === "list") {
    const persistent = [];
    const oneShot    = [];

    Object.entries(bounties).forEach(([name, rec]) => {
      if (rec?.persistent?.total > 0) persistent.push([name, rec.persistent]);
      if (rec?.once?.total       > 0) oneShot.push([name, rec.once]);
    });

    if (!persistent.length && !oneShot.length)
      return sendEmbed(msg.channel, "💰 Bounties", "No active bounties.");

    const makeEmbed = (title, rows) => {
      const e = new EmbedBuilder()
        .setTitle(title)
        .setColor(0xFFAA00)
		.setThumbnail(EMBED_ICON)
        .setTimestamp();
      rows
        .sort((a, b) => b[1].total - a[1].total)
        .forEach(([n, obj]) => {
          const amt = obj?.total ?? 0;
          e.addFields({
            name: n,
            value:
              `${amt.toLocaleString()} coins (${abbreviateGP(amt)})\n` +
              Object.entries(obj.posters || {})
                .map(([uid, a]) => `• <@${uid}> — ${abbreviateGP(a)}`)
                .join("\n"),
            inline: false
          });
        });
      return e;
    };

    const embeds = [];
    if (persistent.length) embeds.push(makeEmbed("🕒 Persistent Bounties", persistent));
    if (oneShot.length)    embeds.push(makeEmbed("💰 One‑Shot Bounties", oneShot));

    return msg.channel.send({ embeds });
  }

  /* helper ------------------------------------------------------------ */
  const amount = parseGPString(args.pop());   // now the *new* last token
  const name   = args.join(" ").trim();       // whatever remains
  if (["add","addp","remove","removep"].includes(sub)) {
    if (!name || isNaN(amount) || amount <= 0) return showUsage();
    if (!raglist.has(ci(name)))
      return sendEmbed(msg.channel, "⚠️ Error", "That name is not in the raglist.");
  }

  const key = ci(name);

  /* ensure container in new format */
  if (!bounties[key]) bounties[key] = {
    once:       { total: 0, posters: {} },
    persistent: { total: 0, posters: {} }
  };

  /* ── runtime upgrade: convert old boolean/flat record on the fly ── */
  if (typeof bounties[key].persistent === "boolean") {
    bounties[key] = {
      once:       { total: bounties[key].persistent ? 0 : (bounties[key].total || 0),
                    posters: bounties[key].posters || {} },
      persistent: { total: bounties[key].persistent ? (bounties[key].total || 0) : 0,
                    posters: bounties[key].posters || {} }
    };
  }

  /* ---------- ADD (one‑shot) ---------------------------------------- */
  if (sub === "add") {
    bounties[key].once.total += amount;
	  bounties[key].once.posters[posterId] =
		(bounties[key].once.posters[posterId] || 0) + amount;

    saveData();
    return sendEmbed(
      msg.channel,
      "➕ Bounty Added",
      `**${name}** ➜ ${abbreviateGP(bounties[key].once.total)}`
    );
  }

  /* ---------- ADDP (persistent) ------------------------------------- */
  if (sub === "addp" || sub === "addpersistent") {
    bounties[key].persistent.total += amount;
	  bounties[key].persistent.posters[posterId] =
		(bounties[key].persistent.posters[posterId] || 0) + amount;
    saveData();
    return sendEmbed(
      msg.channel,
      "📌 Persistent Bounty Added",
      `**${name}** ➜ ${abbreviateGP(bounties[key].persistent.total)} (pays every kill)`
    );
  }

  /* ---------- REMOVE (one‑shot) ------------------------------------- */
  if (sub === "remove") {
    bounties[key].once.total = Math.max(0, bounties[key].once.total - amount);
    bounties[key].once.posters[msg.author.id] =
      Math.max(0, (bounties[key].once.posters[msg.author.id] || 0) - amount);

    if (bounties[key].once.posters[msg.author.id] === 0)
      delete bounties[key].once.posters[msg.author.id];

    /* delete entry if both pools empty */
    if (
      bounties[key].once.total       === 0 &&
      bounties[key].persistent.total === 0
    ) delete bounties[key];

    saveData();
    return sendEmbed(
      msg.channel,
      "➖ Bounty Reduced",
      bounties[key]
        ? `**${name}** ➜ ${abbreviateGP(bounties[key].once.total)}`
        : `**${name}** ➜ no bounty`
    );
  }

  /* ---------- REMOVEP (persistent) ---------------------------------- */
  if (sub === "removep") {
    bounties[key].persistent.total =
      Math.max(0, bounties[key].persistent.total - amount);
    bounties[key].persistent.posters[msg.author.id] =
      Math.max(0, (bounties[key].persistent.posters[msg.author.id] || 0) - amount);

    if (bounties[key].persistent.posters[msg.author.id] === 0)
      delete bounties[key].persistent.posters[msg.author.id];

    if (
      bounties[key].once.total       === 0 &&
      bounties[key].persistent.total === 0
    ) delete bounties[key];

    saveData();
    return sendEmbed(
      msg.channel,
      "➖ Persistent Bounty Reduced",
      bounties[key]
        ? `**${name}** ➜ ${abbreviateGP(bounties[key].persistent.total)}`
        : `**${name}** ➜ no bounty`
    );
  }

  /* ---------- unknown sub‑command ----------------------------------- */
  return showUsage();
}

	// ── !help ───────────────────────────────────────────────────
	if (lc === "!help") {
	  const help = new EmbedBuilder()
		.setTitle("🛠 Robo-Rat Help")
		.setColor(0xFF0000)
		.setThumbnail(EMBED_ICON)
		.setTimestamp()
		.addFields([
		  { name: "Stats", value: "`!hiscores [daily|weekly|monthly|all] [name]`\n`!lootboard [period] [name]`\n`!totalgp`", inline:false },
		  { name: "Export CSV", value:"`!export hiscores|lootboard [period]`", inline:false },
		  { name: "Clan", value:"`!register <n1,n2>`\n`!unregister <n1,n2>`\n`!listclan`\n`!clanonly on/off`", inline:false },
		  { name: "Events", value:"`!createevent <name>`\n`!finishevent`\n`!listevents`", inline:false },
		  { name: "Raglist", value:"`!raglist` - View raglist\n`!raglist add <name>` - Add player to raglist\n`!raglist remove <name>` - Remove player from raglist", inline:false },
		  { name: "Bounty", value:
			  "`!bounty list`\n" +
			  "`!bounty add  <name> <amount> [@user]`   – one-shot\n" +
			  "`!bounty addp <name> <amount> [@user]`  – persistent\n" +
			  "`!bounty remove <name> <amount>`   – reduce one-shot\n" +
			  "`!bounty removep <name> <amount>`  – reduce persistent",
			inline: false
		  },
		  { name: "Accounts", value:
			  "`!addacc <rsn>`   – Link one of your RSNs to your Discord ID\n" +
			  "`!removeacc <rsn>` – Unlink an RSN\n" +
			  "`!listacc`        – Show your linked RSNs",
			inline: false
		  },
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