import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, AttachmentBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import OpenAI from 'openai';
import http from 'http';
import fetch from 'node-fetch';

// ── Configuration ──────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const NVIDIA_API_KEY  = process.env.NVIDIA_API_KEY; 
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;    
const PORT            = process.env.PORT || 3000;

const BOT_NAME          = 'Cleverly';
const FREE_CHAT_CHANNEL = 'chat-with-cleverly';

// ── Validate env vars ──────────────────────────────────────────────────────────
if (!DISCORD_TOKEN)  { console.error('❌ Missing DISCORD_TOKEN');   process.exit(1); }
if (!NVIDIA_API_KEY) { console.error('❌ Missing NVIDIA_API_KEY');  process.exit(1); }
if (!GEMINI_API_KEY) { console.error('❌ Missing GEMINI_API_KEY');  process.exit(1); }

console.log('✅ DISCORD_TOKEN found:',  DISCORD_TOKEN.slice(0, 10)  + '...');
console.log('✅ NVIDIA_API_KEY found:', NVIDIA_API_KEY.slice(0, 10) + '...');
console.log('✅ GEMINI_API_KEY found:', GEMINI_API_KEY.slice(0, 10) + '...');

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

// ── Image generation via Google Gemini API ─────────────────────────────────────
async function generateImage(prompt, ratio) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${GEMINI_API_KEY}`;
  
  const payload = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        aspectRatio: ratio
      }
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Gemini API Error: ${res.status} - ${errorText}`);
  }

  const data = await res.json();
  
  try {
    // Gemini 3 Pro có thể trả về cả Text & Image, ta cần duyệt tìm phần Image (inlineData)
    const candidate = data.candidates[0];
    const part = candidate.content.parts.find(p => p.inlineData);
    
    if (!part || !part.inlineData || !part.inlineData.data) {
      throw new Error("No image data returned in the response.");
    }
    
    return Buffer.from(part.inlineData.data, 'base64');
  } catch (err) {
    console.error('❌ Unexpected response structure:', JSON.stringify(data, null, 2));
    throw new Error('Did not receive valid image data from API.');
  }
}

// ── Register slash commands ────────────────────────────────────────────────────
async function registerCommands(clientId) {
  const commands = [
    new SlashCommandBuilder()
      .setName('image')
      .setDescription('Generate an image with Gemini 3 Pro')
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

// ── State for pending ratio selections ─────────────────────────────────────────
const pendingImages = new Map();
const RATIOS = [
  { label: '1:1', value: '1:1' },
  { label: '1:4', value: '1:4' },
  { label: '1:8', value: '1:8' },
  { label: '2:3', value: '2:3' },
  { label: '3:2', value: '3:2' },
  { label: '3:4', value: '3:4' },
  { label: '4:1', value: '4:1' },
  { label: '4:3', value: '4:3' },
  { label: '4:5', value: '4:5' },
  { label: '5:4', value: '5:4' },
  { label: '8:1', value: '8:1' },
  { label: '9:16', value: '9:16' },
  { label: '16:9', value: '16:9' },
  { label: '21:9', value: '21:9' }
];

// ── Interaction handler: /image ───────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'image') {
    const prompt = interaction.options.getString('prompt');
    pendingImages.set(interaction.user.id, prompt);

    const menu = new StringSelectMenuBuilder()
      .setCustomId('ratio_select')
      .setPlaceholder('📐 Pick an aspect ratio...')
      .addOptions(RATIOS);

    const row = new ActionRowBuilder().addComponents(menu);

    await interaction.reply({
      content: `🎨 **Prompt:** ${prompt}\n\n📐 Step 2 — Choose an aspect ratio:`,
      components: [row],
    });
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'ratio_select') {
    const ratio  = interaction.values[0];
    const prompt = pendingImages.get(interaction.user.id);
    pendingImages.delete(interaction.user.id);

    if (!prompt) {
      await interaction.update({ content: '⚠️ Session expired. Run `/image` again.', components: [] });
      return;
    }

    await interaction.update({
      content: `🎨 **Prompt:** ${prompt} | **Ratio:** ${ratio} — ⏳ Generating...`,
      components: [],
    });

    try {
      const imageBuffer = await generateImage(prompt, ratio);
      const attachment  = new AttachmentBuilder(imageBuffer, { name: 'generated.png' });

      await interaction.editReply({
        content: `🎨 **${prompt}** | **Ratio:** ${ratio}`,
        files: [attachment],
      });
    } catch (err) {
      console.error('Image gen error:', err);
      await interaction.editReply({
        content: `⚠️ Failed to generate image: \`${err.message}\``,
      });
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
