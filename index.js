import { Client, GatewayIntentBits, Events } from 'discord.js';
import OpenAI from 'openai';
import http from 'http';

// ── Configuration ──────────────────────────────────────────────────────────────
const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const PORT           = process.env.PORT || 3000;
const BOT_NAME       = 'Cleverly';

// ── The channel where Cleverly replies to everyone without mention ──────────────
const FREE_CHAT_CHANNEL = 'chat-with-cleverly'; // 👈 must match your channel name exactly

// ── Validate env vars ──────────────────────────────────────────────────────────
if (!DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN environment variable!');
  process.exit(1);
}
if (!NVIDIA_API_KEY) {
  console.error('❌ Missing NVIDIA_API_KEY environment variable!');
  process.exit(1);
}

console.log('✅ DISCORD_TOKEN found:', DISCORD_TOKEN.slice(0, 10) + '...');
console.log('✅ NVIDIA_API_KEY found:', NVIDIA_API_KEY.slice(0, 10) + '...');

// ── HTTP keep-alive server ─────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`${BOT_NAME} is alive and running! 🤖`);
});
server.listen(PORT, () => {
  console.log(`🌐 Keep-alive server running on port ${PORT}`);
});

// ── OpenAI (NVIDIA) client ─────────────────────────────────────────────────────
const openai = new OpenAI({
  apiKey:  NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

// ── Conversation memory (per channel) ─────────────────────────────────────────
const MAX_HISTORY   = 10;
const conversations = new Map();

function getHistory(channelId) {
  if (!conversations.has(channelId)) conversations.set(channelId, []);
  return conversations.get(channelId);
}

function addToHistory(channelId, role, content) {
  const history = getHistory(channelId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

// ── Discord client ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once(Events.ClientReady, (bot) => {
  console.log(`✅ ${BOT_NAME} is online as ${bot.user.tag}`);
  bot.user.setActivity('your questions 🤖', { type: 3 });

  setInterval(() => {
    console.log(`💓 Heartbeat — ${BOT_NAME} still running at ${new Date().toISOString()}`);
  }, 5 * 60 * 1000);
});

// ── Auto-reconnect handlers ────────────────────────────────────────────────────
client.on(Events.ShardDisconnect, (event, id) => {
  console.warn(`⚠️ Shard ${id} disconnected. Reconnecting...`);
});
client.on(Events.ShardReconnecting, (id) => {
  console.log(`🔄 Shard ${id} reconnecting...`);
});
client.on(Events.ShardResume, (id, replayed) => {
  console.log(`✅ Shard ${id} resumed. Replayed ${replayed} events.`);
});

// ── Crash prevention ───────────────────────────────────────────────────────────
process.on('unhandledRejection', (err) => console.error('⚠️ Unhandled rejection:', err));
process.on('uncaughtException',  (err) => console.error('⚠️ Uncaught exception:', err));

// ── Message handler ────────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const inDM         = !message.guild;
  const mentioned    = message.mentions.has(client.user);
  const inFreeChannel = message.channel.name === FREE_CHAT_CHANNEL;

  // Reply if:
  // 1. It's a DM
  // 2. Bot is mentioned anywhere
  // 3. Message is in #chat-with-cleverly (no mention needed)
  if (!inDM && !mentioned && !inFreeChannel) return;

  // Strip mention if present
  const userText = message.content
    .replace(`<@${client.user.id}>`, '')
    .replace(`<@!${client.user.id}>`, '')
    .trim();

  if (!userText) {
    await message.reply(`Hey! I'm **${BOT_NAME}** 👋 Ask me anything!`);
    return;
  }

  await message.channel.sendTyping();

  const history = getHistory(message.channelId);
  addToHistory(message.channelId, 'user', userText);

  const apiMessages = [
    {
      role: 'system',
      content:
        `You are ${BOT_NAME}, a clever, friendly, and helpful AI assistant living inside Discord. ` +
        `You give concise, accurate answers. You're witty but never sarcastic. ` +
        `When writing code, always use markdown code blocks. Keep replies under 1900 characters when possible.`,
    },
    ...history,
  ];

  try {
    const stream = await openai.chat.completions.create({
      model:       'qwen/qwen3-coder-480b-a35b-instruct',
      messages:    apiMessages,
      temperature: 0.7,
      top_p:       0.8,
      max_tokens:  1024,
      stream:      true,
    });

    let reply = '';
    for await (const chunk of stream) {
      reply += chunk.choices[0]?.delta?.content || '';
    }

    reply = reply.trim();
    if (!reply) reply = '🤔 Hmm, I got an empty response. Try again?';

    addToHistory(message.channelId, 'assistant', reply);

    if (reply.length <= 1990) {
      await message.reply(reply);
    } else {
      const chunks = splitMessage(reply, 1990);
      for (const chunk of chunks) {
        await message.channel.send(chunk);
      }
    }
  } catch (err) {
    console.error('API error:', err);
    await message.reply(`⚠️ Something went wrong: \`${err.message}\``);
  }
});

// ── Helper: split long messages ────────────────────────────────────────────────
function splitMessage(text, maxLen) {
  const parts = [];
  while (text.length > maxLen) {
    let idx = text.lastIndexOf('\n', maxLen);
    if (idx === -1) idx = maxLen;
    parts.push(text.slice(0, idx));
    text = text.slice(idx).trimStart();
  }
  if (text) parts.push(text);
  return parts;
}

// ── Start ──────────────────────────────────────────────────────────────────────
client.login(DISCORD_TOKEN);
