// server/chat.js

import { GoogleGenAI } from '@google/genai';
import pg from 'pg';
import OpenAI from 'openai';
import { broadcastToClients } from './gemini_live.js';
import { sendCarouselByEmail } from './email.js';
import { setScript, addImage, getCarousel } from './carousel_store.js';
import { setRestaurants, getRestaurants, clearRestaurants } from './restaurant_store.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:' + (process.env.PORT || 8080);

// Aktuelle Modelle
const CHAT_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-pro-preview',
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

// ==================== TOKEN-LOGGING ====================

async function logTokenUsage(userId, source, model, inputTokens, outputTokens, toolCalls = 0) {
  try {
    const total = (inputTokens || 0) + (outputTokens || 0);
    if (total === 0) return;
    await pool.query(`
      INSERT INTO token_usage (user_id, source, model, input_tokens, output_tokens, total_tokens, tool_calls)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [userId, source, model, inputTokens || 0, outputTokens || 0, total, toolCalls]);
  } catch (e) {
    console.error('⚠️ Token-Log-Fehler:', e.message);
  }
}

// ==================== KONFIG ====================

const CHAT_SESSION_RESET_MS = 8 * 60 * 60 * 1000;

// ==================== DRAFT-SPEICHER ====================

const draftStore = new Map();
const DRAFT_TTL_MS = 10 * 60 * 1000;

function cleanOldDrafts() {
  const now = Date.now();
  for (const [userId, draft] of draftStore.entries()) {
    if ((now - draft.createdAt) > DRAFT_TTL_MS) draftStore.delete(userId);
  }
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
  console.log(`📝 Draft: ${userId.substring(0,8)}... an ${draft.to}`);
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
  if (had) console.log(`🧹 Draft gelöscht: ${userId.substring(0,8)}...`);
  return had;
}

// ==================== ZEIT ====================

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

// ==================== FUNDAMENT ====================

function buildFoundation(userData, currentLocation, attachments) {
  const today = new Date().toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const timeCtx = getTimeContext();

  const profile = [];
  const facts = [];
  const contacts = [];
  const groups = [];

  const contactNames = new Set();
  const groupNames = new Set();
  for (const key of Object.keys(userData || {})) {
    const cm = key.match(/^contact_(.+?)_(email|telegram|phone|aliases|relation|birthday|tone|notes|learned)$/);
    if (cm) contactNames.add(cm[1]);
    const gm = key.match(/^group_(.+?)_members$/);
    if (gm) groupNames.add(gm[1]);
  }

  for (const [key, val] of Object.entries(userData || {})) {
    if (!val) continue;
    const s = String(val).trim();
    if (!s) continue;
    if (key.startsWith('contact_') || key.startsWith('group_')) continue;

    if (key === 'name') profile.push('Name: ' + s);
    else if (key === 'nickname') profile.push('Spitzname: ' + s);
    else if (key === 'hometown') profile.push('Heimatort: ' + s);
    else if (key.startsWith('user_')) profile.push(key + ': ' + s);
    else facts.push(key + ': ' + s);
  }

  for (const cn of contactNames) {
    const p = 'contact_' + cn + '_';
    const parts = [];
    if (userData[p + 'email']) parts.push('Mail: ' + userData[p + 'email']);
    if (userData[p + 'telegram']) parts.push('TG: ' + userData[p + 'telegram']);
    if (userData[p + 'phone']) parts.push('Tel: ' + userData[p + 'phone']);
    if (userData[p + 'relation']) parts.push('(' + userData[p + 'relation'] + ')');
    if (userData[p + 'aliases']) parts.push('Alias: ' + userData[p + 'aliases']);
    if (userData[p + 'tone']) parts.push('Ton: ' + userData[p + 'tone']);
    if (userData[p + 'birthday']) parts.push('🎂 ' + userData[p + 'birthday']);
    if (userData[p + 'notes']) parts.push('📝 ' + userData[p + 'notes']);
    if (parts.length > 0) contacts.push('- ' + cn + ': ' + parts.join(' | '));
  }

  for (const gn of groupNames) {
    const m = userData['group_' + gn + '_members'];
    if (m) groups.push('- ' + gn + ': ' + m);
  }

  let locationLine = 'Standort: ' + (userData.hometown || 'unbekannt');
  if (currentLocation?.city) locationLine = 'Standort: ' + currentLocation.city;

  const parts = [
    'HEUTE: ' + today + ' (' + timeCtx + ')',
    locationLine,
  ];

  if (profile.length > 0) { parts.push(''); parts.push('PROFIL:'); parts.push(...profile); }
  if (contacts.length > 0) { parts.push(''); parts.push('KONTAKTE:'); parts.push(...contacts); }
  if (groups.length > 0) { parts.push(''); parts.push('GRUPPEN:'); parts.push(...groups); }
  if (facts.length > 0) { parts.push(''); parts.push('FAKTEN:'); parts.push(...facts); }
  if (attachments && attachments.length > 0) {
    parts.push('');
    parts.push('ANHÄNGE BEREIT: ' + attachments.map(a => a.filename).join(', '));
  }

  return parts.join('\n');
}

// ==================== REGELN ====================

const CORE_RULES = [
  'SPRACHE: Deutsch oder Russisch. Bei anderen Sprachen auf Deutsch weitermachen.',
  '',
  'TON: formell (Behörden/Firmen) | persönlich (bekannte Erwachsene) | locker (enge Freunde, Familie)',
  'Behörden automatisch formell. Bei neuem Kontakt fragen.',
  '',
  'KONTAKT-ABLAUF bei "Schreib an X":',
  '1. find_contact(X) + find_group(X)',
  '2. Gefunden → Adresse + Ton nutzen',
  '3. Nicht gefunden → Adresse + Ton fragen',
  '4. show_draft(to, subject, body, tone) — Karte erscheint in der App',
  '5. Warten auf Bestätigung (siehe unten)',
  '6. send_email(to, subject, body, tone)',
  '',
  'JA (senden): ja, ok, senden, schick, weg, raus, los, passt, ab damit, klar',
  'NEIN (verwerfen): nein, abbrechen, löschen, vergessen, ändern, verwerfen',
  'Bei unklar: "Senden oder verwerfen?"',
  '',
  'SIGNATUR: Du schreibst NIEMALS selbst eine Signatur. Server hängt sie an.',
  'ANHÄNGE: Werden automatisch mitgeschickt. Nicht im Body erwähnen.',
  'DRAFT: Niemals als Text wiederholen. Nur "Entwurf ist da. Prüf ihn."',
  '',
  'TELEGRAM: send_telegram_message(chat_id, text). Eugen: 8448058381.',
  '',
  '🌐 AKTUELLES WISSEN: Du hast Zugriff auf die Google-Suche. Bei Fragen zu aktuellen Ereignissen (Bundesliga-Tabelle, Spielstände, Nachrichten, aktuelle Termine, Preise, Wetter-Vorhersagen) → nutze die Google-Suche automatisch. ERFINDE NICHTS. Wenn du etwas nicht weißt → sag es.',
  '',
  '🍽️ RESTAURANTS: Wenn der Nutzer nach Restaurants fragt → rufe find_restaurants auf. Du siehst die Ergebnisse NICHT selbst — sie werden als Karten in der App angezeigt. Sage kurz: "Ich hab 3 gefunden — schau auf den Bildschirm." Lies die Namen NICHT vor.',
].join('\n');

const BUSINESS_RULES = [
  'BUSINESS-MODUS — Karussells.',
  '',
  'WORKFLOW:',
  '1. "Karussell über X" → generate_script(topic, ..., slide_count)',
  '2. "Bilder" → generate_image für JEDEN Slide einzeln',
  '3. "Karussell per Mail an Y" → send_carousel_email(to) — NICHT show_draft!',
  '4. "Karussell auf Telegram" → send_carousel_telegram(chat_id)',
  '5. "Normale Mail an Y" → show_draft + send_email',
  '6. Skript NIEMALS vorlesen. Skript erscheint in der App als Karte.',
  '',
  'STANDARD-EMP: "an mich" → eugen.priss@yahoo.com',
  '',
  'Bei "beide" (Mail + Telegram): beide Tools hintereinander aufrufen.',
].join('\n');

const ROLES = {
  freund: 'FREUND-MODUS: Wie ein guter alter Freund. Warm, direkt, 1-3 Sätze. Variiere.',
  party: 'PARTY-MODUS: Locker, jugendlich, Humor, Slang. Coole Kumpel.',
  berater: 'BERATER-MODUS: Sachlich, präzise. Bei Recht/Medizin/Finanzen: Hinweis auf Prüfung. 2-4 Sätze.',
  kids: 'KIDS-MODUS (8-14 Jahre): Wie ein älterer Cousin. Gaming, Fußball, coole Fakten, Tiere. NIE herablassend.',
};

const JONY_BASE = 'Du bist Jony, persönlicher Begleiter von Eugen (auch Jackson). Ehrlich, warmherzig, humorvoll. Kein Assistent – ein Freund. Text-Chat: kurz, 1-3 Sätze.';

const JONY_TOOLS_LIST = 'TOOLS: get_weather, find_restaurants, save_user_preference, get_user_preferences, find_contact, save_contact, forget_contact, list_contacts, find_group, save_group, forget_group, list_groups, resolve_recipients, save_user_profile, show_draft, send_email, send_telegram_message';

const BUSINESS_TOOLS_LIST = 'TOOLS: generate_script, generate_image, send_carousel_email, send_carousel_telegram + alle Kontakt-/Gruppen-/E-Mail-Tools';

// ==================== PROMPT ====================

function buildSystemPrompt(userData, role, mode, currentLocation, attachments) {
  const foundation = buildFoundation(userData, currentLocation, attachments);

  if (mode === 'business') {
    return [
      foundation,
      '',
      CORE_RULES,
      '',
      BUSINESS_RULES,
      '',
      BUSINESS_TOOLS_LIST,
    ].join('\n');
  }

  const rolePrompt = ROLES[role] || ROLES.freund;

  return [
    foundation,
    '',
    CORE_RULES,
    '',
    JONY_BASE,
    '',
    rolePrompt,
    '',
    JONY_TOOLS_LIST,
    '',
    'NIEMALS Wetter/Restaurants erfinden.',
  ].join('\n');
}

// ==================== TOOLS-DEFINITIONEN ====================

const JONY_TOOLS = [
  { name: 'get_weather', description: 'Wetter für einen Ort.', parameters: { type: 'OBJECT', properties: { location: { type: 'STRING' }, timeframe: { type: 'STRING' } }, required: ['location'] } },
  { name: 'find_restaurants', description: 'Findet Restaurants in der Nähe. Die Ergebnisse werden als Karten in der App angezeigt — lies sie NICHT vor.', parameters: { type: 'OBJECT', properties: { location: { type: 'STRING' }, cuisine: { type: 'STRING' } }, required: ['location'] } },
  { name: 'save_user_preference', description: 'Speichert Nutzer-Info.', parameters: { type: 'OBJECT', properties: { key: { type: 'STRING' }, value: { type: 'STRING' } }, required: ['key', 'value'] } },
  { name: 'get_user_preferences', description: 'Lädt alle Nutzer-Infos.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'find_contact', description: 'Sucht einen Kontakt.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
  { name: 'save_contact', description: 'Speichert Kontakt.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' }, email: { type: 'STRING' }, telegram: { type: 'STRING' }, phone: { type: 'STRING' }, aliases: { type: 'STRING' }, relation: { type: 'STRING' }, birthday: { type: 'STRING' }, tone: { type: 'STRING' }, notes: { type: 'STRING' } }, required: ['name'] } },
  { name: 'forget_contact', description: 'Löscht Kontakt.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
  { name: 'list_contacts', description: 'Listet alle Kontakte.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'find_group', description: 'Sucht Gruppe.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
  { name: 'save_group', description: 'Speichert Gruppe.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' }, members: { type: 'ARRAY', items: { type: 'STRING' } }, notes: { type: 'STRING' } }, required: ['name', 'members'] } },
  { name: 'forget_group', description: 'Löscht Gruppe.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
  { name: 'list_groups', description: 'Listet alle Gruppen.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'resolve_recipients', description: 'Löst Namen zu Empfängern auf.', parameters: { type: 'OBJECT', properties: { names: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['names'] } },
  { name: 'save_user_profile', description: 'Speichert Nutzer-Profil.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' }, address: { type: 'STRING' }, birthdate: { type: 'STRING' }, phone: { type: 'STRING' }, default_email: { type: 'STRING' } } } },
  { name: 'show_draft', description: 'Zeigt E-Mail-Entwurf als Karte (NUR normale Mails, NICHT Karussell).', parameters: { type: 'OBJECT', properties: { to: { type: 'STRING' }, subject: { type: 'STRING' }, body: { type: 'STRING' }, tone: { type: 'STRING' } }, required: ['to', 'subject', 'body', 'tone'] } },
  { name: 'send_email', description: 'Sendet E-Mail nach Bestätigung.', parameters: { type: 'OBJECT', properties: { to: { type: 'STRING' }, subject: { type: 'STRING' }, body: { type: 'STRING' }, tone: { type: 'STRING' } }, required: ['to', 'subject', 'body', 'tone'] } },
  { name: 'send_telegram_message', description: 'Sendet Telegram-Text.', parameters: { type: 'OBJECT', properties: { chat_id: { type: 'STRING' }, text: { type: 'STRING' } }, required: ['chat_id', 'text'] } },
];

const BUSINESS_TOOLS = [
  ...JONY_TOOLS,
  { name: 'generate_script', description: 'Erstellt Karussell-Skript.', parameters: { type: 'OBJECT', properties: { topic: { type: 'STRING' }, audience: { type: 'STRING' }, focus: { type: 'STRING' }, slide_count: { type: 'INTEGER' } }, required: ['topic'] } },
  { name: 'generate_image', description: 'Generiert Bild für Karussell-Slide.', parameters: { type: 'OBJECT', properties: { prompt: { type: 'STRING' }, slide_number: { type: 'INTEGER' } }, required: ['prompt', 'slide_number'] } },
  { name: 'send_carousel_email', description: 'Sendet Karussell MIT ALLEN BILDERN als E-Mail.', parameters: { type: 'OBJECT', properties: { to: { type: 'STRING' } }, required: ['to'] } },
  { name: 'send_carousel_telegram', description: 'Sendet Karussell MIT ALLEN BILDERN an Telegram.', parameters: { type: 'OBJECT', properties: { chat_id: { type: 'STRING' } }, required: ['chat_id'] } },
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
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeframe }) });
  if (!res.ok) throw new Error('Wetter-Fehler: ' + res.status);
  const data = await res.json();
  return { location: data.location, current_temp: data.current?.temp, current_desc: data.current?.description, today_min: data.today?.min, today_max: data.today?.max, tomorrow_desc: data.tomorrow?.description, rain_chance: data.today?.rain_chance };
}

// ★ ERWEITERT: broadcastet Restaurant-Karten
async function fetchRestaurants(location, cuisine = 'Restaurant', userId = null) {
  const url = SELF_URL + '/api/search-restaurant?location=' + encodeURIComponent(location);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cuisine }) });
  if (!res.ok) throw new Error('Restaurant-Fehler: ' + res.status);
  const data = await res.json();
  const restaurants = (data.restaurants || []).map(r => ({
    name: r.name,
    rating: r.rating,
    address: r.address,
    phone: r.phone,
    openNow: r.openNow,
    reviews: r.reviews,
  }));

  // ★ Restaurant-Karten an App broadcasten
  if (userId && restaurants.length > 0) {
    setRestaurants(userId, restaurants, { query: cuisine, location });
    broadcastToClients({
      type: 'restaurant_cards',
      restaurants: restaurants,
      query: cuisine,
      location: location,
    });
    console.log(`🍽️ Restaurant-Karten an App: ${restaurants.length}`);
  }

  return { count: restaurants.length, restaurants };
}

async function savePref(userId, key, value) {
  if (!userId) return { error: 'no user_id' };
  const valueStr = String(value || '').trim();
  if (!valueStr || valueStr === 'User Name' || valueStr === 'undefined') return { success: false };
  const res = await fetch(SELF_URL + '/api/save-preference', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, key, value: valueStr }) });
  return { success: res.ok };
}

async function getPrefs(userId) {
  if (!userId) return { error: 'no user_id' };
  const res = await fetch(SELF_URL + '/api/profile/' + userId);
  if (!res.ok) throw new Error('Lade-Fehler');
  const data = await res.json();
  return { preferences: data.data || {} };
}

async function findContact(userId, name) {
  const res = await fetch(SELF_URL + '/api/contacts/find', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, name }) });
  if (!res.ok) throw new Error('Kontakt-Suche fehlgeschlagen');
  return await res.json();
}

async function saveContact(userId, fields) {
  const res = await fetch(SELF_URL + '/api/contacts/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, ...fields }) });
  if (!res.ok) throw new Error('Kontakt-Speichern fehlgeschlagen');
  return await res.json();
}

async function forgetContact(userId, name) {
  const res = await fetch(SELF_URL + '/api/contacts/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, name }) });
  if (!res.ok) throw new Error('Kontakt-Löschen fehlgeschlagen');
  return await res.json();
}

async function listContacts(userId) {
  const res = await fetch(SELF_URL + '/api/contacts/list/' + userId);
  if (!res.ok) throw new Error('Liste fehlgeschlagen');
  return await res.json();
}

async function findGroup(userId, name) {
  const res = await fetch(SELF_URL + '/api/groups/find', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, name }) });
  if (!res.ok) throw new Error('Gruppen-Suche fehlgeschlagen');
  return await res.json();
}

async function saveGroup(userId, name, members, notes) {
  const res = await fetch(SELF_URL + '/api/groups/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, name, members, notes }) });
  if (!res.ok) throw new Error('Gruppen-Speichern fehlgeschlagen');
  return await res.json();
}

async function forgetGroup(userId, name) {
  const res = await fetch(SELF_URL + '/api/groups/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, name }) });
  if (!res.ok) throw new Error('Gruppen-Löschen fehlgeschlagen');
  return await res.json();
}

async function listGroups(userId) {
  const res = await fetch(SELF_URL + '/api/groups/list/' + userId);
  if (!res.ok) throw new Error('Liste fehlgeschlagen');
  return await res.json();
}

async function resolveRecipients(userId, names) {
  const res = await fetch(SELF_URL + '/api/contacts/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, names }) });
  if (!res.ok) throw new Error('Auflösen fehlgeschlagen');
  return await res.json();
}

async function saveUserProfile(userId, fields) {
  const res = await fetch(SELF_URL + '/api/user-profile/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, ...fields }) });
  if (!res.ok) throw new Error('Profil-Speichern fehlgeschlagen');
  return await res.json();
}

async function showDraft(userId, to, subject, body, tone, attachments = []) {
  if (!to || !subject || !body) return { error: 'to, subject, body required' };
  const draft = setDraft(userId, { to, subject, body, tone: tone || 'persönlich' });
  broadcastToClients({
    type: 'draft_shown',
    draft: {
      id: draft.id, to: draft.to, subject: draft.subject, body: draft.body, tone: draft.tone,
      attachments: (attachments || []).map(a => ({ id: a.id, filename: a.filename, size: a.size })),
    },
  });
  return { success: true, draft_id: draft.id, message: 'Entwurf angezeigt. Warte auf Bestätigung.' };
}

async function sendFreeEmail(to, subject, body, profile = {}, tone = 'persönlich') {
  const res = await fetch(SELF_URL + '/api/send-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, subject, body, profile, tone }) });
  if (!res.ok) return { error: `Versand fehlgeschlagen: ${res.status}` };
  const data = await res.json();
  const attachInfo = data.attachmentCount > 0 ? ` (${data.attachmentCount} Anhänge)` : '';
  if (profile?.user_id) clearDraft(profile.user_id);
  return { success: true, message: `E-Mail an ${to} gesendet${attachInfo}.` };
}

async function sendTelegram(chatId, text) {
  const res = await fetch(SELF_URL + '/api/telegram/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }) });
  if (!res.ok) return { error: 'Telegram-Versand fehlgeschlagen' };
  return { success: true, message: 'Telegram gesendet.' };
}

async function sendCarouselEmailTool(userId, to, profile = {}) {
  const carousel = getCarousel(userId);
  if (!carousel) return { error: 'Kein Karussell im Speicher.' };
  try {
    const res = await sendCarouselByEmail(to, carousel, profile);
    return { success: true, message: `Karussell "${res.topic}" mit ${res.imageCount} Bildern an ${to} gesendet.` };
  } catch (e) {
    return { error: 'E-Mail fehlgeschlagen: ' + e.message };
  }
}

async function sendCarouselTelegramTool(userId, chatId) {
  const carousel = getCarousel(userId);
  if (!carousel) return { error: 'Kein Karussell im Speicher.' };
  try {
    const res = await fetch(SELF_URL + '/api/telegram/send-carousel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, topic: carousel.topic, slides: carousel.slides, images: carousel.images }),
    });
    if (!res.ok) return { error: `Telegram fehlgeschlagen: ${res.status}` };
    const data = await res.json();
    return { success: true, message: `Karussell "${carousel.topic}" mit ${data.imagesSent} Bildern auf Telegram gesendet.` };
  } catch (e) {
    return { error: e.message };
  }
}

// ==================== SCRIPT + IMAGE ====================

async function generateScriptAndBroadcast(topic, audience, focus, slideCount, userId) {
  if (!process.env.GROQ_API_KEY) return { error: 'GROQ_API_KEY fehlt.' };
  const count = slideCount && slideCount >= 1 && slideCount <= 10 ? slideCount : 8;
  const prompt = 'Erstelle ein Instagram-Karussell-Skript als JSON.\n\nThema: ' + topic + '\nZielgruppe: ' + (audience || 'Allgemein') + '\nFokus: ' + (focus || 'Tipps, Fakten, Mehrwert') + '\nAnzahl Slides: ' + count + '\n\nAntworte NUR mit JSON:\n{"slides":[{"slide":1,"title":"Hook","body":"Text max 20 Wörter","image_prompt":"ENGLISH IMAGE PROMPT 35-50 Wörter"}]}';

  let lastError = null;
  for (const modelName of GROQ_FALLBACKS) {
    try {
      const completion = await groq.chat.completions.create({
        messages: [{ role: 'system', content: 'Antworte AUSSCHLIESSLICH mit gültigem JSON.' }, { role: 'user', content: prompt }],
        model: modelName, temperature: 0.7, response_format: { type: 'json_object' },
      });
      const text = completion.choices[0]?.message?.content || '';
      let slides = null;
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) slides = parsed;
        else if (parsed.slides && Array.isArray(parsed.slides)) slides = parsed.slides;
      } catch (e) { return { error: 'JSON-Parse: ' + e.message }; }
      if (!slides || slides.length === 0) return { error: 'Skript leer' };
      if (userId) setScript(userId, topic, slides);
      broadcastToClients({ type: 'script', topic, slides });
      return { success: true, slide_count: slides.length, message: `Skript mit ${slides.length} Slides angezeigt.` };
    } catch (e) {
      lastError = e;
      const errMsg = e.message || String(e);
      if (errMsg.includes('404') || errMsg.includes('does not exist')) continue;
    }
  }
  return { error: 'Skript-Generierung fehlgeschlagen: ' + (lastError?.message || '?') };
}

async function translateToEnglishImagePrompt(germanPrompt) {
  try {
    const c = await groq.chat.completions.create({
      messages: [{ role: 'system', content: 'Prompt-Engineer für FLUX.1. 40-60 Wörter englisch.' }, { role: 'user', content: germanPrompt }],
      model: 'openai/gpt-oss-20b', temperature: 0.4,
    });
    return c.choices[0]?.message?.content?.trim().replace(/^["']|["']$/g, '') || germanPrompt;
  } catch (e) { return germanPrompt; }
}

async function generateImageWithCloudflare(prompt) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new Error('CLOUDFLARE credentials fehlen.');
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
  const r = await fetch(url, { method: 'POST', headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, steps: 8 }) });
  if (!r.ok) throw new Error(`Cloudflare HTTP ${r.status}`);
  const data = await r.json();
  if (!data.success || !data.result?.image) throw new Error('Kein Bild');
  return { imageBase64: data.result.image, mimeType: 'image/jpeg' };
}

async function generateImageAndBroadcast(prompt, slideNumber, userId) {
  try {
    const en = await translateToEnglishImagePrompt(prompt);
    const result = await generateImageWithCloudflare(en);
    if (userId) addImage(userId, slideNumber, result.imageBase64, result.mimeType);
    broadcastToClients({ type: 'image', slide: slideNumber, mimeType: result.mimeType, data: result.imageBase64 });
    return { success: true, slide: slideNumber };
  } catch (e) {
    return { error: 'Bildgenerierung fehlgeschlagen: ' + e.message, slide: slideNumber };
  }
}

// ==================== TOOL DISPATCH ====================

async function executeChatTool(name, args, userId, profile, currentLocation, attachments) {
  if (name === 'get_weather') { let loc = args.location; if (isHereKeyword(loc) && currentLocation?.city) loc = currentLocation.city; return await fetchWeather(loc, args.timeframe); }
  if (name === 'find_restaurants') {
    let loc = args.location;
    if (isHereKeyword(loc) && currentLocation?.city) loc = currentLocation.city;
    return await fetchRestaurants(loc, args.cuisine, userId);
  }
  if (name === 'save_user_preference') return await savePref(userId, args.key, args.value);
  if (name === 'get_user_preferences') return await getPrefs(userId);
  if (name === 'find_contact') return await findContact(userId, args.name);
  if (name === 'save_contact') { const { name: c, ...f } = args; return await saveContact(userId, { name: c, ...f }); }
  if (name === 'forget_contact') return await forgetContact(userId, args.name);
  if (name === 'list_contacts') return await listContacts(userId);
  if (name === 'find_group') return await findGroup(userId, args.name);
  if (name === 'save_group') return await saveGroup(userId, args.name, args.members, args.notes);
  if (name === 'forget_group') return await forgetGroup(userId, args.name);
  if (name === 'list_groups') return await listGroups(userId);
  if (name === 'resolve_recipients') return await resolveRecipients(userId, args.names);
  if (name === 'save_user_profile') return await saveUserProfile(userId, args);
  if (name === 'show_draft') return await showDraft(userId, args.to, args.subject, args.body, args.tone, attachments);
  if (name === 'send_email') { const p = { ...profile, user_id: userId }; return await sendFreeEmail(args.to, args.subject, args.body, p, args.tone || 'persönlich'); }
  if (name === 'send_telegram_message') return await sendTelegram(args.chat_id, args.text);
  if (name === 'generate_script') return await generateScriptAndBroadcast(args.topic, args.audience, args.focus, args.slide_count, userId);
  if (name === 'generate_image') return await generateImageAndBroadcast(args.prompt, args.slide_number, userId);
  if (name === 'send_carousel_email') return await sendCarouselEmailTool(userId, args.to, profile);
  if (name === 'send_carousel_telegram') return await sendCarouselTelegramTool(userId, args.chat_id);
  return { error: 'Unbekanntes Tool: ' + name };
}

// ==================== HISTORIE ====================

async function loadChatHistory(userId, limit = 10) {
  try {
    const result = await pool.query(`SELECT role, content, created_at FROM chat_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]);
    if (result.rows.length === 0) return [];
    const newest = result.rows[0];
    const newestTime = new Date(newest.created_at).getTime();
    if ((Date.now() - newestTime) > CHAT_SESSION_RESET_MS) return [];
    const msgs = [];
    let prev = newestTime;
    for (const row of result.rows) {
      const t = new Date(row.created_at).getTime();
      if ((prev - t) > CHAT_SESSION_RESET_MS) break;
      msgs.push(row);
      prev = t;
    }
    msgs.reverse();
    return msgs.slice(-limit);
  } catch (e) { return []; }
}

async function saveChatMessage(userId, role, content) {
  try {
    await pool.query(`INSERT INTO chat_history (user_id, role, content) VALUES ($1, $2, $3)`, [userId, role, content]);
  } catch (e) {}
}

export async function getChatHistory(userId, limit = 50) {
  try {
    const result = await pool.query(`SELECT role, content, created_at FROM chat_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]);
    if (result.rows.length === 0) return [];
    const newestTime = new Date(result.rows[0].created_at).getTime();
    const msgs = [];
    let prev = newestTime;
    for (const row of result.rows) {
      const t = new Date(row.created_at).getTime();
      if ((prev - t) > CHAT_SESSION_RESET_MS) break;
      msgs.push(row);
      prev = t;
    }
    msgs.reverse();
    return msgs.slice(-limit);
  } catch (e) { return []; }
}

export async function initChatTable() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS chat_history (id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_history_user_time ON chat_history (user_id, created_at DESC)`);
    console.log('✅ chat_history bereit');
  } catch (e) {}
}

async function loadUserData(userId) {
  try {
    const res = await fetch(SELF_URL + '/api/profile/' + userId);
    if (!res.ok) return {};
    const data = await res.json();
    return data.data || {};
  } catch (e) { return {}; }
}

// ==================== RESTAURANT-EXPORT ====================

export function getLastRestaurants(userId) {
  return getRestaurants(userId);
}

export function clearLastRestaurants(userId) {
  return clearRestaurants(userId);
}

// ==================== MODUS ====================

function detectChatMode(message, currentMode = 'jony') {
  const t = message.toLowerCase();
  if (/business.?modus|business\s+mode|бизнес.?мод|бизнес/.test(t)) return { mode: 'business', role: null };
  if (/zur[üu]ck.*freund|freund.?modus|normal.?modus|business\s+aus/.test(t)) return { mode: 'jony', role: 'freund' };
  if (currentMode === 'jony') {
    if (/party.?modus|jony.*party|partymodus|пати/.test(t)) return { mode: 'jony', role: 'party' };
    if (/berater|sachlich|советник/.test(t)) return { mode: 'jony', role: 'berater' };
    if (/kids|kinder|niklas|детск/.test(t)) return { mode: 'jony', role: 'kids' };
    if (/freund|normal|zur[üu]ck/.test(t)) return { mode: 'jony', role: 'freund' };
  }
  return null;
}

// ==================== HAUPTFUNKTION ====================

export async function handleChatMessage(userId, userMessage, currentRole = 'freund', currentMode = 'jony', currentLocation = null, attachments = []) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  console.log(`💬 Chat (${currentMode}/${currentRole}): "${userMessage.substring(0, 60)}"`);
  console.log(`🔖 BUILD-MARKER v7 | JONY_TOOLS: ${JONY_TOOLS.length} | Grounding: AN | Restaurant-Karten: AN`);

  let activeMode = currentMode;
  let activeRole = currentRole;
  const sw = detectChatMode(userMessage, currentMode);
  if (sw) {
    activeMode = sw.mode;
    if (sw.role) activeRole = sw.role;
    console.log(`🎭 Wechsel: → ${activeMode}/${activeRole}`);
  }

  const userData = await loadUserData(userId);
  const history = await loadChatHistory(userId, 8);

  const systemInstruction = buildSystemPrompt(userData, activeRole, activeMode, currentLocation, attachments);
  const toolsList = activeMode === 'business' ? BUSINESS_TOOLS : JONY_TOOLS;

  console.log(`   📏 System-Prompt: ${systemInstruction.length} Zeichen`);
  console.log(`   📚 History: ${history.length}`);
  console.log(`   🔧 Tools: ${toolsList.length}`);

  const contents = [
    ...history.map(h => ({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.content }] })),
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  let finalText = null;
  let finalSources = [];
  let attempts = 0;

  console.log(`   🔄 Starte Modell-Loop (${CHAT_MODELS.length} Modelle)`);

  while (attempts < 5) {
    attempts++;
    let response = null;
    let usedModel = null;

    for (const modelName of CHAT_MODELS) {
      try {
        response = await ai.models.generateContent({
          model: modelName,
          contents,
          config: {
            systemInstruction: { parts: [{ text: systemInstruction }] },
            tools: [
              { functionDeclarations: toolsList },
              { googleSearch: {} },
            ],
            toolConfig: {
              includeServerSideToolInvocations: true,
            },
            temperature: 0.8,
            maxOutputTokens: 500,
            thinkingConfig: { thinkingLevel: 'low' },
          },
        });
        usedModel = modelName;
        console.log(`   ✅ Modell: ${modelName}`);
        if (response.usageMetadata) {
          const u = response.usageMetadata;
          console.log(`   📊 TOKENS: input=${u.promptTokenCount || 0}, output=${u.candidatesTokenCount || 0}, total=${u.totalTokenCount || 0}`);
        }
        break;
      } catch (e) {
        const errMsg = e.message || String(e);
        console.error(`   ❌ ${modelName}-Fehler:`, errMsg.substring(0, 300));
        if (errMsg.includes('404') || errMsg.includes('NOT_FOUND')) continue;
        if (errMsg.includes('thinking') || errMsg.includes('Thinking')) {
          try {
            response = await ai.models.generateContent({
              model: modelName,
              contents,
              config: {
                systemInstruction: { parts: [{ text: systemInstruction }] },
                tools: [
                  { functionDeclarations: toolsList },
                  { googleSearch: {} },
                ],
                toolConfig: {
                  includeServerSideToolInvocations: true,
                },
                temperature: 0.8,
                maxOutputTokens: 500,
              },
            });
            usedModel = modelName;
            console.log(`   ✅ Modell: ${modelName} (ohne thinking)`);
            break;
          } catch (e2) {
            console.error(`   ❌ ${modelName}-Fehler ohne thinking:`, (e2.message || String(e2)).substring(0, 300));
            continue;
          }
        }
        continue;
      }
    }

    if (!response) {
      console.error('   ❌ Kein Response von Modellen erhalten');
      break;
    }
    const candidate = response.candidates?.[0];
    if (!candidate) {
      console.error('   ❌ Kein candidate in Response');
      break;
    }

    const parts = candidate.content?.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);

    if (functionCalls.length > 0) {
      if (response.usageMetadata && usedModel) {
        const u = response.usageMetadata;
        await logTokenUsage(userId, 'chat_tool', usedModel, u.promptTokenCount || 0, u.candidatesTokenCount || 0, functionCalls.length);
      }

      contents.push({ role: 'model', parts });
      for (const part of functionCalls) {
        const fc = part.functionCall;
        console.log(`   🔧 Tool: ${fc.name}`);
        let toolResult;
        try {
          toolResult = await executeChatTool(fc.name, fc.args || {}, userId, { ...userData, user_id: userId }, currentLocation, attachments);
        } catch (e) { toolResult = { error: e.message }; }
        contents.push({ role: 'user', parts: [{ functionResponse: { name: fc.name, response: toolResult } }] });
      }
      continue;
    }

    if (response.usageMetadata && usedModel) {
      const u = response.usageMetadata;
      await logTokenUsage(userId, 'chat', usedModel, u.promptTokenCount || 0, u.candidatesTokenCount || 0, 0);
    }

    finalText = parts.filter(p => p.text).map(p => p.text).join('').trim();

    try {
      const gm = candidate.groundingMetadata;
      if (gm && Array.isArray(gm.groundingChunks)) {
        finalSources = gm.groundingChunks
          .filter(c => c.web && c.web.uri)
          .slice(0, 5)
          .map(c => ({
            title: c.web.title || c.web.uri,
            uri: c.web.uri,
          }));
        if (finalSources.length > 0) {
          console.log(`   🌐 Grounding: ${finalSources.length} Quellen gefunden`);
        }
      }
    } catch (e) {
      console.error('⚠️ Grounding-Parse:', e.message);
    }

    break;
  }

  if (!finalText) finalText = 'Hmm, ich hab grad nichts zu sagen. Frag nochmal.';

  console.log(`✅ Antwort (${finalText.length} Zeichen)`);

  await saveChatMessage(userId, 'user', userMessage);
  await saveChatMessage(userId, 'assistant', finalText);

  return { reply: finalText, mode: activeMode, role: activeRole, sources: finalSources };
}
