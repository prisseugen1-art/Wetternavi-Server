// server/whatsapp.js

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

// ==================== KONFIGURATION ====================

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || './auth_info_baileys';
const WHITELIST = (process.env.WHATSAPP_WHITELIST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const RATE_LIMIT_MS = 3000;          // min. 3 Sek zwischen Nachrichten
const MAX_MSGS_PER_MINUTE = 8;        // max. 8 Nachrichten pro Minute
const AUTO_REPLY_ENABLED = process.env.WHATSAPP_AUTO_REPLY === 'true';
const AUTO_REPLY_ALLOWLIST = (process.env.WHATSAPP_AUTO_REPLY_ALLOWLIST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ==================== ZUSTAND ====================

let sock = null;
let connectionState = 'disconnected'; // disconnected | qr | connected
let currentQr = null;
let qrGeneratedAt = null;
let currentUserJid = null;

// Rate-Limiting
const lastSendTime = new Map();      // phone -> timestamp
const messagesThisMinute = [];        // timestamps

// Event-Handler
const messageListeners = [];

// ==================== LOGGER ====================

const logger = pino({ level: 'warn' }); // Baileys mag pino, aber wir wollen nicht alles

// ==================== HELFER ====================

/**
 * Normalisiert eine Telefonnummer auf reine Ziffern (z.B. 4915212345678).
 */
function normalizePhone(input) {
  if (!input) return '';
  let s = String(input).replace(/[\s\-().\/]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('0')) s = '49' + s.slice(1); // Default Deutschland
  return s;
}

/**
 * Prüft Whitelist. Wenn leer → alle erlaubt.
 */
function isAllowed(phone) {
  if (WHITELIST.length === 0) return true;
  const norm = normalizePhone(phone);
  return WHITELIST.some(w => normalizePhone(w) === norm);
}

/**
 * Rate-Limiting-Check.
 */
function checkRateLimit(phone) {
  const now = Date.now();
  const norm = normalizePhone(phone);

  // 1. Mindestabstand pro Nummer
  const last = lastSendTime.get(norm) || 0;
  if (now - last < RATE_LIMIT_MS) {
    const wait = RATE_LIMIT_MS - (now - last);
    throw new Error(`Rate-Limit: warte ${Math.ceil(wait / 1000)}s`);
  }

  // 2. Max pro Minute
  const cutoff = now - 60000;
  while (messagesThisMinute.length && messagesThisMinute[0] < cutoff) {
    messagesThisMinute.shift();
  }
  if (messagesThisMinute.length >= MAX_MSGS_PER_MINUTE) {
    throw new Error(`Rate-Limit: max. ${MAX_MSGS_PER_MINUTE} Nachrichten/Minute erreicht`);
  }

  return norm;
}

/**
 * Registriert einen erfolgreichen Sendevorgang.
 */
function registerSend(phone) {
  const norm = normalizePhone(phone);
  lastSendTime.set(norm, Date.now());
  messagesThisMinute.push(Date.now());
}

// ==================== BAileys-SESSION ====================

export async function initWhatsApp() {
  console.log('📱 Initialisiere WhatsApp-Baileys...');

  if (sock) {
    console.log('⚠️  WhatsApp-Session läuft bereits');
    return;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,  // Wir zeigen QR selbst
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,  // Wir wollen nicht "online" angezeigt werden
  });

  // ---- QR-Code ----
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionState = 'qr';
      currentQr = qr;
      qrGeneratedAt = new Date();
      console.log('\n════════════════════════════════════════════════');
      console.log('📱 WhatsApp-QR-Code – bitte mit dem Handy scannen:');
      console.log('   WhatsApp → Einstellungen → Verknüpfte Geräte');
      console.log('════════════════════════════════════════════════\n');
      qrcode.generate(qr, { small: true });
      console.log('\n════════════════════════════════════════════════');
    }

    if (connection === 'open') {
      connectionState = 'connected';
      currentQr = null;
      qrGeneratedAt = null;
      currentUserJid = sock.user?.id;
      console.log('✅ WhatsApp verbunden als:', currentUserJid);
      console.log('   Name:', sock.user?.name || '(unbekannt)');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      connectionState = 'disconnected';
      currentQr = null;
      currentUserJid = null;

      console.log('❌ WhatsApp-Verbindung geschlossen. Status:', statusCode);

      if (shouldReconnect) {
        console.log('🔄 Versuche Reconnect in 5 Sekunden...');
        sock = null;
        setTimeout(() => initWhatsApp().catch(e =>
          console.error('❌ Reconnect-Fehler:', e.message)
        ), 5000);
      } else {
        console.log('🚫 Ausgeloggt. Bitte QR-Code neu scannen.');
        sock = null;
      }
    }
  });

  // ---- Credentials speichern ----
  sock.ev.on('creds.update', saveCreds);

  // ---- Eingehende Nachrichten ----
  sock.ev.on('messages.upsert', async (msg) => {
    try {
      const m = msg.messages?.[0];
      if (!m) return;
      if (!m.message) return;
      if (m.key.fromMe) return;                    // Eigene Nachrichten ignorieren
      if (m.key.remoteJid === 'status@broadcast') return; // Status-Updates ignorieren

      const from = m.key.remoteJid || '';
      const isGroup = from.endsWith('@g.us');

      // Text extrahieren
      const text =
        m.message.conversation ||
        m.message.extendedTextMessage?.text ||
        m.message.imageMessage?.caption ||
        m.message.videoMessage?.caption ||
        '';

      if (!text && !m.message.imageMessage && !m.message.videoMessage) return;

      const fromName = m.pushName || 'Unbekannt';
      const phone = from.replace(/@.*$/, '');

      console.log(`📩 WhatsApp von ${fromName} (${phone}): "${text.substring(0, 80)}"`);

      // Event an Listener
      const payload = {
        from,
        fromName,
        phone,
        isGroup,
        text: text || '[Medien]',
        hasMedia: !!(m.message.imageMessage || m.message.videoMessage),
        timestamp: m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now(),
        raw: m,
      };

      for (const listener of messageListeners) {
        try {
          listener(payload);
        } catch (e) {
          console.error('❌ Listener-Fehler:', e.message);
        }
      }
    } catch (e) {
      console.error('❌ Nachrichten-Fehler:', e.message);
    }
  });

  return sock;
}

// ==================== SENDEN ====================

export async function sendWhatsAppMessage(phone, text) {
  if (!sock || connectionState !== 'connected') {
    throw new Error('WhatsApp nicht verbunden. Bitte QR-Code scannen.');
  }

  if (!text || !String(text).trim()) {
    throw new Error('Leerer Nachrichtentext');
  }

  if (!isAllowed(phone)) {
    throw new Error(`Nummer ${phone} ist nicht in der Whitelist.`);
  }

  const normPhone = checkRateLimit(phone);
  const jid = `${normPhone}@s.whatsapp.net`;

  console.log(`📤 Sende WhatsApp an ${normPhone}: "${text.substring(0, 80)}"`);

  await sock.sendMessage(jid, { text: String(text).trim() });
  registerSend(phone);

  return { success: true, to: normPhone };
}

// ==================== STATUS ====================

export function getWhatsAppStatus() {
  return {
    state: connectionState,
    qrAvailable: !!currentQr,
    qrAge: qrGeneratedAt ? Math.round((Date.now() - qrGeneratedAt.getTime()) / 1000) : null,
    userJid: currentUserJid,
    whitelistEnabled: WHITELIST.length > 0,
    whitelistCount: WHITELIST.length,
    autoReplyEnabled: AUTO_REPLY_ENABLED,
  };
}

export function getWhatsAppQr() {
  return currentQr;
}

// ==================== LISTENER ====================

export function onWhatsAppMessage(callback) {
  if (typeof callback === 'function') {
    messageListeners.push(callback);
  }
}

// ==================== MANUELL - DISCONNECT ====================

export async function disconnectWhatsApp() {
  if (sock) {
    try {
      await sock.logout();
    } catch (e) {
      // ignore
    }
    sock = null;
    connectionState = 'disconnected';
    console.log('🔌 WhatsApp getrennt');
  }
}
