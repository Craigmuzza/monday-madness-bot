// bot.js
import express from "express";
import { Client, GatewayIntentBits, EmbedBuilder, Events } from "discord.js";
import fs from "fs";
import path from "path";
import simpleGit from "simple-git";
import formidablePkg from "formidable";
const formidable = formidablePkg;

// ── Configuration ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;                 // Render will bind to this
const DEDUP_MS = 10_000;                               // 10 s anti‐spam
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT = process.env.GITHUB_PAT;             // optional for auto‐commit
const REPO = "craigmuzza/monday-madness-bot";
const BRANCH = "main";
const COMMIT_MSG = "auto: sync data";

// ── State ───────────────────────────────────────────────────────────────────
let currentEvent = "default";
let clanOnlyMode = false;
const registered = new Set();                         // lower‐case names
const seen = new Map();                                // dedup cache

const events = {
  default: { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} },
};

// ── Helpers ─────────────────────────────────────────────────────────────────
const ci = (s = "") => s.toLowerCase().trim();

function getEvent() {
  if (!events[currentEvent]) {
    events[currentEvent] = { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} };
  }
  return events[currentEvent];
}

function saveJSON(file, obj) {
  const p = path.join(process.cwd(), file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

async function gitCommit() {
  if (!GITHUB_PAT) return;
  const git = simpleGit();
  await git.add(".");
  await git.commit(COMMIT_MSG);
  await git.push(
    `https://craigmuzza:${GITHUB_PAT}@github.com/${REPO}.git`,
    BRANCH
  );
}

// load registered
try {
  const arr = JSON.parse(fs.readFileSync("data/registered.json", "utf8"));
  if (Array.isArray(arr)) arr.forEach(n => registered.add(ci(n)));
  console.log(`[init] loaded ${registered.size} registered names`);
} catch {
  console.log("[init] no registered.json yet");
}

// Purge old dedup keys
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of seen) {
    if (now - t > DEDUP_MS) seen.delete(k);
  }
}, 30_000);

// ── Discord Client ─────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once(Events.ClientReady, () => {
  console.log(`[discord] ready: ${client.user.tag}`);
});

// ── Core Processors ─────────────────────────────────────────────────────────
async function processKill(killer, victim, key, res) {
  // clan filter
  if (clanOnlyMode && (!registered.has(ci(killer)) || !registered.has(ci(victim)))) {
    return res?.status(200).send("non-clan kill ignored");
  }
  // dedup
  const now = Date.now();
  if (seen.has(key) && now - seen.get(key) < DEDUP_MS) {
    return res?.status(200).send("duplicate kill suppressed");
  }
  seen.set(key, now);

  const { deathCounts, kills } = getEvent();
  deathCounts[ci(victim)] = (deathCounts[ci(victim)] || 0) + 1;
  kills[ci(killer)]         = (kills[ci(killer)]     || 0) + 1;

  const embed = new EmbedBuilder()
    .setTitle("💀 Kill Logged")
    .setDescription(`**${killer}** killed **${victim}**`)
    .addFields({ name: "Total Deaths", value: `${deathCounts[ci(victim)]}`, inline: true })
    .setColor(0xFF0000)
    .setTimestamp();

  try {
    const ch = await client.channels.fetch(DISCORD_CHANNEL);
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] });
    console.log(`[discord] kill → ${killer}->${victim}`);
  } catch (e) {
    console.error("[discord] kill send error", e);
  }

  return res?.status(200).send("kill logged");
}

async function processLoot(killer, victim, gp, key, res) {
  if (clanOnlyMode && (!registered.has(ci(killer)) || !registered.has(ci(victim)))) {
    return res?.status(200).send("non-clan loot ignored");
  }
  const now = Date.now();
  if (seen.has(key) && now - seen.get(key) < DEDUP_MS) {
    return res?.status(200).send("duplicate loot suppressed");
  }
  seen.set(key, now);

  const { lootTotals, gpTotal } = getEvent();
  lootTotals[ci(killer)] = (lootTotals[ci(killer)] || 0) + gp;
  gpTotal  [ci(killer)] = (gpTotal  [ci(killer)] || 0) + gp;

  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({ name: "Event GP Gained", value: `${lootTotals[ci(killer)].toLocaleString()} coins`, inline: true })
    .setColor(0xFF0000)
    .setTimestamp();

  try {
    const ch = await client.channels.fetch(DISCORD_CHANNEL);
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] });
    console.log(`[discord] loot → ${killer} +${gp}`);
  } catch (e) {
    console.error("[discord] loot send error", e);
  }

  return res?.status(200).send("loot logged");
}

// ── HTTP / Express ────────────────────────────────────────────────────────
const app = express();
app.use(express.json());                 // application/json
app.use(express.text({ type: "text/*" })); // raw text fallback

// legacy /logKill
app.post("/logKill", (req, res) => {
  const { killer, victim } = req.body || {};
  if (!killer || !victim) return res.status(400).send("missing killer/victim");
  return processKill(killer, victim, `K|${ci(killer)}|${ci(victim)}`, res);
});

// legacy /logLoot
app.post("/logLoot", (req, res) => {
  const txt = req.body?.lootMessage;
  if (!txt) return res.status(400).send("missing lootMessage");
  console.log("[http] /logLoot raw=", txt);
  const m = txt.match(/(.+?) has defeated (.+?) and received \(([\d,]+) coins\)/i);
  if (!m) return res.status(400).send("invalid loot format");
  const gp = Number(m[3].replace(/,/g, ""));
  return processLoot(m[1], m[2], gp, `L|${txt.trim()}`, res);
});

// /dink endpoint for DinkPlugin → multipart/form-data
app.post("/dink", (req, res) => {
  // use formidable to parse multipart
  const ct = req.headers["content-type"] || "";
  if (ct.startsWith("multipart/form-data")) {
    const form = formidable({ multiples: false });
    return form.parse(req, (err, fields) => {
      if (err || !fields.payload_json) {
        console.warn("[dink] multipart error", err);
        return res.status(400).send("bad multipart");
      }
      let payload;
      try { payload = JSON.parse(fields.payload_json); }
      catch (e) {
        console.warn("[dink] JSON parse error", e);
        return res.status(400).send("bad JSON");
      }
      console.log("[dink] json", JSON.stringify(payload).slice(0, 200));

      // 1) PLAYER_KILL JSON
      if (payload.type === "PLAYER_KILL" && payload.extra?.victimName) {
        const killer = payload.playerName;
        const victim = payload.extra.victimName;
        return processKill(killer, victim, `K|${ci(killer)}|${ci(victim)}`, res);
      }

      // 2) CHAT clan‐chat loot line
      if (payload.type === "CHAT" && payload.extra?.type === "CLAN_CHAT") {
        const msg = payload.extra.message;
        // loot
        const lm = msg.match(/(.+?) has defeated (.+?) and received \(([\d,]+) coins\)/i);
        if (lm) {
          const gp = Number(lm[3].replace(/,/g, ""));
          return processLoot(lm[1], lm[2], gp, `L|${msg.trim()}`, res);
        }
        // optionally parse kill pattern from chat too:
        const km = msg.match(/(.+?) (?:killed|has defeated) (.+)/i);
        if (km) {
          return processKill(km[1], km[2], `K|${ci(km[1])}|${ci(km[2])}`, res);
        }
      }

      // ignore everything else
      return res.status(204).end();
    });
  }

  // fallback JSON or raw‐text branch
  if (req.is("application/json")) {
    console.log("[dink] json-fallback", JSON.stringify(req.body).slice(0,200));
    const p = req.body;
    // same logic as above...
    if (p.type === "PLAYER_KILL" && p.extra?.victimName) {
      return processKill(p.playerName, p.extra.victimName,
        `K|${ci(p.playerName)}|${ci(p.extra.victimName)}`, res);
    }
    if (p.type === "CHAT" && p.extra?.type === "CLAN_CHAT") {
      const msg = p.extra.message;
      const lm = msg.match(/(.+?) has defeated (.+?) and received \(([\d,]+) coins\)/i);
      if (lm) {
        const gp = Number(lm[3].replace(/,/g, ""));
        return processLoot(lm[1], lm[2], gp, `L|${msg.trim()}`, res);
      }
      const km = msg.match(/(.+?) (?:killed|has defeated) (.+)/i);
      if (km) {
        return processKill(km[1], km[2],
          `K|${ci(km[1])}|${ci(km[2])}`, res);
      }
    }
  }

  // raw text fallback
  if (typeof req.body === "string" && req.body.length) {
    // you could reuse the /logLoot logic here...
    return res.status(204).end();
  }

  return res.status(204).end();
});

// start HTTP after Discord client ready
client.once(Events.ClientReady, () => {
  app.listen(PORT, () => console.log(`[http] listening on ${PORT}`));
});

// ── bot commands (unchanged) ──────────────────────────────────────────
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  const txt = msg.content.toLowerCase();
  const { deathCounts, lootTotals, kills } = getEvent();

  if (txt === "!hiscores") {
    const data = Object.entries(kills).map(([n,k]) => {
      const d = deathCounts[n] || 0;
      const kd = d === 0 ? k : (k / d).toFixed(2);
      return { n,k,d,kd };
    }).sort((a,b)=>b.k-a.k).slice(0,10);

    const embed = new EmbedBuilder()
      .setTitle("🏆 Monday Madness Hiscores 🏆")
      .setColor(0xFF0000)
      .setTimestamp();
    if (!data.length) embed.setDescription("No kills recorded yet.");
    else data.forEach((e,i) =>
      embed.addFields({
        name: `${i+1}. ${e.n}`,
        value: `Kills: ${e.k} | Deaths: ${e.d} | K/D: ${e.kd}`,
        inline: false
      })
    );
    return msg.channel.send({ embeds: [embed] });
  }

  if (txt === "!lootboard") {
    const sorted = Object.entries(lootTotals)
      .sort((a,b)=>b[1]-a[1]).slice(0,10);
    const embed = new EmbedBuilder()
      .setTitle("💰 Top Loot Earners 💰")
      .setColor(0xFF0000)
      .setTimestamp();
    if (!sorted.length) embed.setDescription("No loot recorded yet.");
    else sorted.forEach(( [n,gp],i ) =>
      embed.addFields({
        name: `${i+1}. ${n}`,
        value: `${gp.toLocaleString()} coins`,
        inline: false
      })
    );
    return msg.channel.send({ embeds: [embed] });
  }

  // … your other commands (!createEvent, !finishEvent, !register, !clanOnly on/off, !help) …
});

// ── Login to Discord ────────────────────────────────────────────────────
client.login(DISCORD_TOKEN);
