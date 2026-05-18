import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, AttachmentBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import OpenAI from 'openai';
import http from 'http';
import fetch from 'node-fetch';

// ── Configuration ──────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const NVIDIA_API_KEY  = process.env.NVIDIA_API_KEY; // Kept for Qwen text chat
const PUTER_TOKEN     = process.env.PUTER_TOKEN;    // Replaced IMAGE_GEN_NVDA
const PORT            = process.env.PORT || 3000;

// ── Ratio → width/height map ───────────────────────────────────────────────────
const RATIO_MAP = {
  '1:1':  { width: 1024, height: 1024 },
  '16:9': { width: 1344, height: 768  },
  '9:16': { width: 768,  height: 1344 },
  '5:4':  { width: 1152, height: 896  },
  '4:5':  { width: 896,  height: 1152 },
  '3:2':  { width: 1216, height: 832  },
  '2:3':  { width: 832,  height: 1216 },
};

// Temp store: interactionId → prompt (while user picks ratio)
const pendingImages = new Map();
const BOT_NAME        = 'Cleverly';
const FREE_CHAT_CHANNEL = 'chat-with-cleverly';

// ── Validate env vars ──────────────────────────────────────────────────────────
if (!DISCORD_TOKEN)  { console.error('❌ Missing DISCORD_TOKEN');   process.exit(1); }
if (!NVIDIA_API_KEY) { console.error('❌ Missing NVIDIA_API_KEY');  process.exit(1); }
if (!PUTER_TOKEN)    { console.error('❌ Missing PUTER_TOKEN');     process.exit(1); }

console.log('✅ DISCORD_TOKEN found:',  DISCORD_TOKEN.slice(0, 10)  + '...');
console.log('✅ NVIDIA_API_KEY found:', NVIDIA_API_KEY.slice(0, 10) + '...');
console.log('✅ PUTER_TOKEN found:',    PUTER_TOKEN.slice(0, 10)    + '...');

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

// ── Image generation via Qwen Image 2.0 Pro (Puter) ────────────────────────────
async function generateImage(prompt, width = 1344, height = 768) {
  const response = await fetch(
    'https://api.puter.com/puterai/openai/v1/images/generations',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PUTER_TOKEN}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body: JSON.stringify({
        model: 'qwen/qwen-image-2.0-pro',
        prompt: prompt,
        size: `${width}x${height}`,
        response_format: 'b64_json',
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Puter API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const b64 = data?.data?.[0]?.b64_json;

  if (!b64) {
    console.error('❌ Full API response:', JSON.stringify(data));
    throw new Error(`No image data returned from API.`);
  }

  return Buffer.from(b64, 'base64');
}

// ── Register slash commands ────────────────────────────────────────────────────
async function registerCommands(clientId) {
  const commands = [
    new SlashCommandBuilder()
      .setName('image')
      .setDescription('Generate an image with Qwen Image 2.0 Pro')
      .addStringOption(opt =>
        opt.setName('prompt')
          .setDescription('Describe the image you want')
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

// ── Interaction handler: /image + ratio select menu ───────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  // Step 1 — /image command → show ratio dropdown
  if (interaction.isChatInputCommand() && interaction.commandName === 'image') {
    const prompt = interaction.options.getString('prompt');
    pendingImages.set(interaction.user.id, prompt);

    const menu = new StringSelectMenuBuilder()
      .setCustomId('ratio_select')
      .setPlaceholder('📐 Pick an aspect ratio...')
      .addOptions([
        { label: '1:1  — Square',     value: '1:1'  },
        { label: '16:9 — Landscape',  value: '16:9' },
        { label: '9:16 — Portrait',   value: '9:16' },
        { label: '5:4  — Classic',    value: '5:4'  },
        { label: '4:5  — Instagram',  value: '4:5'  },
        { label: '3:2  — Photo',      value: '3:2'  },
        { label: '2:3  — Tall Photo', value: '2:3'  },
      ]);

    const row = new ActionRowBuilder().addComponents(menu);

    await interaction.reply({
      content: `🎨 Prompt: **${prompt}**\n\n📐 Step 2 — Choose an aspect ratio:`,
      components: [row],
    });
    return;
  }

  // Step 2 — ratio picked → generate image
  if (interaction.isStringSelectMenu() && interaction.customId === 'ratio_select') {
    const ratio  = interaction.values[0];
    const prompt = pendingImages.get(interaction.user.id);
    pendingImages.delete(interaction.user.id);

    if (!prompt) {
      await interaction.update({ content: '⚠️ Session expired. Run `/image` again.', components: [] });
      return;
    }

    const { width, height } = RATIO_MAP[ratio];

    await interaction.update({
      content: `🎨 **${prompt}** | **${ratio}** (${width}×${height}) — ⏳ Generating...`,
      components: [],
    });

    try {
      const imageBuffer = await generateImage(prompt, width, height);
      const attachment  = new AttachmentBuilder(imageBuffer, { name: 'generated.png' });

      await interaction.editReply({
        content:    `🎨 **${prompt}** | **${ratio}** (${width}×${height})`,
        files:      [attachment],
        components: [],
      });
    } catch (err) {
      console.error('Image gen error:', err);
      await interaction.editReply({
        content:    `⚠️ Failed to generate image: \`${err.message}\``,
        components: [],
      });
    }
    return;
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
