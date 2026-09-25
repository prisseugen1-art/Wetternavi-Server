// server/telegram.js

import { Bot, webhookCallback } from 'grammy';
import { generateTelegramReply, getTelegramSessionInfo, clearTelegramSession } from './telegram_agent.js';

// ==================== KONFIGURATION ====================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'jony-webhook-secret';
const ALLOWED_CHAT_IDS = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ==================== ZUSTAND ====================

let bot = null;
const messageListeners = [];
let botUsername = null;

// ==================== HELFER ====================

function isAllowed(chatId) {
  if (ALLOWED_CHAT_IDS.length === 0) return true;
  return ALLOWED_CHAT_IDS.includes(String(chatId));
}

function sanitizeText(text) {
  if (!text) return '';
  return String(text).trim().substring(0, 4000);
}

// ==================== BOT INITIALISIEREN ====================

export async function initTelegram() {
  if (!BOT_TOKEN) {
    console.log('⚠️  TELEGRAM_BOT_TOKEN fehlt – Telegram wird übersprungen');
    return null;
  }

  console.log('📱 Initialisiere Telegram-Bot...');

  bot = new Bot(BOT_TOKEN);

  // ---- /start Command ----
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
      `Verfügbare Modi:\n` +
      `• "Jony, Party" → Party-Modus\n` +
      `• "Jony, Freund" → Freund-Modus (Standard)\n\n` +
      `📌 Deine Chat-ID: \`${chatId}\``,
      { parse_mode: 'Markdown' }
    );
  });

  // ---- /id Command ----
  bot.command('id', async (ctx) => {
    await ctx.reply(`Deine Chat-ID: \`${ctx.chat.id}\``, { parse_mode: 'Markdown' });
  });

  // ---- /status Command ----
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

  // ---- /reset Command ----
  bot.command('reset', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!isAllowed(chatId)) return;
    clearTelegramSession(chatId);
    await ctx.reply('🔄 Session zurückgesetzt. Wir fangen neu an.');
  });

  // ---- Eingehende Text-Nachrichten ----
  bot.on('message:text', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!isAllowed(chatId)) return;

    const text = sanitizeText(ctx.message.text);
    if (!text) return;

    const fromName = ctx.from?.first_name || 'Unbekannt';
    const username = ctx.from?.username ? `@${ctx.from.username}` : '';

    console.log(`📩 Telegram von ${fromName} ${username} (${chatId}): "${text.substring(0, 80)}"`);

    // Event an Listener weitergeben (falls App offen ist)
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

    // ==================== AUTONOME ANTWORT ====================
    try {
      // Typing-Indikator senden
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

  // ---- Bot-Info ----
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

// ==================== SENDEN (falls manuell aus App nötig) ====================

export async function sendTelegramMessage(chatId, text) {
  if (!bot) throw new Error('Telegram-Bot nicht initialisiert');
  const cleanText = sanitizeText(text);
  if (!cleanText) throw new Error('Leerer Nachrichtentext');
  console.log(`📤 Sende Telegram an ${chatId}: "${cleanText.substring(0, 80)}"`);
  await bot.api.sendMessage(chatId, cleanText);
  return { success: true, to: chatId };
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
      hasCustomCertificate: info.has_custom_certificate,
      pendingUpdateCount: info.pending_update_count,
      lastErrorDate: info.last_error_date,
      lastErrorMessage: info.last_error_message,
      maxConnections: info.max_connections,
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