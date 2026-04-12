import { Client, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";
import axios from "axios";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const openai = new OpenAI({
  apiKey: NVIDIA_API_KEY,
  baseURL: "https://integrate.api.nvidia.com/v1",
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Trigger only when user types cleverly ...
  if (!message.content.toLowerCase().startsWith("cleverly")) return;

  const prompt = message.content.replace(/^cleverly/i, "").trim();
  if (!prompt) return;

  try {
    const completion = await openai.chat.completions.create({
      model: "qwen/qwen3-coder-480b-a35b-instruct",
      messages: [
        {
          role: "system",
          content:
            "You are Cleverly, a friendly smart Discord AI assistant. Keep replies short and helpful.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
      top_p: 0.8,
      max_tokens: 400,
    });

    const reply = completion.choices[0].message.content;

    await axios.post(WEBHOOK_URL, {
      username: "Cleverly",
      content: reply,
    });
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);

    await axios.post(WEBHOOK_URL, {
      username: "Cleverly",
      content: "⚠️ NVIDIA AI error. Try again later.",
    });
  }
});

client.login(DISCORD_BOT_TOKEN);
