/*  ───────────────────────────────────────────────────────────────
    Monday-Madness Discord bot – Dink-compatible multipart handler
    ─────────────────────────────────────────────────────────────── */

const express  = require("express");
const multer   = require("multer");          // <-- NEW
const {
  Client, GatewayIntentBits, EmbedBuilder, Events
} = require("discord.js");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

/* ── env ───────────────────────────────────────────────────────── */
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

/* ── constants ─────────────────────────────────────────────────── */
const PORT        = process.env.PORT || 3000;   // Render supplies PORT
const DEDUP_MS    = 10_000;
const LOOT_REGEX  =
  /(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\(([\d,]+)\s+coins\).*/i;

/* ── state ─────────────────────────────────────────────────────── */
let registered = new Set();
let seen = new Map();
const events = { default: { kills:{}, deaths:{}, loot:{} } };
let currentEvent = "default";
const ci = s => s.toLowerCase().trim();
const now = () => Date.now();

/* ── Express ----------------------------------------------------- */
const app = express();

/* Narrow body-parsers – don’t eat multipart */
app.use(express.json ({ type: "application/json" }));
app.use(express.text({ type: "text/plain"        }));

/* Multer for multipart/form-data */
const upload = multer();

/* health-check */
app.post("/ping", (_,res) => res.send("pong"));

/* -------------  /dink  ----------------------------------------- */
app.post("/dink", upload.any(), (req,res) => {
  /*
     Dink always sends multipart/form-data with a part called
     “payload_json”.   Screenshots come as part “file” (ignored here).
  */
  let jsonStr;

  // 1) multipart case – multer puts text parts in req.body
  if (req.headers["content-type"]?.startsWith("multipart/")) {
    jsonStr = req.body?.payload_json;
  }
  // 2) application/json path (curl / tests)
  else if (typeof req.body === "object") {
    jsonStr = JSON.stringify(req.body);
  }
  // 3) text/plain path (curl when Send JSON disabled)
  else if (typeof req.body === "string") {
    return handleChatLine(req.body, res);
  }

  if (!jsonStr) return res.status(400).send("no payload_json");

  let payload;
  try { payload = JSON.parse(jsonStr); }
  catch { return res.status(400).send("bad JSON"); }

  /* We only care about CHAT → CLAN_CHAT */
  if (
    payload.type === "CHAT" &&
    payload.extra?.type === "CLAN_CHAT" &&
    typeof payload.extra.message === "string"
  ){
    return handleChatLine(payload.extra.message, res);
  }

  return res.status(204).end();          // ignore others
});

/* -------------  text / regex path  ----------------------------- */
function handleChatLine(line, res){
  const m = line.match(LOOT_REGEX);
  if (!m) return res.status(204).end();  // not a loot line

  const [, killer, victim, gpStr] = m;
  const gp = Number(gpStr.replace(/,/g,""));

  // de-dup
  if (seen.has(line) && now()-seen.get(line)<DEDUP_MS)
    return res.status(200).send("dup");
  seen.set(line, now());

  const ev = events[currentEvent];
  ev.kills[ci(killer)]  = (ev.kills [ci(killer)]||0)+1;
  ev.loot [ci(killer)]  = (ev.loot  [ci(killer)]||0)+gp;

  postDiscordLoot(killer, victim, gp, ev.loot[ci(killer)]);
  return res.status(200).send("ok");
}

/* -------------  Discord embed  --------------------------------- */
const client = new Client({
  intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]
});

async function postDiscordLoot(killer,victim,gp,total){
  const embed = new EmbedBuilder()
    .setTitle("💰 Loot Detected")
    .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
    .addFields({ name:"Event GP Gained", value:`${total.toLocaleString()} coins`, inline:true })
    .setColor(0xFF0000)
    .setTimestamp();

  try {
    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (ch?.isTextBased()) await ch.send({ embeds:[embed] });
  } catch(e){ console.error("Discord send error:", e); }
}

/* -------------  start-up  -------------------------------------- */
client.once("ready", ()=>{
  console.log(`Logged in as ${client.user.tag}`);
  app.listen(PORT, ()=>console.log("HTTP listening on", PORT));
});

client.login(DISCORD_BOT_TOKEN);
