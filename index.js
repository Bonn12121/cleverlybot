import { Client, GatewayIntentBits, Events } from 'discord.js';
import OpenAI from 'openai';

// ── Configuration ──────────────────────────────────────────────────────────────
const DISCORD_TOKEN = 'YOUR_DISCORD_BOT_TOKEN';   // 👈 Replace this
const BOT_NAME      = 'Cleverly';

const openai = new OpenAI({
  apiKey:  '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',
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

// ── Conversation memory (per channel) ─────────────────────────────────────────
// Stores the last N messages so Cleverly remembers context
const MAX_HISTORY   = 10;
const conversations = new Map(); // channelId → [ {role, content}, … ]

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
    GatewayIntentBits.MessageContent,   // Required to read message text
    GatewayIntentBits.DirectMessages,
  ],
});

client.once(Events.ClientReady, (bot) => {
  console.log(`✅ ${BOT_NAME} is online as ${bot.user.tag}`);
  bot.user.setActivity('your questions 🤖', { type: 3 }); // "Watching your questions"
});

// ── Message handler ────────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  // Ignore bots & messages that don't mention Cleverly (in servers)
  if (message.author.bot) return;

  const inDM      = !message.guild;
  const mentioned = message.mentions.has(client.user);

  // Reply when: DM  OR  mentioned in a server
  if (!inDM && !mentioned) return;

  // Strip the mention from the text
  const userText = message.content
    .replace(`<@${client.user.id}>`, '')
    .replace(`<@!${client.user.id}>`, '')
    .trim();

  if (!userText) {
    await message.reply(`Hey! I'm **${BOT_NAME}** 👋 Ask me anything!`);
    return;
  }

  // Show typing indicator
  await message.channel.sendTyping();

  // Build the messages array for the API
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
    // Stream the response from NVIDIA / Qwen
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

    // Save assistant reply to history
    addToHistory(message.channelId, 'assistant', reply);

    // Discord has a 2000-char limit — split if needed
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
