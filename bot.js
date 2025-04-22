const express = require("express");
const bodyParser = require("body-parser");
const { Client, GatewayIntentBits, EmbedBuilder, Events } = require("discord.js");

require("dotenv").config();
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const app = express();
app.use(bodyParser.json());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const killCounts = {};
const deathCounts = {};
const lootTotals = {}; // Track total GP per killer

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);

  app.post("/logKill", async (req, res) => {
    const { killer, victim } = req.body;

    if (!killer || !victim) {
      return res.status(400).send("Missing killer or victim");
    }

    const killKey = `${killer}->${victim}`;
    killCounts[killKey] = (killCounts[killKey] || 0) + 1;
    deathCounts[victim] = (deathCounts[victim] || 0) + 1;

    const embed = new EmbedBuilder()
      .setTitle("\uD83D\uDC80 Kill Logged")
      .setDescription(`**${killer}** killed **${victim}**`)
      .addFields({ name: "Victim Kill Count", value: `${killCounts[killKey]}`, inline: true })
      .setColor(0xff0000)
      .setTimestamp();

    try {
      const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
      if (channel && channel.isTextBased()) {
        await channel.send({ embeds: [embed] });
        console.log(`Kill log sent: ${killer} killed ${victim}`);
        res.status(200).send("Kill logged successfully");
      } else {
        console.error("Could not fetch text channel");
        res.status(500).send("Discord channel fetch failed");
      }
    } catch (err) {
      console.error("Error sending message to Discord:", err);
      res.status(500).send("Discord error");
    }
  });

  app.post("/logLoot", async (req, res) => {
    const { lootMessage } = req.body;

    if (!lootMessage) {
      return res.status(400).send("Missing loot message");
    }

    const regex = /(.+?) has defeated (.+?) and received \((\d+,?\d*) coins\)/;
    const match = lootMessage.match(regex);

    if (!match) {
      return res.status(400).send("Invalid loot message format");
    }

    const [, killer, victim, gpStr] = match;
    const gp = parseInt(gpStr.replace(/,/g, ""));
    lootTotals[killer] = (lootTotals[killer] || 0) + gp;

    const embed = new EmbedBuilder()
      .setTitle("\uD83D\uDCB0 Loot Detected")
      .setDescription(`**${killer}** has defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
      .addFields({ name: "Total GP Gained", value: `${lootTotals[killer].toLocaleString()} coins`, inline: true })
      .setColor(0xFFD700)
      .setTimestamp();

    try {
      const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
      if (channel && channel.isTextBased()) {
        await channel.send({ embeds: [embed] });
        console.log("Loot message sent:", lootMessage);
        res.status(200).send("Loot message logged successfully");
      } else {
        res.status(500).send("Discord channel not available");
      }
    } catch (err) {
      console.error("Discord error:", err);
      res.status(500).send("Discord error");
    }
  });

  app.listen(3000, () => {
    console.log("Listening for kill logs on port 3000");
  });
});

client.on(Events.MessageCreate, async message => {
  if (message.content === "!hiscores") {
    let scoreboard = "\uD83C\uDFC6 **Monday Madness Hiscores** \uD83C\uDFC6\n\n";

    const killerTotals = {};
    for (const key in killCounts) {
      const [killer] = key.split("->");
      killerTotals[killer] = (killerTotals[killer] || 0) + killCounts[key];
    }

    const sortedKills = Object.entries(killerTotals).sort((a, b) => b[1] - a[1]);
    scoreboard += "**Top Killers**:\n";
    sortedKills.slice(0, 10).forEach(([name, count], i) => {
      scoreboard += `${i + 1}. **${name}** – ${count} kills\n`;
    });

    const sortedDeaths = Object.entries(deathCounts).sort((a, b) => b[1] - a[1]);
    scoreboard += `\n**Top Deaths**:\n`;
    sortedDeaths.slice(0, 10).forEach(([name, count], i) => {
      scoreboard += `${i + 1}. **${name}** – ${count} deaths\n`;
    });

    message.channel.send(scoreboard);
  }

  if (message.content === "!lootboard") {
    let lootboard = "\uD83D\uDCB0 **Top Loot Earners** \uD83D\uDCB0\n\n";
    const sortedLoot = Object.entries(lootTotals).sort((a, b) => b[1] - a[1]);
    sortedLoot.slice(0, 10).forEach(([name, gp], i) => {
      lootboard += `${i + 1}. **${name}** – ${gp.toLocaleString()} coins\n`;
    });
    message.channel.send(lootboard);
  }
});

client.login(DISCORD_BOT_TOKEN);