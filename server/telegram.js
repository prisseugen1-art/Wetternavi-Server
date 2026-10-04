// server/telegram.js

import { Bot, webhookCallback, InputFile } from 'grammy';
import { generateTelegramReply, getTelegramSessionInfo, clearTelegramSession } from './telegram_agent.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'jony-webhook-secret';
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
      `Schreib mir einfach – ich antworte direkt.\n\n` +
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
      try {
        listener(payload);
      } catch (e) {
        console.error('❌ Telegram-Listener-Fehler:', e.message);
      }
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

  // Base64 → Buffer
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

  // 1. Header-Nachricht
  const headerLines = [
    `🎨 *${topic}*`,
    '',
    `${slides.length} Slides · ${images.length} Bilder`,
  ];
  await bot.api.sendMessage(chatId, headerLines.join('\n'), { parse_mode: 'Markdown' });

  // 2. Jedes Slide als Foto + Text
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

      // Rate-Limit-Schutz: 1 Sek zwischen Bildern
      if (imagesSent < sortedImages.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error(`❌ Fehler bei Slide ${img.n}:`, e.message);
      // Text als Fallback
      try {
        await bot.api.sendMessage(chatId, `Slide ${img.n}: ${title}\n\n${body}`);
      } catch (e2) {}
    }
  }

  console.log(`✅ Karussell an Telegram gesendet: ${imagesSent} Bilder`);

  return {
    success: true,
    to: chatId,
    imagesSent,
  };
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