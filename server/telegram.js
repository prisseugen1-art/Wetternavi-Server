// server/telegram.js

import { Bot, webhookCallback, InputFile } from 'grammy';
import { generateTelegramReply, getTelegramSessionInfo, clearTelegramSession } from './telegram_agent.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'jony-webhook-secret';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ALLOWED_CHAT_IDS = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

let bot = null;
const messageListeners = [];
let botUsername = null;

function isAllowed(chatId) {
  if (ALLOWED_CHAT_IDS.length === 0) return true;
  return ALLOWED_CHAT_IDS.includes(String(chatId));
}

function sanitizeText(text) {
  if (!text) return '';
  return String(text).trim().substring(0, 4000);
}
// ==================== GOOGLE TTS ====================

const TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY;

async function textToSpeech(text) {
  if (!TTS_API_KEY) throw new Error('GOOGLE_TTS_API_KEY fehlt');

  // Text begrenzen (TTS-API max 5000 Zeichen pro Call)
  const cleanText = String(text).trim().substring(0, 4000);
  if (!cleanText) throw new Error('Leerer Text');

  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${TTS_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: cleanText },
              voice: {
          languageCode: 'de-DE',
          name: 'de-DE-Neural2-D',  // Männlich, kräftig — passt zu Jony
          ssmlGender: 'MALE',
        },
        audioConfig: {
          audioEncoding: 'OGG_OPUS',
          speakingRate: 1.0,
          pitch: 0.0,
        },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`TTS HTTP ${res.status}: ${errText.substring(0, 200)}`);
  }

  const data = await res.json();
  if (!data.audioContent) throw new Error('Kein Audio zurückgegeben');

  // Base64 → Buffer
  return Buffer.from(data.audioContent, 'base64');
}

// ==================== GROQ WHISPER (STT) ====================

async function transcribeAudio(audioBuffer, filename = 'voice.ogg') {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY fehlt');

  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
  formData.append('file', blob, filename);
  formData.append('model', 'whisper-large-v3');
  formData.append('response_format', 'json');
  // language NICHT setzen → Whisper erkennt DE/RU automatisch

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Whisper HTTP ${res.status}: ${errText.substring(0, 200)}`);
  }

  const data = await res.json();
  return (data.text || '').trim();
}

async function downloadTelegramFile(fileId) {
  if (!bot) throw new Error('Bot nicht initialisiert');
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download HTTP ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ==================== INIT ====================

export async function initTelegram() {
  if (!BOT_TOKEN) {
    console.log('⚠️  TELEGRAM_BOT_TOKEN fehlt – Telegram wird übersprungen');
    return null;
  }

  console.log('📱 Initialisiere Telegram-Bot...');

  bot = new Bot(BOT_TOKEN);

  bot.command('start', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!isAllowed(chatId)) {
      await ctx.reply('⛔ Dieser Bot ist privat.');
      return;
    }

    const name = ctx.from?.first_name || 'du';
    console.log(`📱 Telegram /start von ${name} (${chatId})`);

    await ctx.reply(
      `Hallo ${name}! 👋\n\n` +
      `Ich bin Jony, dein Begleiter.\n\n` +
      `Schreib mir – oder schick mir eine Sprachnachricht 🎤\n\n` +
      `📌 Deine Chat-ID: \`${chatId}\``,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('id', async (ctx) => {
    await ctx.reply(`Deine Chat-ID: \`${ctx.chat.id}\``, { parse_mode: 'Markdown' });
  });

  bot.command('status', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!isAllowed(chatId)) {
      await ctx.reply('⛔ Dieser Bot ist privat.');
      return;
    }
    const info = getTelegramSessionInfo(chatId);
    const roleText = info ? `Rolle: ${info.role}, Verlauf: ${info.historyLength}` : 'Keine aktive Session';
    await ctx.reply(`✅ Jony ist online.\n${roleText}`);
  });

  bot.command('reset', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!isAllowed(chatId)) return;
    clearTelegramSession(chatId);
    await ctx.reply('🔄 Session zurückgesetzt.');
  });

  // ==================== TEXT-NACHRICHTEN ====================

  bot.on('message:text', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!isAllowed(chatId)) return;

    const text = sanitizeText(ctx.message.text);
    if (!text) return;

    const fromName = ctx.from?.first_name || 'Unbekannt';
    const username = ctx.from?.username ? `@${ctx.from.username}` : '';

    console.log(`📩 Telegram von ${fromName} ${username} (${chatId}): "${text.substring(0, 80)}"`);

    const payload = {
      chatId,
      fromName,
      username,
      text,
      timestamp: (ctx.message.date || Math.floor(Date.now() / 1000)) * 1000,
      isGroup: ctx.chat.type !== 'private',
      chatTitle: ctx.chat.title || null,
    };

    for (const listener of messageListeners) {
      try { listener(payload); } catch (e) { console.error('❌ Listener:', e.message); }
    }

    try {
      await ctx.replyWithChatAction('typing');
      const reply = await generateTelegramReply(chatId, text, null);
      if (reply && reply.trim()) {
        await ctx.reply(reply);
        console.log(`📤 Telegram-Antwort gesendet an ${chatId}`);
      }
    } catch (e) {
      console.error('❌ Telegram-Antwort-Fehler:', e.message);
      await ctx.reply('Sorry, ich hab grad Probleme. Versuch\'s nochmal.').catch(() => {});
    }
  });

  // ==================== VOICE-NACHRICHTEN ====================

  bot.on('message:voice', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!isAllowed(chatId)) return;

    const fromName = ctx.from?.first_name || 'Unbekannt';
    const voice = ctx.message.voice;
    const duration = voice.duration || 0;

    console.log(`🎤 Telegram-Voice von ${fromName} (${chatId}): ${duration}s`);

    // Max-Größe: ~5 Min
    if (duration > 300) {
      await ctx.reply('⏱️ Sprachnachricht zu lang (max 5 Min).');
      return;
    }

    try {
      await ctx.replyWithChatAction('typing');

      // 1. Audio runterladen
      console.log(`   ⬇️ Lade Audio...`);
      const audioBuffer = await downloadTelegramFile(voice.file_id);
      console.log(`   ✅ Audio: ${Math.round(audioBuffer.length / 1024)} KB`);

      // 2. Whisper → Text
      console.log(`   🎯 Whisper transkribiert...`);
      const text = await transcribeAudio(audioBuffer);

      if (!text) {
        await ctx.reply('🤔 Konnte nichts verstehen. Nochmal?');
        return;
      }

      console.log(`   📝 Erkannt: "${text}"`);

      // Optional: zeige Transkription
      // await ctx.reply(`_${text}_`, { parse_mode: 'Markdown' });

      // 3. Payload an Listener
      const payload = {
        chatId,
        fromName,
        username: ctx.from?.username ? `@${ctx.from.username}` : '',
        text,
        isVoice: true,
        timestamp: (ctx.message.date || Math.floor(Date.now() / 1000)) * 1000,
        isGroup: ctx.chat.type !== 'private',
        chatTitle: ctx.chat.title || null,
      };

      for (const listener of messageListeners) {
        try { listener(payload); } catch (e) { console.error('❌ Listener:', e.message); }
      }

                 // 4. Antwort generieren
      const reply = await generateTelegramReply(chatId, text, null);
      if (reply && reply.trim()) {
        // Antwort als TEXT (mit Hinweis auf Transkription)
        await ctx.reply(`📝 _"${text}"_\n\n${reply}`, { parse_mode: 'Markdown' });
        console.log(`📤 Telegram-Antwort (Text) an ${chatId}`);
      }
    } catch (e) {
      console.error('❌ Voice-Handler-Fehler:', e.message);
      await ctx.reply('Sorry, ich konnte die Sprachnachricht nicht verarbeiten.').catch(() => {});
    }
  });

  // ==================== BOT-START ====================

  try {
    const me = await bot.api.getMe();
    botUsername = me.username;
    console.log(`✅ Telegram-Bot verbunden: @${botUsername}`);
  } catch (e) {
    console.error('❌ Telegram-Bot-Verbindung fehlgeschlagen:', e.message);
    return null;
  }

  return bot;
}

// ==================== TEXT SENDEN ====================

export async function sendTelegramMessage(chatId, text) {
  if (!bot) throw new Error('Telegram-Bot nicht initialisiert');
  const cleanText = sanitizeText(text);
  if (!cleanText) throw new Error('Leerer Nachrichtentext');
  console.log(`📤 Sende Telegram an ${chatId}: "${cleanText.substring(0, 80)}"`);
  await bot.api.sendMessage(chatId, cleanText);
  return { success: true, to: chatId };
}

// ==================== FOTO SENDEN ====================

export async function sendTelegramPhoto(chatId, base64Data, caption = '') {
  if (!bot) throw new Error('Telegram-Bot nicht initialisiert');
  if (!base64Data) throw new Error('base64Data erforderlich');

  const buffer = Buffer.from(base64Data, 'base64');
  const inputFile = new InputFile(buffer, 'slide.jpg');

  console.log(`📤 Sende Telegram-Foto an ${chatId} (${Math.round(buffer.length / 1024)} KB)`);

  const result = await bot.api.sendPhoto(chatId, inputFile, {
    caption: caption ? caption.substring(0, 1024) : undefined,
  });

  return { success: true, to: chatId, messageId: result.message_id };
}

// ==================== KARUSSELL SENDEN ====================

export async function sendTelegramCarousel(chatId, topic, slides = [], images = []) {
  if (!bot) throw new Error('Telegram-Bot nicht initialisiert');
  if (!chatId) throw new Error('chat_id erforderlich');

  console.log(`📨 Sende Karussell "${topic}" an ${chatId} (${images.length} Bilder)`);

  const headerLines = [
    `🎨 *${topic}*`,
    '',
    `${slides.length} Slides · ${images.length} Bilder`,
  ];
  await bot.api.sendMessage(chatId, headerLines.join('\n'), { parse_mode: 'Markdown' });

  let imagesSent = 0;
  const sortedImages = [...images].sort((a, b) => a.n - b.n);

  for (const img of sortedImages) {
    const slide = slides.find(s => s.slide === img.n) || {};
    const title = slide.title || `Slide ${img.n}`;
    const body = slide.body || '';
    const caption = `${img.n}. ${title}\n\n${body}`;

    try {
      await sendTelegramPhoto(chatId, img.data, caption);
      imagesSent++;
      if (imagesSent < sortedImages.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error(`❌ Fehler bei Slide ${img.n}:`, e.message);
      try {
        await bot.api.sendMessage(chatId, `Slide ${img.n}: ${title}\n\n${body}`);
      } catch (e2) {}
    }
  }

  console.log(`✅ Karussell an Telegram gesendet: ${imagesSent} Bilder`);

  return { success: true, to: chatId, imagesSent };
}

// ==================== WEBHOOK ====================

export function getTelegramWebhookCallback() {
  if (!bot) return null;
  return webhookCallback(bot, 'express');
}

export function getTelegramWebhookPath() {
  return `/webhook/telegram/${WEBHOOK_SECRET}`;
}

export async function setTelegramWebhook(publicDomain) {
  if (!bot) return;
  const webhookUrl = `https://${publicDomain}${getTelegramWebhookPath()}`;
  try {
    await bot.api.setWebhook(webhookUrl, {
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message'],
    });
    console.log(`✅ Telegram-Webhook registriert: ${webhookUrl}`);
  } catch (e) {
    console.error('❌ Telegram-Webhook-Fehler:', e.message);
  }
}

export async function getTelegramWebhookInfo() {
  if (!bot) return { error: 'Bot nicht initialisiert' };
  try {
    const info = await bot.api.getWebhookInfo();
    return {
      url: info.url || '(keine URL gesetzt)',
      pendingUpdateCount: info.pending_update_count,
      lastErrorMessage: info.last_error_message,
      allowedUpdates: info.allowed_updates,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ==================== STATUS ====================

export function getTelegramStatus() {
  return {
    initialized: !!bot,
    botUsername: botUsername || null,
    allowedChatIdsCount: ALLOWED_CHAT_IDS.length,
    whitelistEnabled: ALLOWED_CHAT_IDS.length > 0,
  };
}

// ==================== LISTENER ====================

export function onTelegramMessage(callback) {
  if (typeof callback === 'function') {
    messageListeners.push(callback);
  }
}
