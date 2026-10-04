// server/chat.js

import { GoogleGenAI } from '@google/genai';
import pg from 'pg';
import OpenAI from 'openai';
import { broadcastToClients } from './gemini_live.js';
import { sendCarouselByEmail } from './email.js';
import { setScript, addImage, getCarousel } from './carousel_store.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:' + (process.env.PORT || 8080);

const CHAT_MODELS = [
  'gemini-3.8-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
];

const GROQ_FALLBACKS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
];

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

// ==================== KONFIG ====================

const CHAT_SESSION_RESET_MS = 8 * 60 * 60 * 1000;

// ==================== DRAFT-SPEICHER ====================

const draftStore = new Map();
const DRAFT_TTL_MS = 10 * 60 * 1000;

function cleanOldDrafts() {
  const now = Date.now();
  let cleaned = 0;
  for (const [userId, draft] of draftStore.entries()) {
    if ((now - draft.createdAt) > DRAFT_TTL_MS) {
      draftStore.delete(userId);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`🧹 ${cleaned} abgelaufene Drafts gelöscht`);
}

setInterval(cleanOldDrafts, 60 * 1000);

export function setDraft(userId, draft) {
  if (!userId) return null;
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    ...draft,
    createdAt: Date.now(),
  };
  draftStore.set(userId, item);
  console.log(`📝 Draft gespeichert für ${userId.substring(0,8)}...: an ${draft.to}`);
  return item;
}

export function getDraft(userId) {
  if (!userId) return null;
  const draft = draftStore.get(userId);
  if (!draft) return null;
  if ((Date.now() - draft.createdAt) > DRAFT_TTL_MS) {
    draftStore.delete(userId);
    return null;
  }
  return draft;
}

export function clearDraft(userId) {
  if (!userId) return false;
  const had = draftStore.has(userId);
  draftStore.delete(userId);
  if (had) console.log(`🧹 Draft gelöscht für ${userId.substring(0,8)}...`);
  return had;
}

// ==================== KONTEXT ====================

function getTimeContext() {
  const now = new Date();
  const hour = now.getHours();
  let timeOfDay;
  if (hour >= 5 && hour < 11) timeOfDay = 'Morgen';
  else if (hour >= 11 && hour < 14) timeOfDay = 'Mittag';
  else if (hour >= 14 && hour < 18) timeOfDay = 'Nachmittag';
  else if (hour >= 18 && hour < 22) timeOfDay = 'Abend';
  else timeOfDay = 'Nacht';
  const weekday = now.toLocaleDateString('de-DE', { weekday: 'long' });
  return weekday + (timeOfDay === 'Morgen' ? 'morgen' : ', ' + timeOfDay);
}

// ==================== FUNDAMENT (für ALLE Modi) ====================

const LANGUAGE_RULE = [
  'SPRACHREGEL: Antworte auf Deutsch oder Russisch – je nachdem, in welcher Sprache der Nutzer schreibt.',
  'Bei anderen Sprachen: ignoriere und mach auf Deutsch weiter. Keine Sprach-Belehrung.',
].join('\n');

const ANTI_REPETITION = [
  'ANTI-WIEDERHOLUNG:',
  '- Nicht immer dieselbe Begrüßung.',
  '- Nicht immer "Wie geht\'s dir?".',
  '- Variiere Satzlängen und Themen.',
  '- Kurz und knapp (1-3 Sätze im Chat).',
].join('\n');

const TONE_RULES = [
  '===========================================',
  '🎭 TON-SYSTEM',
  '===========================================',
  '',
  'Beim Verfassen von E-Mails wählst du IMMER einen Ton:',
  '- "formell"     → Behörden, Firmen, unbekannte Erwachsene',
  '- "persönlich"  → Freunde, Familie, bekannte Erwachsene',
  '- "locker"      → enge Freunde, Kinder, Familie (informell)',
  '',
  'A) NEUER KONTAKT: → Frage "Formell, persönlich oder locker?"',
  'B) BEKANNTER KONTAKT: → Kein Nachfragen, nutze gespeicherten Ton',
  'C) BEHÖRDEN: → Automatisch formell, kein Nachfragen',
  'D) TON-WECHSEL nur auf explizite Aufforderung',
].join('\n');

const CONTACT_RULES = [
  '===========================================',
  '📇 KONTAKT- & GRUPPEN-GEDÄCHTNIS',
  '===========================================',
  '',
  '🚨 EISERNE REGELN 🚨',
  '',
  'REGEL 1: NIEMALS eine E-Mail verfassen, bevor du:',
  '  a) Weißt welcher TON',
  '  b) Die E-Mail-ADRESSE des Empfängers kennst',
  '',
  'REGEL 2: NIEMALS eine E-Mail versenden, ohne Bestätigung des Nutzers.',
  '',
  'PFLICHT-ABLAUF bei "Schreib an [Name/Gruppe]":',
  '',
  'Schritt 1: find_contact(name) UND find_group(name) aufrufen',
  '',
  'Schritt 2:',
  '  - EINZELKONTAKT: → Ton + Adresse übernehmen → Schritt 5',
  '  - GRUPPE: → alle Mitglieder auflösen',
  '  - NICHT GEFUNDEN: → STOPP! → Schritt 3',
  '',
  'Schritt 3: Behörde? → formell. Sonst: Frage nach Ton.',
  '',
  'Schritt 4: Frage nach E-Mail-Adresse → WARTE',
  '',
  'Schritt 5: show_draft(to, subject, body, tone) aufrufen',
  '',
  'Schritt 6: WARTE auf Reaktion (siehe ENTWURF-REGEL)',
  '',
  'Schritt 7: send_email nach Bestätigung',
  '',
  'KONTAKT-VERWALTUNG:',
  '- "Vergiss Alex" → forget_contact',
  '- "Welche Kontakte kenne ich?" → list_contacts',
  '',
  '👥 GRUPPEN:',
  '- "Meine Familie sind Mama, Papa, Alex" → save_group',
  '- "Schreib an meine Familie" → find_group',
  '- "Welche Gruppen habe ich?" → list_groups',
  '',
  'NUTZER-PROFIL:',
  '- "Ich bin Eugen Priss" → save_user_profile(name)',
  '- "Ich wohne in ..." → save_user_profile(address)',
  '- "Meine E-Mail ist ..." → save_user_profile(default_email)',
].join('\n');

const DRAFT_CONFIRMATION = [
  '===========================================',
  '📝 ENTWURF-REGEL (gilt für NORMALE E-Mails)',
  '===========================================',
  '',
  '⚠️ GILT NICHT für Karussells! (siehe Business-Workflow)',
  '',
  'Wenn Ton + Adresse geklärt sind → show_draft aufrufen.',
  '',
  '⛔ SCHREIBE DEN ENTWURF NIEMALS ALS TEXT!',
  '',
  'Die App zeigt die Karte automatisch.',
  'Du antwortest nur: "Entwurf ist da. Prüf ihn."',
  '',
  '✅ JA-WÖRTER (send_email aufrufen):',
  '- "ja" / "ok" / "senden" / "schick weg" / "raus damit" / "los"',
  '',
  '❌ NEIN-WÖRTER (verwerfen):',
  '- "nein" / "abbrechen" / "löschen" / "vergiss es" / "ändern"',
  '',
  'NACH DEM SENDEN: "✅ Ist raus."',
  'NACH DEM VERWERFEN: "Okay, verworfen."',
].join('\n');

const SIGNATURE_RULE = [
  '✍️ SIGNATUR-REGEL: Du schreibst KEINE Signatur. Der Server hängt sie an.',
].join('\n');

const ATTACHMENT_RULE = [
  '📎 ANHANG-REGEL: Anhänge werden AUTOMATISCH mitgeschickt.',
].join('\n');

const TELEGRAM_RULE = [
  '📨 TELEGRAM: send_telegram_message(chat_id, text)',
  'Standard-Eugen: 8448058381',
  'Frage IMMER zuerst nach Bestätigung.',
].join('\n');

const STANDORT_RULE = [
  '📍 STANDORT: "hier"/"bei mir" → aktueller Standort.',
].join('\n');

// ==================== FUNDAMENT-BAUSTEIN (★ GEFIXT ★) ====================

function buildFoundation(profile, attachments = []) {
  const today = new Date().toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const timeCtx = getTimeContext();
  const name = profile.user_name || profile.name || 'Nutzer';

  // ═════════════════════════════════════════════════════
  // ✅ FUNDAMENT-FIX: KOMPLETTES user_data in den Prompt
  // ═════════════════════════════════════════════════════

  const INTERNAL_KEYS = new Set([
    'user_id', 'current_lat', 'current_lon', 'current_city',
  ]);

  const PROFILE_LABELS = {
    user_name: 'Name',
    user_address: 'Adresse',
    user_birthdate: 'Geburtsdatum',
    user_phone: 'Telefon',
    user_email_default: 'Standard-E-Mail',
    user_tone_default: 'Standard-Ton',
    name: 'Name',
    nickname: 'Spitzname',
    age: 'Alter',
    hometown: 'Heimatstadt',
  };

  // ---- 1. Nutzer-Profil-Felder (dedupliziert) ----
  const profileLines = [];
  const seenLabels = new Set();
  for (const key of Object.keys(profile || {})) {
    if (INTERNAL_KEYS.has(key)) continue;
    const label = PROFILE_LABELS[key];
    if (!label || seenLabels.has(label)) continue;
    const val = String(profile[key] || '').trim();
    if (!val) continue;
    seenLabels.add(label);
    profileLines.push(label + ': ' + val);
  }
  if (!seenLabels.has('Standard-E-Mail')) {
    profileLines.push('Standard-E-Mail: eugen.priss@yahoo.com');
  }

  // ---- 2. Kontakte aus contact_*_* ----
  const contactsMap = new Map();
  for (const [key, rawVal] of Object.entries(profile || {})) {
    const m = key.match(/^contact_(.+?)_(email|telegram|phone|aliases|relation|birthday|tone|notes|learned)$/);
    if (!m) continue;
    const [, cname, field] = m;
    if (rawVal === null || rawVal === undefined) continue;
    const v = String(rawVal).trim();
    if (!v) continue;
    if (!contactsMap.has(cname)) contactsMap.set(cname, {});
    contactsMap.get(cname)[field] = v;
  }
  const contactLines = [];
  for (const [cname, c] of [...contactsMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!c.email && !c.telegram && !c.phone && !c.relation && !c.notes) continue;
    const meta = [];
    if (c.relation) meta.push('Relation: ' + c.relation);
    if (c.tone) meta.push('Ton: ' + c.tone);
    if (c.birthday) meta.push('Geburtstag: ' + c.birthday);
    if (c.aliases) meta.push('Aliase: ' + c.aliases);
    const info = [];
    if (c.email) info.push('E-Mail: ' + c.email);
    if (c.telegram) info.push('Telegram: ' + c.telegram);
    if (c.phone) info.push('Tel: ' + c.phone);
    let line = '- ' + cname;
    if (meta.length) line += ' (' + meta.join(', ') + ')';
    if (info.length) line += ' → ' + info.join(' | ');
    if (c.notes) line += ' — Notiz: ' + c.notes;
    contactLines.push(line);
  }

  // ---- 3. Gruppen aus group_*_* ----
  const groupsMap = new Map();
  for (const [key, rawVal] of Object.entries(profile || {})) {
    const m = key.match(/^group_(.+?)_(members|notes|learned)$/);
    if (!m) continue;
    const [, gname, field] = m;
    if (rawVal === null || rawVal === undefined) continue;
    const v = String(rawVal).trim();
    if (!v) continue;
    if (!groupsMap.has(gname)) groupsMap.set(gname, {});
    groupsMap.get(gname)[field] = v;
  }
  const groupLines = [];
  for (const [gname, g] of [...groupsMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!g.members) continue;
    const members = g.members.split(',').map(s => s.trim()).filter(Boolean);
    if (!members.length) continue;
    let line = '- ' + gname + ': ' + members.join(', ');
    if (g.notes) line += ' (Notiz: ' + g.notes + ')';
    groupLines.push(line);
  }

  // ---- 4. Freie Fakten (alles andere) ----
  const freeFacts = [];
  for (const [key, rawVal] of Object.entries(profile || {})) {
    if (INTERNAL_KEYS.has(key)) continue;
    if (PROFILE_LABELS[key]) continue;
    if (/^contact_.+?_(email|telegram|phone|aliases|relation|birthday|tone|notes|learned)$/.test(key)) continue;
    if (/^group_.+?_(members|notes|learned)$/.test(key)) continue;
    if (rawVal === null || rawVal === undefined) continue;
    const val = String(rawVal).trim();
    if (!val) continue;
    freeFacts.push({ key, value: val });
  }
  freeFacts.sort((a, b) => a.key.localeCompare(b.key));
  const factLines = freeFacts.map(f => '- ' + f.key + ': ' + f.value);

  // ---- Standort ----
  let locationInfo = 'Standort: ' + (profile.hometown || 'unbekannt');
  if (profile.current_city) {
    locationInfo = 'Aktueller Standort: ' + profile.current_city;
  }

  // ---- Anhänge ----
  let attachmentNote = null;
  if (attachments && attachments.length > 0) {
    const lines = attachments.map(a =>
      '  - ' + a.filename + ' (' + Math.round(a.size / 1024) + ' KB)'
    );
    attachmentNote = '📎 AKTUELLE ANHÄNGE:\n' + lines.join('\n');
  }

  // ---- Zusammenbau ----
  const sections = [
    LANGUAGE_RULE,
    '',
    ANTI_REPETITION,
    '',
    'Heute ist ' + today + ' (' + timeCtx + ').',
    'Nutzer: ' + name + '.',
    locationInfo,
    '',
    '╔═══════════════════════════════════════════╗',
    '║ 🧠 DEIN LANGZEIT-GEDÄCHTNIS ÜBER EUGEN    ║',
    '╚═══════════════════════════════════════════╝',
    '',
    '⚠️ WICHTIG: Das hier ist dein KOMPLETTES Wissen über Eugen.',
    'Wenn er dich etwas über sich, seine Familie, Kontakte oder',
    'gespeicherte Fakten fragt → antworte DIREKT aus diesem Wissen.',
    'Rufe NICHT find_contact / get_user_preferences, wenn die Antwort',
    'hier bereits steht.',
    '',
    '── NUTZER-PROFIL ──',
    profileLines.join('\n'),
    '',
    '── KONTAKTE (' + contactLines.length + ') ──',
    contactLines.length > 0 ? contactLines.join('\n') : '(noch keine)',
    '',
    '── GRUPPEN (' + groupLines.length + ') ──',
    groupLines.length > 0 ? groupLines.join('\n') : '(noch keine)',
    '',
    '── WEITERE FAKTEN (' + factLines.length + ') ──',
    factLines.length > 0 ? factLines.join('\n') : '(noch keine)',
    '',
    TONE_RULES,
    '',
    DRAFT_CONFIRMATION,
    '',
    CONTACT_RULES,
    '',
    SIGNATURE_RULE,
    '',
    ATTACHMENT_RULE,
    '',
    TELEGRAM_RULE,
    '',
    STANDORT_RULE,
  ];

  if (attachmentNote) {
    sections.push('');
    sections.push('===========================================');
    sections.push(attachmentNote);
  }

  return sections.join('\n');
}

// ==================== JONY-ROLLEN ====================

const ROLES = {
  freund: { name: 'Freund', prompt: 'Sei wie ein guter, alter Freund. 1-3 Sätze.' },
  party: { name: 'Party', prompt: 'Locker, jugendlich, mit Humor. Coole Kumpel.' },
  berater: { name: 'Berater', prompt: 'Sachlich, präzise. Bei Recht/Medizin: Hinweis auf Prüfung.' },
  kids: { name: 'Kids', prompt: 'Für Kinder (8-14). Locker wie älterer Cousin. Gaming, Fußball, coole Fakten.' },
};

const JONY_BASE = [
  'Du bist Jony, der persönliche Begleiter von Eugen (auch Jackson genannt).',
  'Ehrlich, warmherzig, direkt, humorvoll. Kein Assistent – ein Freund.',
  'Du bist hier im TEXT-CHAT (App). Antworte kurz: 1-3 Sätze.',
].join('\n');

const JONY_TOOLS_LIST = [
  'get_weather, find_restaurants, save_user_preference, get_user_preferences,',
  'find_contact, save_contact, forget_contact, list_contacts,',
  'find_group, save_group, forget_group, list_groups, resolve_recipients,',
  'save_user_profile, show_draft, send_email, send_telegram_message',
].join('\n');

// ==================== BUSINESS-WORKFLOW ====================

const BUSINESS_WORKFLOW = [
  '===========================================',
  '🏢 BUSINESS-WORKFLOW',
  '===========================================',
  '',
  'Du bist Content-Stratege für Instagram-Karussells.',
  '🚨 Du SPRICHST Skripte NIEMALS laut vor.',
  '',
  'WORKFLOW:',
  '1. Thema klären',
  '2. Sage: "Alles klar, ich erstelle das Skript."',
  '3. Rufe generate_script auf',
  '4. Nach Tool: "Skript ist da. Schau in die App."',
  '5. Bei "mach Bilder": generate_image für JEDEN Slide',
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '🚨 KARUSSELL VERSENDEN — WICHTIGSTE REGEL 🚨',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  'Wenn der Nutzer ein KARUSSELL verschicken will',
  '(egal ob "per Mail", "an mich", "an X", "auf Telegram"):',
  '',
  '⛔ NIEMALS show_draft aufrufen für ein Karussell!',
  '⛔ NIEMALS send_email aufrufen für ein Karussell!',
  '',
  '✅ STATTDESSEN:',
  '',
  'A) KARUSSELL PER E-MAIL → send_carousel_email(to)',
  '   - Hängt ALLE Karussell-Bilder automatisch an',
  '   - "an mich" → eugen.priss@yahoo.com',
  '   - Andere Adresse → direkt nutzen',
  '   - Bestätige kurz und rufe das Tool auf',
  '',
  'B) KARUSSELL PER TELEGRAM → send_carousel_telegram(chat_id)',
  '   - Schickt alle Bilder + Text an den Chat',
  '   - "an mich" → chat_id "8448058381"',
  '   - Bestätige kurz und rufe das Tool auf',
  '',
  'C) BEIDE KANÄLE → beide Tools hintereinander',
  '',
  'BEISPIEL:',
  'Nutzer: "Schick mir das per Mail"',
  'Jony: "Soll ich das Karussell an eugen.priss@yahoo.com senden?"',
  'Nutzer: "Ja"',
  'Jony: (ruft send_carousel_email auf — NICHT show_draft!)',
  '',
  'BEISPIEL "beide":',
  'Nutzer: "An beide"',
  'Jony: "Mail + Telegram an dich?"',
  'Nutzer: "Ja"',
  'Jony: (send_carousel_email UND send_carousel_telegram)',
  '',
  'STIL: Direkt, präzise, kurz.',
].join('\n');

const BUSINESS_TOOLS_LIST = [
  'generate_script, generate_image,',
  'send_carousel_email, send_carousel_telegram,',
  'plus alle Kontakt-/Gruppen-/E-Mail-Tools aus dem Fundament.',
].join('\n');

// ==================== PROMPT-BUILD ====================

function buildSystemPrompt(profile, role, mode, attachments = []) {
  const foundation = buildFoundation(profile, attachments);

  if (mode === 'business') {
    return [
      foundation,
      '',
      BUSINESS_WORKFLOW,
      '',
      '===========================================',
      'TOOLS',
      '===========================================',
      BUSINESS_TOOLS_LIST,
    ].join('\n');
  }

  const roleData = ROLES[role] || ROLES.freund;

  return [
    foundation,
    '',
    JONY_BASE,
    '',
    'ROLLE: ' + roleData.name.toUpperCase(),
    roleData.prompt,
    '',
    '===========================================',
    'TOOLS',
    '===========================================',
    JONY_TOOLS_LIST,
    '',
    'NIEMALS Wetter/Restaurants erfinden.',
  ].join('\n');
}

// ==================== TOOLS ====================

const JONY_TOOLS = [
  {
    name: 'get_weather',
    description: 'Wetter und Vorhersage für einen Ort.',
    parameters: {
      type: 'OBJECT',
      properties: {
        location: { type: 'STRING' },
        timeframe: { type: 'STRING' },
      },
      required: ['location'],
    },
  },
  {
    name: 'find_restaurants',
    description: 'Restaurants in der Nähe finden.',
    parameters: {
      type: 'OBJECT',
      properties: {
        location: { type: 'STRING' },
        cuisine: { type: 'STRING' },
      },
      required: ['location'],
    },
  },
  {
    name: 'save_user_preference',
    description: 'Speichert persönliche Info über den Nutzer.',
    parameters: {
      type: 'OBJECT',
      properties: {
        key: { type: 'STRING' },
        value: { type: 'STRING' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'get_user_preferences',
    description: 'Lädt ALLE gespeicherten Infos über den Nutzer.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'find_contact',
    description: 'Sucht einen Kontakt.',
    parameters: {
      type: 'OBJECT',
      properties: { name: { type: 'STRING' } },
      required: ['name'],
    },
  },
  {
    name: 'save_contact',
    description: 'Speichert/aktualisiert einen Kontakt.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        email: { type: 'STRING' },
        telegram: { type: 'STRING' },
        phone: { type: 'STRING' },
        aliases: { type: 'STRING' },
        relation: { type: 'STRING' },
        birthday: { type: 'STRING' },
        tone: { type: 'STRING' },
        notes: { type: 'STRING' },
      },
      required: ['name'],
    },
  },
  {
    name: 'forget_contact',
    description: 'Löscht einen Kontakt.',
    parameters: {
      type: 'OBJECT',
      properties: { name: { type: 'STRING' } },
      required: ['name'],
    },
  },
  {
    name: 'list_contacts',
    description: 'Listet alle Kontakte auf.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'find_group',
    description: 'Sucht eine Gruppe.',
    parameters: {
      type: 'OBJECT',
      properties: { name: { type: 'STRING' } },
      required: ['name'],
    },
  },
  {
    name: 'save_group',
    description: 'Speichert eine Gruppe.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        members: { type: 'ARRAY', items: { type: 'STRING' } },
        notes: { type: 'STRING' },
      },
      required: ['name', 'members'],
    },
  },
  {
    name: 'forget_group',
    description: 'Löscht eine Gruppe.',
    parameters: {
      type: 'OBJECT',
      properties: { name: { type: 'STRING' } },
      required: ['name'],
    },
  },
  {
    name: 'list_groups',
    description: 'Listet alle Gruppen auf.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'resolve_recipients',
    description: 'Löst mehrere Namen zu Empfängern auf.',
    parameters: {
      type: 'OBJECT',
      properties: {
        names: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['names'],
    },
  },
  {
    name: 'save_user_profile',
    description: 'Speichert Nutzer-Profil.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        address: { type: 'STRING' },
        birthdate: { type: 'STRING' },
        phone: { type: 'STRING' },
        default_email: { type: 'STRING' },
        default_tone: { type: 'STRING' },
      },
    },
  },
  {
    name: 'show_draft',
    description: 'Zeigt E-Mail-Entwurf als Karte (NUR für normale E-Mails, NICHT für Karussells).',
    parameters: {
      type: 'OBJECT',
      properties: {
        to: { type: 'STRING' },
        subject: { type: 'STRING' },
        body: { type: 'STRING' },
        tone: { type: 'STRING' },
      },
      required: ['to', 'subject', 'body', 'tone'],
    },
  },
  {
    name: 'send_email',
    description: 'Sendet die E-Mail nach Bestätigung (NUR für normale E-Mails).',
    parameters: {
      type: 'OBJECT',
      properties: {
        to: { type: 'STRING' },
        subject: { type: 'STRING' },
        body: { type: 'STRING' },
        tone: { type: 'STRING' },
      },
      required: ['to', 'subject', 'body', 'tone'],
    },
  },
  {
    name: 'send_telegram_message',
    description: 'Sendet eine Telegram-Nachricht. Frage IMMER zuerst nach Bestätigung.',
    parameters: {
      type: 'OBJECT',
      properties: {
        chat_id: { type: 'STRING' },
        text: { type: 'STRING' },
      },
      required: ['chat_id', 'text'],
    },
  },
];

const BUSINESS_TOOLS = [
  ...JONY_TOOLS,
  {
    name: 'generate_script',
    description: 'Erstellt das Instagram-Karussell-Skript.',
    parameters: {
      type: 'OBJECT',
      properties: {
        topic: { type: 'STRING' },
        audience: { type: 'STRING' },
        focus: { type: 'STRING' },
        slide_count: { type: 'INTEGER' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'generate_image',
    description: 'Generiert ein Bild für einen Karussell-Slide.',
    parameters: {
      type: 'OBJECT',
      properties: {
        prompt: { type: 'STRING' },
        slide_number: { type: 'INTEGER' },
      },
      required: ['prompt', 'slide_number'],
    },
  },
  {
    name: 'send_carousel_email',
    description: 'Sendet das Karussell MIT ALLEN BILDERN als E-Mail-Anhang. ' +
                 'Nutze das IMMER wenn der Nutzer ein Karussell per Mail will.',
    parameters: {
      type: 'OBJECT',
      properties: { to: { type: 'STRING' } },
      required: ['to'],
    },
  },
  {
    name: 'send_carousel_telegram',
    description: 'Sendet das Karussell MIT ALLEN BILDERN an Telegram. ' +
                 'Nutze das IMMER wenn der Nutzer ein Karussell auf Telegram will.',
    parameters: {
      type: 'OBJECT',
      properties: { chat_id: { type: 'STRING' } },
      required: ['chat_id'],
    },
  },
];

// ==================== HILFSFUNKTIONEN ====================

function isHereKeyword(loc) {
  if (!loc || typeof loc !== 'string') return false;
  const t = loc.toLowerCase().trim();
  return /^(hier|hier\s+bei\s+mir|bei\s+mir|mein\s+standort|meine\s+position|aktueller\s+standort|vor\s+ort|hier\s+vor\s+ort|здесь|тут|у\s+меня|моё\s+местоположение)$/.test(t);
}

// ==================== TOOL IMPLEMENTATIONS ====================

async function fetchWeather(location, timeframe = 'aktuell') {
  const url = SELF_URL + '/api/get-weather?location=' + encodeURIComponent(location);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeframe }),
  });
  if (!res.ok) throw new Error('Wetter-Fehler: ' + res.status);
  const data = await res.json();
  return {
    location: data.location,
    current_temp: data.current?.temp,
    current_desc: data.current?.description,
    today_min: data.today?.min,
    today_max: data.today?.max,
    tomorrow_desc: data.tomorrow?.description,
    rain_chance: data.today?.rain_chance,
  };
}

async function fetchRestaurants(location, cuisine = 'Restaurant') {
  const url = SELF_URL + '/api/search-restaurant?location=' + encodeURIComponent(location);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cuisine }),
  });
  if (!res.ok) throw new Error('Restaurant-Fehler: ' + res.status);
  const data = await res.json();
  return {
    count: data.count,
    restaurants: (data.restaurants || []).map(r => ({
      name: r.name, rating: r.rating, address: r.address, phone: r.phone,
    })),
  };
}

async function savePref(userId, key, value) {
  if (!userId) return { error: 'no user_id' };
  const valueStr = String(value || '').trim();
  if (!valueStr || valueStr === 'User Name' || valueStr === 'undefined') {
    return { success: false, message: 'Invalid value' };
  }
  const res = await fetch(SELF_URL + '/api/save-preference', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, key, value: valueStr }),
  });
  return { success: res.ok };
}

async function getPrefs(userId) {
  if (!userId) return { error: 'no user_id' };
  const res = await fetch(SELF_URL + '/api/profile/' + userId);
  if (!res.ok) throw new Error('Lade-Fehler: ' + res.status);
  const data = await res.json();
  return { preferences: data.data || {} };
}

async function findContact(userId, name) {
  const res = await fetch(SELF_URL + '/api/contacts/find', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, name }),
  });
  if (!res.ok) throw new Error('Kontakt-Suche fehlgeschlagen');
  return await res.json();
}

async function saveContact(userId, fields) {
  const res = await fetch(SELF_URL + '/api/contacts/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, ...fields }),
  });
  if (!res.ok) throw new Error('Kontakt-Speichern fehlgeschlagen');
  return await res.json();
}

async function forgetContact(userId, name) {
  const res = await fetch(SELF_URL + '/api/contacts/forget', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, name }),
  });
  if (!res.ok) throw new Error('Kontakt-Löschen fehlgeschlagen');
  return await res.json();
}

async function listContacts(userId) {
  const res = await fetch(SELF_URL + '/api/contacts/list/' + userId);
  if (!res.ok) throw new Error('Kontakt-Liste fehlgeschlagen');
  return await res.json();
}

async function findGroup(userId, name) {
  const res = await fetch(SELF_URL + '/api/groups/find', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, name }),
  });
  if (!res.ok) throw new Error('Gruppen-Suche fehlgeschlagen');
  return await res.json();
}

async function saveGroup(userId, name, members, notes) {
  const res = await fetch(SELF_URL + '/api/groups/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, name, members, notes }),
  });
  if (!res.ok) throw new Error('Gruppen-Speichern fehlgeschlagen');
  return await res.json();
}

async function forgetGroup(userId, name) {
  const res = await fetch(SELF_URL + '/api/groups/forget', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, name }),
  });
  if (!res.ok) throw new Error('Gruppen-Löschen fehlgeschlagen');
  return await res.json();
}

async function listGroups(userId) {
  const res = await fetch(SELF_URL + '/api/groups/list/' + userId);
  if (!res.ok) throw new Error('Gruppen-Liste fehlgeschlagen');
  return await res.json();
}

async function resolveRecipients(userId, names) {
  const res = await fetch(SELF_URL + '/api/contacts/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, names }),
  });
  if (!res.ok) throw new Error('Auflösen fehlgeschlagen');
  return await res.json();
}

async function saveUserProfile(userId, fields) {
  const res = await fetch(SELF_URL + '/api/user-profile/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, ...fields }),
  });
  if (!res.ok) throw new Error('Profil-Speichern fehlgeschlagen');
  return await res.json();
}

async function showDraft(userId, to, subject, body, tone, attachments = []) {
  if (!to || !subject || !body) {
    return { error: 'to, subject, body required' };
  }

  const draft = setDraft(userId, { to, subject, body, tone: tone || 'persönlich' });

  broadcastToClients({
    type: 'draft_shown',
    draft: {
      id: draft.id,
      to: draft.to,
      subject: draft.subject,
      body: draft.body,
      tone: draft.tone,
      attachments: (attachments || []).map(a => ({
        id: a.id,
        filename: a.filename,
        size: a.size,
      })),
    },
  });

  console.log(`📝 Draft angezeigt: an ${to} (${tone})`);

  return {
    success: true,
    draft_id: draft.id,
    message: 'Entwurf wird in der App angezeigt. Warte auf Reaktion des Nutzers.',
  };
}

async function sendFreeEmail(to, subject, body, profile = {}, tone = 'persönlich') {
  console.log(`📧 Freie E-Mail an ${to}: "${subject}" (Ton: ${tone})`);
  const res = await fetch(SELF_URL + '/api/send-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, subject, body, profile, tone }),
  });
  if (!res.ok) {
    return { error: `E-Mail-Versand fehlgeschlagen: ${res.status}` };
  }
  const data = await res.json();
  const attachInfo = data.attachmentCount > 0 ? ` (mit ${data.attachmentCount} Anhängen)` : '';

  if (profile?.user_id) {
    clearDraft(profile.user_id);
  }

  return { success: true, to, subject, message: `E-Mail an ${to} gesendet${attachInfo}.` };
}

async function sendTelegram(chatId, text) {
  console.log(`📨 Sende Telegram an ${chatId}`);
  const res = await fetch(SELF_URL + '/api/telegram/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const errText = await res.text();
    return { error: `Telegram-Versand fehlgeschlagen: ${res.status} ${errText.substring(0, 100)}` };
  }
  return { success: true, to: chatId, message: 'Telegram-Nachricht gesendet.' };
}

async function sendCarouselEmail(userId, to, profile = {}) {
  console.log(`📧 Sende Karussell per Mail an ${to}`);
  const carousel = getCarousel(userId);
  if (!carousel) {
    return { error: 'Kein Karussell im Speicher. Erst eins erstellen.' };
  }

  try {
    const res = await sendCarouselByEmail(to, carousel, profile);
    return {
      success: true,
      to,
      topic: res.topic,
      imageCount: res.imageCount,
      message: `Karussell "${res.topic}" mit ${res.imageCount} Bildern an ${to} gesendet.`,
    };
  } catch (e) {
    return { error: 'E-Mail-Versand fehlgeschlagen: ' + e.message };
  }
}

async function sendCarouselTelegram(userId, chatId) {
  console.log(`📨 Sende Karussell per Telegram an ${chatId}`);
  const carousel = getCarousel(userId);
  if (!carousel) {
    return { error: 'Kein Karussell im Speicher. Erst eins erstellen.' };
  }

  try {
    const res = await fetch(SELF_URL + '/api/telegram/send-carousel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        topic: carousel.topic,
        slides: carousel.slides,
        images: carousel.images,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { error: `Telegram-Karussell-Versand fehlgeschlagen: ${res.status}` };
    }

    const data = await res.json();
    return {
      success: true,
      to: chatId,
      topic: carousel.topic,
      imageCount: data.imagesSent || carousel.images.length,
      message: `Karussell "${carousel.topic}" mit ${data.imagesSent || carousel.images.length} Bildern auf Telegram gesendet.`,
    };
  } catch (e) {
    return { error: 'Telegram-Versand fehlgeschlagen: ' + e.message };
  }
}

// ==================== SCRIPT + IMAGE ====================

async function generateScriptAndBroadcast(topic, audience, focus, slideCount, userId) {
  console.log(`📝 Chat-Skript: "${topic}"`);
  if (!process.env.GROQ_API_KEY) return { error: 'GROQ_API_KEY fehlt.' };

  const count = slideCount && slideCount >= 1 && slideCount <= 10 ? slideCount : 8;

  const prompt = [
    'Erstelle ein Instagram-Karussell-Skript als JSON.',
    '',
    'Thema: ' + topic,
    'Zielgruppe: ' + (audience || 'Allgemein'),
    'Fokus: ' + (focus || 'Tipps, Fakten und Mehrwert'),
    'Anzahl Slides: ' + count,
    '',
    'Antworte NUR mit einem JSON-Objekt:',
    '{',
    '  "slides": [',
    '    {"slide": 1, "title": "Kurzer Hook", "body": "Text max 20 Wörter", "image_prompt": "DETAILED ENGLISH IMAGE PROMPT 35-50 Wörter"}',
    '  ]',
    '}',
    '',
    'NUR das JSON.',
  ].join('\n');

  let lastError = null;
  for (const modelName of GROQ_FALLBACKS) {
    try {
      const completion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: 'Antworte AUSSCHLIESSLICH mit gültigem JSON.' },
          { role: 'user', content: prompt },
        ],
        model: modelName,
        temperature: 0.7,
        response_format: { type: 'json_object' },
      });

      const text = completion.choices[0]?.message?.content || '';
      let slides = null;
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) slides = parsed;
        else if (parsed.slides && Array.isArray(parsed.slides)) slides = parsed.slides;
      } catch (e) {
        return { error: 'JSON-Parse-Fehler: ' + e.message };
      }

      if (!slides || slides.length === 0) return { error: 'Skript ist leer' };

      if (userId) setScript(userId, topic, slides);
      broadcastToClients({ type: 'script', topic, slides });

      return {
        success: true,
        slide_count: slides.length,
        message: `Skript mit ${slides.length} Slides in App angezeigt.`,
      };
    } catch (e) {
      lastError = e;
      const errMsg = e.message || String(e);
      if (errMsg.includes('404') || errMsg.includes('does not exist')) continue;
      console.error(`   ❌ ${modelName}:`, errMsg);
    }
  }

  return { error: 'Skript-Generierung fehlgeschlagen: ' + (lastError?.message || '?') };
}

async function translateToEnglishImagePrompt(germanPrompt) {
  try {
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'Du bist ein Prompt-Engineer für FLUX.1. Output 40-60 Wörter englisch. NUR der Prompt.',
        },
        { role: 'user', content: germanPrompt },
      ],
      model: 'openai/gpt-oss-20b',
      temperature: 0.4,
    });
    return completion.choices[0]?.message?.content?.trim().replace(/^["']|["']$/g, '') || germanPrompt;
  } catch (e) {
    return germanPrompt;
  }
}

async function generateImageWithCloudflare(englishPrompt) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new Error('CLOUDFLARE credentials fehlen.');

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt: englishPrompt, steps: 8 }),
  });

  if (!response.ok) throw new Error(`Cloudflare HTTP ${response.status}`);
  const data = await response.json();
  if (!data.success || !data.result?.image) throw new Error('Cloudflare lieferte kein Bild');
  return { imageBase64: data.result.image, mimeType: 'image/jpeg' };
}

async function generateImageAndBroadcast(prompt, slideNumber, userId) {
  console.log(`🎨 Chat-Bild Slide ${slideNumber}`);
  try {
    const englishPrompt = await translateToEnglishImagePrompt(prompt);
    const result = await generateImageWithCloudflare(englishPrompt);

    if (userId) addImage(userId, slideNumber, result.imageBase64, result.mimeType);

    broadcastToClients({
      type: 'image',
      slide: slideNumber,
      mimeType: result.mimeType,
      data: result.imageBase64,
    });

    return { success: true, slide: slideNumber };
  } catch (e) {
    return { error: e.message, slide: slideNumber };
  }
}

// ==================== TOOL DISPATCH ====================

async function executeChatTool(name, args, userId, profile, currentLocation = null, attachments = []) {
  if (name === 'get_weather') {
    let loc = args.location;
    if (isHereKeyword(loc) && currentLocation?.city) loc = currentLocation.city;
    return await fetchWeather(loc, args.timeframe);
  }
  if (name === 'find_restaurants') {
    let loc = args.location;
    if (isHereKeyword(loc) && currentLocation?.city) loc = currentLocation.city;
    return await fetchRestaurants(loc, args.cuisine);
  }
  if (name === 'save_user_preference') return await savePref(userId, args.key, args.value);
  if (name === 'get_user_preferences') return await getPrefs(userId);
  if (name === 'find_contact') return await findContact(userId, args.name);
  if (name === 'save_contact') {
    const { name: cname, ...fields } = args;
    return await saveContact(userId, { name: cname, ...fields });
  }
  if (name === 'forget_contact') return await forgetContact(userId, args.name);
  if (name === 'list_contacts') return await listContacts(userId);
  if (name === 'find_group') return await findGroup(userId, args.name);
  if (name === 'save_group') return await saveGroup(userId, args.name, args.members, args.notes);
  if (name === 'forget_group') return await forgetGroup(userId, args.name);
  if (name === 'list_groups') return await listGroups(userId);
  if (name === 'resolve_recipients') return await resolveRecipients(userId, args.names);
  if (name === 'save_user_profile') return await saveUserProfile(userId, args);
  if (name === 'show_draft') {
    return await showDraft(userId, args.to, args.subject, args.body, args.tone, attachments);
  }
  if (name === 'send_email') {
    const profileWithId = { ...profile, user_id: userId };
    return await sendFreeEmail(args.to, args.subject, args.body, profileWithId, args.tone || 'persönlich');
  }
  if (name === 'send_telegram_message') {
    return await sendTelegram(args.chat_id, args.text);
  }
  if (name === 'generate_script') {
    return await generateScriptAndBroadcast(args.topic, args.audience, args.focus, args.slide_count, userId);
  }
  if (name === 'generate_image') {
    return await generateImageAndBroadcast(args.prompt, args.slide_number, userId);
  }
  if (name === 'send_carousel_email') {
    return await sendCarouselEmail(userId, args.to, profile);
  }
  if (name === 'send_carousel_telegram') {
    return await sendCarouselTelegram(userId, args.chat_id);
  }
  return { error: 'Unbekanntes Tool: ' + name };
}

// ==================== HISTORIE mit 8-Std-Reset ====================

async function loadChatHistory(userId, limit = 10) {
  try {
    const result = await pool.query(`
      SELECT role, content, created_at FROM chat_history
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [userId]);

    if (result.rows.length === 0) return [];

    const newest = result.rows[0];
    const newestTime = new Date(newest.created_at).getTime();
    const now = Date.now();
    const ageMs = now - newestTime;

    if (ageMs > CHAT_SESSION_RESET_MS) {
      console.log(`📭 Chat-Session-Reset: Letzte Nachricht ${Math.round(ageMs/60000)} Min alt`);
      return [];
    }

    const sessionMessages = [];
    let prevTime = newestTime;

    for (const row of result.rows) {
      const rowTime = new Date(row.created_at).getTime();
      const gapMs = prevTime - rowTime;

      if (gapMs > CHAT_SESSION_RESET_MS) break;
      sessionMessages.push(row);
      prevTime = rowTime;
    }

    sessionMessages.reverse();
    return sessionMessages.slice(-limit);
  } catch (e) {
    console.error('⚠️ History-Load-Fehler:', e.message);
    return [];
  }
}

async function saveChatMessage(userId, role, content) {
  try {
    await pool.query(`
      INSERT INTO chat_history (user_id, role, content)
      VALUES ($1, $2, $3)
    `, [userId, role, content]);
  } catch (e) {
    console.error('⚠️ Chat-History-Fehler:', e.message);
  }
}

export async function getChatHistory(userId, limit = 50) {
  try {
    const result = await pool.query(`
      SELECT role, content, created_at FROM chat_history
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [userId]);

    if (result.rows.length === 0) return [];

    const newest = result.rows[0];
    const newestTime = new Date(newest.created_at).getTime();

    const sessionMessages = [];
    let prevTime = newestTime;

    for (const row of result.rows) {
      const rowTime = new Date(row.created_at).getTime();
      const gapMs = prevTime - rowTime;
      if (gapMs > CHAT_SESSION_RESET_MS) break;
      sessionMessages.push(row);
      prevTime = rowTime;
    }

    sessionMessages.reverse();
    return sessionMessages.slice(-limit);
  } catch (e) {
    return [];
  }
}

export async function initChatTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_history (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_history_user_time
      ON chat_history (user_id, created_at DESC)
    `);
    console.log('✅ chat_history-Tabelle bereit');
  } catch (e) {
    console.error('❌ Chat-Tabellen-Fehler:', e.message);
  }
}

async function loadUserProfile(userId) {
  try {
    const res = await fetch(SELF_URL + '/api/profile/' + userId);
    if (!res.ok) return {};
    const data = await res.json();
    return data.data || {};
  } catch (e) {
    return {};
  }
}

function detectChatMode(message, currentMode = 'jony') {
  const t = message.toLowerCase();

  if (/business.?modus|business\s+mode|бизнес.?мод|бизнес/.test(t)) {
    return { mode: 'business', role: null };
  }
  if (/zur[üu]ck.*freund|freund.?modus|normal.?modus|zur[üu]ck\s+zum|business\s+aus|business\s+beenden/.test(t)) {
    return { mode: 'jony', role: 'freund' };
  }

  if (currentMode === 'jony') {
    if (/party.?modus|jony.*party|partymodus|вечеринк|пати/.test(t)) {
      return { mode: 'jony', role: 'party' };
    }
    if (/berater|sachlich|intellektuell|советник/.test(t)) {
      return { mode: 'jony', role: 'berater' };
    }
    if (/kids|kinder|niklas|детск/.test(t)) {
      return { mode: 'jony', role: 'kids' };
    }
    if (/freund|normal|zur[üu]ck/.test(t)) {
      return { mode: 'jony', role: 'freund' };
    }
  }

  return null;
}

// ==================== HAUPTFUNKTION ====================

export async function handleChatMessage(
  userId,
  userMessage,
  currentRole = 'freund',
  currentMode = 'jony',
  currentLocation = null,
  attachments = []
) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  console.log(`💬 Chat (${currentMode}/${currentRole}): "${userMessage.substring(0, 60)}"`);

  let activeMode = currentMode;
  let activeRole = currentRole;
  const switchResult = detectChatMode(userMessage, currentMode);
  if (switchResult) {
    activeMode = switchResult.mode;
    if (switchResult.role) activeRole = switchResult.role;
    console.log(`🎭 Chat-Wechsel: → ${activeMode}/${activeRole}`);
  }

  const profile = await loadUserProfile(userId);
  const history = await loadChatHistory(userId, 8);

  const enrichedProfile = {
    ...profile,
    current_lat: currentLocation?.lat,
    current_lon: currentLocation?.lon,
    current_city: currentLocation?.city || profile.hometown,
    user_id: userId,
  };

  const systemInstruction = buildSystemPrompt(enrichedProfile, activeRole, activeMode, attachments);
  const tools = activeMode === 'business' ? BUSINESS_TOOLS : JONY_TOOLS;

  const contents = [
    ...history.map(h => ({
      role: h.role === 'user' ? 'user' : 'model',
      parts: [{ text: h.content }],
    })),
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  let finalText = null;
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;

    let response = null;

    for (const modelName of CHAT_MODELS) {
      try {
        response = await ai.models.generateContent({
          model: modelName,
          contents,
          config: {
            systemInstruction: { parts: [{ text: systemInstruction }] },
            tools: [{ functionDeclarations: tools }],
            temperature: 0.8,
            maxOutputTokens: 500,
            thinkingConfig: { thinkingLevel: 'low' },
          },
        });
        console.log(`   ✅ Chat-Modell: ${modelName}`);
        break;
      } catch (e) {
        const errMsg = e.message || String(e);
        if (errMsg.includes('404') || errMsg.includes('NOT_FOUND')) {
          continue;
        }
        if (errMsg.includes('thinking') || errMsg.includes('Thinking')) {
          try {
            response = await ai.models.generateContent({
              model: modelName,
              contents,
              config: {
                systemInstruction: { parts: [{ text: systemInstruction }] },
                tools: [{ functionDeclarations: tools }],
                temperature: 0.8,
                maxOutputTokens: 500,
              },
            });
            break;
          } catch (e2) {
            continue;
          }
        }
        continue;
      }
    }

    if (!response) {
      console.error('❌ Kein Chat-Modell verfügbar');
      break;
    }

    const candidate = response.candidates?.[0];
    if (!candidate) break;

    const parts = candidate.content?.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);

    if (functionCalls.length > 0) {
      contents.push({ role: 'model', parts });

      for (const part of functionCalls) {
        const fc = part.functionCall;
        console.log(`   🔧 Chat-Tool: ${fc.name}`);

        let toolResult;
        try {
          toolResult = await executeChatTool(fc.name, fc.args || {}, userId, enrichedProfile, currentLocation, attachments);
        } catch (e) {
          toolResult = { error: e.message };
        }

        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: fc.name,
              response: toolResult,
            },
          }],
        });
      }
      continue;
    }

    finalText = parts.filter(p => p.text).map(p => p.text).join('').trim();
    break;
  }

  if (!finalText) {
    finalText = 'Hmm, ich hab grad nichts zu sagen. Frag nochmal.';
  }

  console.log(`✅ Chat-Antwort (${finalText.length} Zeichen)`);

  await saveChatMessage(userId, 'user', userMessage);
  await saveChatMessage(userId, 'assistant', finalText);

  return {
    reply: finalText,
    mode: activeMode,
    role: activeRole,
  };
}
