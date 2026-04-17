import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, AttachmentBuilder } from 'discord.js';
import OpenAI from 'openai';
import http from 'http';
import fetch from 'node-fetch';

// ── Configuration ──────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const NVIDIA_API_KEY  = process.env.NVIDIA_API_KEY;
const IMAGE_GEN_NVDA  = process.env.IMAGE_GEN_NVDA;
const PORT            = process.env.PORT || 3000;
const BOT_NAME        = 'Cleverly';
const FREE_CHAT_CHANNEL = 'chat-with-cleverly';

// ── Validate env vars ──────────────────────────────────────────────────────────
if (!DISCORD_TOKEN)  { console.error('❌ Missing DISCORD_TOKEN');   process.exit(1); }
if (!NVIDIA_API_KEY) { console.error('❌ Missing NVIDIA_API_KEY');  process.exit(1); }
if (!IMAGE_GEN_NVDA) { console.error('❌ Missing IMAGE_GEN_NVDA');  process.exit(1); }

console.log('✅ DISCORD_TOKEN found:',  DISCORD_TOKEN.slice(0, 10)  + '...');
console.log('✅ NVIDIA_API_KEY found:', NVIDIA_API_KEY.slice(0, 10) + '...');
console.log('✅ IMAGE_GEN_NVDA found:', IMAGE_GEN_NVDA.slice(0, 10) + '...');

// ── HTTP keep-alive server ─────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`${BOT_NAME} is alive and running! 🤖`);
});
server.listen(PORT, () => console.log(`🌐 Keep-alive server on port ${PORT}`));

// ── OpenAI (NVIDIA) chat client ────────────────────────────────────────────────
const openai = new OpenAI({
  apiKey:  NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

// ── Conversation memory ────────────────────────────────────────────────────────
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

// ── Image generation via NVIDIA FLUX.1-schnell ─────────────────────────────────
async function generateImage(prompt) {
  const response = await fetch('https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${IMAGE_GEN_NVDA}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      width: 1024,
      height: 1024,
      steps: 4,       // FLUX.1-schnell supports 1–4 steps
      cfg_scale: 0,   // Must be 0 for schnell
      seed: 0,        // 0 = random
      samples: 1,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Image API error: ${err}`);
  }

  const data = await response.json();

  // FLUX.1-schnell returns base64 image under artifacts[0].base64
  const b64 = data.artifacts?.[0]?.base64;
  if (!b64) throw new Error('No image returned from API');

  return Buffer.from(b64, 'base64');
}

// ── Register slash commands ────────────────────────────────────────────────────
async function registerCommands(clientId) {
  const commands = [
    new SlashCommandBuilder()
      .setName('image')
      .setDescription('Generate an image using FLUX.1-schnell AI')
      .addStringOption(opt =>
        opt.setName('prompt')
          .setDescription('Describe the image you want to generate')
          .setRequired(true)
      ),
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log('✅ Slash commands registered');
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

client.once(Events.ClientReady, async (bot) => {
  console.log(`✅ ${BOT_NAME} is online as ${bot.user.tag}`);
  bot.user.setActivity('your questions 🤖', { type: 3 });
  await registerCommands(bot.user.id);

  setInterval(() => {
    console.log(`💓 Heartbeat — ${new Date().toISOString()}`);
  }, 5 * 60 * 1000);
});

// ── Slash command handler ──────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'image') {
    const prompt = interaction.options.getString('prompt');

    await interaction.deferReply(); // Show "thinking..." while generating

    try {
      const imageBuffer = await generateImage(prompt);
      const attachment  = new AttachmentBuilder(imageBuffer, { name: 'generated.png' });

      await interaction.editReply({
        content: `🎨 Here's your image for: **${prompt}**`,
        files: [attachment],
      });
    } catch (err) {
      console.error('Image gen error:', err);
      await interaction.editReply(`⚠️ Failed to generate image: \`${err.message}\``);
    }
  }
});

// ── Auto-reconnect & crash prevention ─────────────────────────────────────────
client.on(Events.ShardDisconnect,   (e, id) => console.warn(`⚠️ Shard ${id} disconnected`));
client.on(Events.ShardReconnecting, (id)    => console.log(`🔄 Shard ${id} reconnecting...`));
client.on(Events.ShardResume,       (id, r) => console.log(`✅ Shard ${id} resumed. Replayed ${r}`));
process.on('unhandledRejection', (err) => console.error('⚠️ Unhandled rejection:', err));
process.on('uncaughtException',  (err) => console.error('⚠️ Uncaught exception:', err));

// ── Message handler ────────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const inDM          = !message.guild;
  const mentioned     = message.mentions.has(client.user);
  const inFreeChannel = message.channel.name === FREE_CHAT_CHANNEL;

  if (!inDM && !mentioned && !inFreeChannel) return;

  const userText = message.content
    .replace(`<@${client.user.id}>`, '')
    .replace(`<@!${client.user.id}>`, '')
    .trim();

  if (!userText) {
    await message.reply(`Hey! I'm **${BOT_NAME}** 👋 Ask me anything or use \`/image\` to generate images!`);
    return;
  }

  await message.channel.sendTyping();

  addToHistory(message.channelId, 'user', userText);

  const apiMessages = [
    {
      role: 'system',
      content:
        `You are ${BOT_NAME}, a clever, friendly, and helpful AI assistant living inside Discord. ` +
        `You give concise, accurate answers. You're witty but never sarcastic. ` +
        `When writing code, always use markdown code blocks. Keep replies under 1900 characters when possible.`,
    },
    ...getHistory(message.channelId),
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
      for (const chunk of chunks) await message.channel.send(chunk);
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
