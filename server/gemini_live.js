// server/gemini_live.js

import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import { detectMode, logPresence } from './supervisor.js';
import { sendTelegramMessage, onTelegramMessage } from './telegram.js';
import { sendCarouselByEmail } from './email.js';
import { setScript, addImage, getCarousel } from './carousel_store.js';

const GEMINI_MODEL = 'gemini-3.8-live';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const GROQ_FALLBACKS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'qwen/qwen3.6-27b',
  'groq/compound',
];
const SAMPLE_RATE_IN = 16000;
const SAMPLE_RATE_OUT = 24000;
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:' + (process.env.PORT || 8080);

// ==================== GROQ CLIENT ====================

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

// ==================== HILFSFUNKTIONEN ====================

function isHereKeyword(loc) {
  if (!loc || typeof loc !== 'string') return false;
  const t = loc.toLowerCase().trim();
  return /^(hier|hier\s+bei\s+mir|bei\s+mir|mein\s+standort|meine\s+position|aktueller\s+standort|vor\s+ort|hier\s+vor\s+ort|здесь|тут|у\s+меня|моё\s+местоположение)$/.test(t);
}

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
  '===========================================',
  'SPRACHREGEL',
  '===========================================',
  '',
  'Du sprichst AUSSCHLIESSLICH zwei Sprachen:',
  '- DEUTSCH',
  '- RUSSISCH',
  '',
  'Wenn der Nutzer Deutsch spricht → Deutsch.',
  'Wenn der Nutzer Russisch spricht → Russisch.',
  '',
  'Wenn der Nutzer eine ANDERE Sprache spricht oder nur Wortfetzen:',
  '→ REAGIERE NICHT mit "Bitte Deutsch oder Russisch".',
  '→ Gehe einfach auf DEUTSCH normal weiter.',
  '',
  'AUSNAHME: Dolmetscher-Modus (nur auf expliziten Befehl)',
].join('\n');

const ANTI_REPETITION = [
  '===========================================',
  '🚨 ANTI-WIEDERHOLUNGS-REGEL',
  '===========================================',
  '',
  'Du bist KEIN Roboter. Ein echter Freund wiederholt sich NICHT.',
  '',
  'VERBOTEN:',
  '- Immer dieselbe Begrüßung',
  '- Immer dieselbe Location-Frage',
  '- Immer dieselbe Verabschiedung',
  '- Immer dieselbe Rückfrage',
  '',
  'REGELN:',
  '1. Wähle eine ANDERE Begrüßung als beim letzten Mal.',
  '2. Nutze NICHT automatisch den Namen – nur ab und zu.',
  '3. Erwähne NICHT automatisch den Standort.',
  '4. Variiere Satzlängen: Mal 3 Wörter, mal 15.',
  '',
  'BEGRÜSSUNGS-BIBLIOTHEK:',
  '- "Hey." / "Na?" / "Servus!" / "Ah, da bist du ja."',
  '- "Moin." / "Endlich!" / "Biste wieder da?" / "Na, alles fit?"',
  '- "Grüß dich." / "Was geht?" / "Da isser ja." / "Hi."',
  '- ODER ERFINDE SELBST WAS NEUES.',
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
  'C) BEHÖRDEN (finanzamt, amt, behörde, rathaus, polizei, gericht,',
  '   krankenkasse, versicherung, standesamt, bürgeramt, ordnungsamt):',
  '   → Automatisch formell, kein Nachfragen',
  'D) TON-WECHSEL nur auf explizite Aufforderung',
  '',
  'FORMELL: Anrede "Sehr geehrte Damen und Herren,", Gruß "Mit freundlichen Grüßen", Siezen',
  'PERSÖNLICH: Anrede "Hallo Alex,", Gruß "Viele Grüße", freundlich warm',
  'LOCKER: Anrede "Hey Alex,", Gruß "LG" oder "Bis dann", duzen',
].join('\n');

const CONTACT_RULES = [
  '===========================================',
  '📇 KONTAKT- & GRUPPEN-GEDÄCHTNIS',
  '===========================================',
  '',
  '🚨 EISERNE REGELN — NIE BRECHEN 🚨',
  '',
  'REGEL 1: NIEMALS eine E-Mail verfassen, bevor du:',
  '  a) Weißt welcher TON (formell/persönlich/locker)',
  '  b) Die E-Mail-ADRESSE des Empfängers kennst',
  '',
  'REGEL 2: NIEMALS eine E-Mail versenden, ohne dass:',
  '  a) Der Nutzer den kompletten Entwurf gesehen hat',
  '  b) Der Nutzer explizit "ja" / "ok" / "senden" gesagt hat',
  '',
  'PFLICHT-ABLAUF bei "Schreib an [Name/Gruppe]: ...":',
  '',
  'Schritt 1: find_contact(name) UND find_group(name) aufrufen',
  '',
  'Schritt 2: Prüfe Ergebnis.',
  '  - EINZELKONTAKT GEFUNDEN: → Ton + Adresse → Schritt 5',
  '  - GRUPPE GEFUNDEN: → alle Mitglieder auflösen',
  '  - NICHT GEFUNDEN: → STOPP! Schreibe NOCH NICHTS. → Schritt 3',
  '',
  'Schritt 3: Prüfe Behörden-Keyword',
  '  - BEHÖRDE: → Ton = formell → Schritt 4',
  '  - SONST: → Frage "Formell, persönlich oder locker?" → WARTE → Schritt 4',
  '',
  'Schritt 4: Frage "Wie lautet [Name]s E-Mail-Adresse?" → WARTE',
  '',
  'Schritt 5: Rufe show_draft(to, subject, body, tone) auf.',
  '',
  'Schritt 6: WARTE auf Reaktion (siehe ENTWURF-REGEL unten)',
  '',
  'Schritt 7: send_email(to, subject, body, tone)',
  '  ⛔ Du schreibst KEINE Signatur — der Server hängt sie an.',
  '',
  'KONTAKT-VERWALTUNG:',
  '- "Vergiss Alex" → forget_contact(name: "alex")',
  '- "Welche Kontakte kenne ich?" → list_contacts()',
  '',
  '👥 GRUPPEN:',
  '- "Meine Familie sind Mama, Papa, Alex"',
  '  → save_group(name: "familie", members: ["mama", "papa", "alex"])',
  '- "Schreib an meine Familie: ..."',
  '  → find_group("familie") → alle Mitglieder werden aufgelöst',
  '- "Vergiss die Gruppe Familie" → forget_group("familie")',
  '- "Welche Gruppen habe ich?" → list_groups()',
  '',
  'MEHRERE EMPFÄNGER:',
  '- "Schreib an Alex und Constantin: ..."',
  '  → resolve_recipients(["alex", "constantin"])',
  '',
  'NUTZER-PROFIL (lerne aus Kontext):',
  '- "Ich bin Eugen Priss" → save_user_profile(name: "...")',
  '- "Ich wohne in ..." → save_user_profile(address: "...")',
  '- "Meine E-Mail ist ..." → save_user_profile(default_email: "...")',
].join('\n');

const DRAFT_RULE = [
  '===========================================',
  '📝 ENTWURF-REGEL (gilt für NORMALE E-Mails)',
  '===========================================',
  '',
  '⚠️ GILT NICHT für Karussells! (siehe Business-Workflow)',
  '',
  'Wenn Ton + Adresse geklärt sind → show_draft aufrufen.',
  '',
  '⛔ LIES DEN ENTWURF NIEMALS LAUT VOR!',
  '⛔ WIEDERHOLE NICHT: An:, Betreff:, Text: in deiner Sprache.',
  '',
  'Die App zeigt die Karte automatisch.',
  'Du sagst nur EINEN kurzen Satz:',
  '- "Entwurf ist da. Schau auf den Bildschirm."',
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '⏸️ NACH show_draft: WARTE auf Reaktion',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  '✅ JA-WÖRTER → Rufe SOFORT send_email auf:',
  '- "ja" / "jep" / "ok" / "okay"',
  '- "senden" / "schick" / "schick weg" / "raus"',
  '- "los" / "passt" / "ab damit"',
  '',
  '❌ NEIN-WÖRTER → Verwirf den Entwurf:',
  '- "nein" / "abbrechen" / "lösch" / "lösche"',
  '- "vergiss es" / "verwerfen" / "ändern"',
  '',
  '❓ UNKLAR → Rückfrage: "Senden oder verwerfen?"',
  '',
  'NACH DEM SENDEN: "✅ Ist raus."',
  'NACH DEM VERWERFEN: "Okay, verworfen."',
].join('\n');

const SIGNATURE_RULE = [
  '===========================================',
  '✍️ SIGNATUR-REGEL',
  '===========================================',
  '',
  'Du schreibst E-Mails OHNE Signatur am Ende.',
  'Kein "LG Jony", kein "Viele Grüße", KEIN NAME.',
  'Der Server fügt die Signatur automatisch hinzu.',
  '',
  '⛔ NIEMALS selbst unterschreiben.',
].join('\n');

const ATTACHMENT_RULE = [
  '===========================================',
  '📎 ANHANG-REGEL',
  '===========================================',
  '',
  'Anhänge werden AUTOMATISCH mitgeschickt — du rufst KEIN Tool extra auf.',
  '',
  'WENN Anhänge bereit sind:',
  '- Der System-Prompt sagt es dir unter "📎 AKTUELLE ANHÄNGE:"',
  '- Erwähne sie NICHT explizit im body.',
].join('\n');

const TELEGRAM_RULE = [
  '===========================================',
  '📨 TELEGRAM',
  '===========================================',
  '',
  'Du kannst Telegram-Nachrichten senden mit send_telegram_message.',
  'Frage IMMER zuerst: "Soll ich das schicken?"',
  '',
  'Standard-Empfänger (Eugen): 8448058381',
].join('\n');

const STANDORT_RULE = [
  '===========================================',
  'STANDORT-REGEL',
  '===========================================',
  '',
  'Wenn der Nutzer "hier", "bei mir" oder "mein Standort" sagt →',
  'nutze das als location für get_weather / find_restaurants.',
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
    if (profile.current_lat != null && profile.current_lon != null) {
      const lat = Number(profile.current_lat);
      const lon = Number(profile.current_lon);
      if (!isNaN(lat) && !isNaN(lon)) {
        locationInfo += ' (GPS: ' + lat.toFixed(3) + ', ' + lon.toFixed(3) + ')';
      }
    }
  }

  // ---- Anhänge ----
  let attachmentNote = null;
  if (attachments && attachments.length > 0) {
    const lines = attachments.map(a =>
      '  - ' + a.filename + ' (' + Math.round(a.size / 1024) + ' KB)'
    );
    attachmentNote = '📎 AKTUELLE ANHÄNGE: ' + attachments.length + ' Datei(en) bereit:\n' + lines.join('\n');
  }

  // ---- Zusammenbau ----
  const sections = [
    LANGUAGE_RULE,
    '',
    ANTI_REPETITION,
    '',
    'Heute ist ' + today + ' (' + timeCtx + ').',
    'Der Nutzer heißt ' + name + '.',
    'Aber nutze seinen Namen NICHT in jeder Antwort. Nur manchmal.',
    '',
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
    DRAFT_RULE,
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
  freund: {
    name: 'Freund',
    prompt: [
      'Du bist im FREUND-MODUS.',
      '- Sei wie ein guter, alter Freund.',
      '- Sprich aus dem Bauch.',
      '- 1-3 Sätze.',
      '- Variiere.',
    ].join('\n'),
  },
  party: {
    name: 'Party',
    prompt: [
      'Du bist im PARTY-MODUS.',
      '- Locker, jugendlich, mit Humor.',
      '- Coole Kumpel.',
      '- Aktiv, nicht aufdringlich.',
    ].join('\n'),
  },
  berater: {
    name: 'Berater',
    prompt: [
      'Du bist im BERATER-MODUS.',
      '- Sachlich, präzise.',
      '- Bei Recht/Medizin/Finanzen: Hinweis auf menschliche Prüfung.',
      '- 2-4 Sätze.',
    ].join('\n'),
  },
  kids: {
    name: 'Kids',
    prompt: [
      'Du bist im KIDS-MODUS – für Kinder (8-14 Jahre).',
      '- Locker, entspannt, wie ein älterer Cousin (14-16).',
      '- NIE herablassend, NIE peinlich.',
      '- Themen: Gaming, Fußball, YouTube, coole Fakten, Tiere.',
      '',
      'WENN DU MIT NIKLAS SPRICHST (11):',
      '- Er spielt Fußball (mit Papa).',
      '- Er ist stark in Mathe.',
      '- Sein Bruder Konstantin ist über 18.',
      '',
      'GEDÄCHTNIS: Wenn Niklas was über sich erzählt → save_user_preference (key: "niklas_<thema>").',
    ].join('\n'),
  },
};

const JONY_BASE = [
  'Du bist Jony, der persönliche Begleiter von Eugen (auch Jackson genannt).',
  'Ehrlich, warmherzig, direkt, humorvoll. Kein Assistent – ein Freund.',
].join('\n');

const JONY_TOOLS_LIST = [
  'get_weather, find_restaurants, get_user_preferences, save_user_preference,',
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
  '',
  '🚨 WICHTIG: Du SPRICHST Skripte NIEMALS laut vor.',
  '',
  'WORKFLOW:',
  '1. Thema klären',
  '2. Sage: "Alles klar, ich erstelle das Skript."',
  '3. Rufe generate_script auf',
  '4. Nach Tool: "Skript ist da. Schau in die App."',
  '5. Bei "mach Bilder": generate_image für JEDEN Slide einzeln',
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
  'BEISPIEL 1:',
  'Nutzer: "Schick mir das per Mail"',
  'Jony: "Soll ich das Karussell an eugen.priss@yahoo.com senden?"',
  'Nutzer: "Ja"',
  'Jony: (ruft send_carousel_email auf — NICHT show_draft!)',
  '',
  'BEISPIEL 2:',
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

function buildJonyPrompt(profile, role = 'freund', attachments = []) {
  const foundation = buildFoundation(profile, attachments);
  const roleData = ROLES[role] || ROLES.freund;

  return [
    foundation,
    '',
    JONY_BASE,
    '',
    '===========================================',
    'AKTIVE ROLLE: ' + roleData.name.toUpperCase(),
    '===========================================',
    roleData.prompt,
    '',
    '===========================================',
    'MODUS (NORMAL/SILENT)',
    '===========================================',
    'NORMAL: aktiv, freundlich.',
    'SILENT: aufmerksam, aber reagierst NICHT – Ausnahme "Hey Jony".',
    '',
    '===========================================',
    'SEHEN UND HÖREN',
    '===========================================',
    '"Was siehst du?" → beschreibe letzten Video-Frame.',
    '',
    '===========================================',
    'TOOLS',
    '===========================================',
    JONY_TOOLS_LIST,
    '',
    'NIEMALS Wetter/Restaurants erfinden.',
  ].join('\n');
}

function buildBusinessPrompt(profile, attachments = []) {
  const foundation = buildFoundation(profile, attachments);

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

// ==================== MODUS-INSTRUKTION ====================

function modeInstruction(mode) {
  if (mode === 'silent') {
    return '[SYSTEM-INSTRUKTION] SILENT-MODUS. Aufmerksam, aber reagiere NICHT. Ausnahme: "Hey Jony" → "Ja?".';
  }
  return '[SYSTEM-INSTRUKTION] NORMAL-MODUS. Freundlich, kurz. Variiere.';
}

function roleSwitchInstruction(role) {
  const roleData = ROLES[role] || ROLES.freund;
  return '[SYSTEM-INSTRUKTION] Rollenwechsel zu ' + roleData.name.toUpperCase() + '.\n\n' + roleData.prompt;
}

function dolmetscherInstruction(active) {
  if (active) {
    return '[SYSTEM-INSTRUKTION] DOLMETSCHER-MODUS AKTIV.\n\n' +
           'Du bist jetzt Übersetzer zwischen beliebigen Sprachen.\n' +
           '- Fremde Person spricht → Übersetze ins DEUTSCHE für Eugen.\n' +
           '- Eugen sagt was (Deutsch/Russisch) → Übersetze in die Zielsprache.\n' +
           '- Format: NUR die Übersetzung.\n' +
           '- Bestätige beim Start: "Dolmetscher-Modus aktiv."\n' +
           '- Beenden mit "Jony, Dolmetscher aus".\n\n' +
           'In diesem Modus darfst du ALLE Sprachen sprechen.';
  }
  return '[SYSTEM-INSTRUKTION] Dolmetscher-Modus beendet.';
}

// ==================== NAME-PATTERN ====================

const NAME_PATTERN = '(jony|johnny|joni|джони|джонни|джонi)';

const PATTERNS = {
  business: new RegExp(
    `\\b(${NAME_PATTERN}.?business|business.?modus|business\\s+mode|бизнес.?мод|бизнес)\\b`,
    'i'
  ),
  backToJony: new RegExp(
    `\\b(${NAME_PATTERN}.?(zur[üu]ck|freund|normal|back|обратно|вернись)|` +
    `zur[üu]ck.*(freund|jony|johnny)|` +
    `freund.?modus|normal.?modus|freundesmodus|` +
    `вернись.*друг|обратно.*друг|режим.?друга)\\b`,
    'i'
  ),
  party: new RegExp(
    `\\b(${NAME_PATTERN}.?party|party.?modus|partymodus|party\\s+mode|` +
    `${NAME_PATTERN}.?пати|пати.?мод|вечеринк)\\b`,
    'i'
  ),
  berater: new RegExp(
    `\\b(${NAME_PATTERN}.?(berater|sachlich|intellektuell)|` +
    `berater.?modus|beratermodus|` +
    `${NAME_PATTERN}.?советник|советник.?мод|консультант)\\b`,
    'i'
  ),
  kids: new RegExp(
    `\\b(${NAME_PATTERN}.?(kids|niklas|kinder|kind|junge|junior|kumpel)|` +
    `kids.?modus|kinder.?modus|niklas.?modus|junge.?modus|` +
    `${NAME_PATTERN}.?(детск|пацан|малой|ребенок|ребёнок)|` +
    `детск.?мод|детск.?режим)\\b`,
    'i'
  ),
  dolmetscher: new RegExp(
    `\\b(${NAME_PATTERN}.?(dolmetscher|übersetz|uebersetz|translator)|` +
    `dolmetscher.?modus|übersetzer|uebersetzer|` +
    `${NAME_PATTERN}.?(перевод|переводчик)|переводчик|режим.?перевода)\\b`,
    'i'
  ),
};

// ==================== PROAKTIV ====================

const PROACTIVE_INTERVALS = {
  kids: 25000,
  party: 15000,
  freund: 45000,
  berater: 0,
};

function buildProactivePrompt(role) {
  if (role === 'kids') {
    return '[SYSTEM-INSTRUKTION] Es ist kurz still. Sei PROAKTIV aber LOCKER: Frag nach was Coolem.';
  }
  if (role === 'party') {
    return '[SYSTEM-INSTRUKTION] Es ist seit einer Weile still. Sei PROAKTIV: Lockerer Spruch, 1 Satz.';
  }
  if (role === 'freund') {
    return '[SYSTEM-INSTRUKTION] Es ist still. Sei sanft proaktiv: Neugierige Frage. 1 kurzer Satz.';
  }
  return null;
}

// ==================== AGENT-DEFINITIONEN ====================

const AGENTS = {
  jony: {
    voice: 'Fenrir',
    buildPrompt: (profile, role, attachments) => buildJonyPrompt(profile, role, attachments),
    tools: () => buildJonyTools(),
  },
  business: {
    voice: 'Charon',
    buildPrompt: (profile, role, attachments) => buildBusinessPrompt(profile, attachments),
    tools: () => buildBusinessTools(),
  },
};

// ==================== AKTIVE CLIENTS ====================

const activeClients = new Set();

// ==================== BROADCAST ====================

export function broadcastToClients(msg) {
  console.log(`📢 Broadcast an ${activeClients.size} Clients: ${msg.type}`);
  for (const c of activeClients) {
    try {
      c.send(JSON.stringify(msg));
    } catch (e) {}
  }
}

// ==================== HELPER: Attachments holen ====================

async function fetchUserAttachments(userId) {
  if (!userId) return [];
  try {
    const res = await fetch(SELF_URL + '/api/attachments/list/' + userId);
    if (!res.ok) return [];
    const data = await res.json();
    return data.attachments || [];
  } catch (e) {
    return [];
  }
}

// ==================== GEMINI LIVE SETUP ====================

export async function createGeminiSession(clientWs, userProfile, agentType = 'jony') {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const agentConfig = AGENTS[agentType] || AGENTS.jony;

  // ★ FIX: KOMPLETTES user_data aus DB übernehmen (vorher nur 8 Felder)
  if (userProfile.user_id) {
    try {
      const dbRes = await fetch(SELF_URL + '/api/profile/' + userProfile.user_id);
      if (dbRes.ok) {
        const dbData = await dbRes.json();
        const dbProfile = dbData.data || {};
        Object.assign(userProfile, dbProfile);
        const keyCount = Object.keys(dbProfile).length;
        console.log(`✅ Profil angereichert: ${keyCount} Keys, name="${userProfile.name || userProfile.user_name || '?'}"`);
      }
    } catch (e) {
      console.error('⚠️ Profil-Anreicherung fehlgeschlagen:', e.message);
    }
  }

  if (clientWs._lastLat != null && clientWs._lastLon != null) {
    userProfile.current_lat = clientWs._lastLat;
    userProfile.current_lon = clientWs._lastLon;
    userProfile.current_city = userProfile.hometown;
  }

  const currentAttachments = await fetchUserAttachments(userProfile.user_id);
  clientWs._currentAttachments = currentAttachments;

  console.log(`🔌 Verbinde zu Gemini Live (Agent: ${agentType}, Voice: ${agentConfig.voice}, Anhänge: ${currentAttachments.length})...`);

  const systemInstruction = agentConfig.buildPrompt(
    userProfile,
    clientWs._currentRole || 'freund',
    currentAttachments
  );

  let session = null;

  session = await ai.live.connect({
    model: GEMINI_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: agentConfig.voice },
        },
      },
      systemInstruction: { parts: [{ text: systemInstruction }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      tools: agentConfig.tools(),
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
          prefixPaddingMs: 10,
          silenceDurationMs: 300,
        },
      },
    },
    callbacks: {
      onopen: () => {
        console.log(`✅ Gemini Live Session geöffnet (${agentType})`);
        clientWs.send(JSON.stringify({ type: 'status', status: 'connected', agent: agentType }));
      },
      onmessage: (message) => {
        if (clientWs._session !== session) return;
        handleGeminiMessage(clientWs, message, session, userProfile, agentType);
      },
      onerror: (error) => {
        console.error('❌ Gemini Live Fehler:', error);
        try {
          clientWs.send(JSON.stringify({ type: 'error', message: String(error) }));
        } catch (e) {}
      },
      onclose: (event) => {
        console.log(`🔌 Gemini Live Session geschlossen (${agentType})`);
        try {
          clientWs.send(JSON.stringify({ type: 'status', status: 'disconnected' }));
        } catch (e) {}
      },
    },
  });

  return session;
}

// ==================== NACHRICHTEN-VERARBEITUNG ====================

async function handleGeminiMessage(clientWs, message, session, userProfile, agentType) {
  const serverContent = message.serverContent;

  if (serverContent?.modelTurn?.parts) {
    clientWs._geminiIsSpeaking = true;
    for (const part of serverContent.modelTurn.parts) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) {
        clientWs.send(JSON.stringify({
          type: 'audio',
          data: part.inlineData.data,
          sampleRate: SAMPLE_RATE_OUT,
        }));
      }
    }
  }

  if (serverContent?.inputTranscription?.text) {
    const userText = serverContent.inputTranscription.text;
    clientWs._lastUserSpeechTime = Date.now();
    console.log('🎤 Nutzer:', userText);
    clientWs.send(JSON.stringify({
      type: 'transcript', role: 'user', text: userText,
    }));

    let targetAgent = agentType;
    let targetRole = clientWs._currentRole || 'freund';
    let toggledDolmetscher = null;

    if (agentType === 'jony' && PATTERNS.dolmetscher.test(userText)) {
      const currentlyOn = clientWs._dolmetscherActive || false;
      const isOff = /\b(aus|beenden|stop|off|хватит|стоп|выключи)\b/i.test(userText);

      if (currentlyOn && isOff) {
        clientWs._dolmetscherActive = false;
        toggledDolmetscher = false;
      } else if (!currentlyOn && !isOff) {
        clientWs._dolmetscherActive = true;
        toggledDolmetscher = true;
      }

      if (toggledDolmetscher !== null) {
        clientWs.send(JSON.stringify({ type: 'dolmetscher', active: toggledDolmetscher }));
        try {
          session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: dolmetscherInstruction(toggledDolmetscher) }] }],
            turnComplete: true,
          });
        } catch (e) {}
        return;
      }
    }

    if (agentType === 'business') {
      if (PATTERNS.party.test(userText)) { targetAgent = 'jony'; targetRole = 'party'; }
      else if (PATTERNS.berater.test(userText)) { targetAgent = 'jony'; targetRole = 'berater'; }
      else if (PATTERNS.kids.test(userText)) { targetAgent = 'jony'; targetRole = 'kids'; }
      else if (PATTERNS.backToJony.test(userText)) { targetAgent = 'jony'; targetRole = 'freund'; }
    } else {
      if (PATTERNS.business.test(userText)) {
        targetAgent = 'business';
      } else {
        if (PATTERNS.party.test(userText)) targetRole = 'party';
        else if (PATTERNS.berater.test(userText)) targetRole = 'berater';
        else if (PATTERNS.kids.test(userText)) targetRole = 'kids';
        else if (PATTERNS.backToJony.test(userText)) targetRole = 'freund';
      }
    }

    if (targetAgent !== agentType) {
      console.log(`🔄 Agent-Wechsel: ${agentType} → ${targetAgent}`);
      try { await clientWs._session?.close(); } catch (e) {}
      await new Promise(r => setTimeout(r, 300));
      clientWs._currentRole = targetRole;
      const newSession = await createGeminiSession(clientWs, userProfile, targetAgent);
      clientWs._session = newSession;
      clientWs._currentAgent = targetAgent;
      clientWs.send(JSON.stringify({ type: 'agent', agent: targetAgent }));
      return;
    }

    if (agentType === 'jony' && targetRole !== clientWs._currentRole) {
      clientWs._currentRole = targetRole;
      console.log(`🎭 Rollenwechsel: → ${targetRole}`);
      clientWs.send(JSON.stringify({ type: 'role', role: targetRole }));
      try {
        session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: roleSwitchInstruction(targetRole) }] }],
          turnComplete: true,
        });
      } catch (e) {}
    }

    if (agentType === 'jony' && userProfile.user_id) {
      const current = clientWs._lastMode || 'normal';
      const mode = await detectMode(
        userProfile.user_id,
        clientWs._lastImuState || 'unknown',
        clientWs._lastLat,
        clientWs._lastLon,
        userText,
        current
      );

      if (mode !== current) {
        clientWs._lastMode = mode;
        clientWs.send(JSON.stringify({ type: 'mode', mode }));
        try {
          session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: modeInstruction(mode) }] }],
            turnComplete: true,
          });
        } catch (e) {}
      }
    }
  }

  if (serverContent?.outputTranscription?.text) {
    console.log(`🤖 ${agentType === 'business' ? 'Business' : 'Jony'}:`, serverContent.outputTranscription.text);
    clientWs.send(JSON.stringify({
      type: 'transcript', role: 'assistant',
      text: serverContent.outputTranscription.text,
    }));
  }

  if (message.toolCall) {
    handleToolCall(clientWs, session, userProfile, message.toolCall, agentType);
  }

  if (serverContent?.turnComplete) {
    clientWs._geminiIsSpeaking = false;
    clientWs._lastUserSpeechTime = Date.now();
    clientWs.send(JSON.stringify({ type: 'turn_complete' }));
  }
}

// ==================== TOOLS ====================

function buildJonyTools() {
  return [
    {
      functionDeclarations: [
        {
          name: 'get_weather',
          description: 'Ruft das aktuelle Wetter ab.',
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
          description: 'Findet Restaurants in der Nähe.',
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
          description: 'Speichert eine persönliche Info über den Nutzer.',
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
          description: 'Lädt alle gespeicherten Infos über den Nutzer.',
          parameters: { type: 'OBJECT', properties: {} },
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
          description: 'Zeigt E-Mail-Entwurf als Karte (NUR für normale E-Mails, NICHT für Karussells). ' +
                       '⛔ Lies ihn NICHT laut vor.',
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
      ],
    },
  ];
}

function buildBusinessTools() {
  return [
    {
      functionDeclarations: [
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
          name: 'get_weather',
          description: 'Ruft das aktuelle Wetter ab.',
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
          description: 'Findet Restaurants in der Nähe.',
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
          name: 'send_telegram_message',
          description: 'Sendet eine Telegram-Nachricht (Text). Frage IMMER zuerst.',
          parameters: {
            type: 'OBJECT',
            properties: {
              chat_id: { type: 'STRING' },
              text: { type: 'STRING' },
            },
            required: ['chat_id', 'text'],
          },
        },
        {
          name: 'show_draft',
          description: 'Zeigt E-Mail-Entwurf als Karte (NUR für normale E-Mails, NICHT für Karussells). ' +
                       '⛔ Lies ihn NICHT laut vor.',
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
      ],
    },
  ];
}

async function handleToolCall(clientWs, session, userProfile, toolCall, agentType) {
  const functionCalls = toolCall.functionCalls;
  const responses = [];

  for (const fc of functionCalls) {
    console.log('🔧 Tool Call:', fc.name, JSON.stringify(fc.args));
    let result = { status: 'ok' };

    try {
      if (fc.name === 'get_weather') {
        let loc = fc.args.location;
        if (isHereKeyword(loc)) {
          loc = userProfile.current_city || userProfile.hometown || loc;
        }
        result = await fetchWeather(loc, fc.args.timeframe);
      } else if (fc.name === 'find_restaurants') {
        let loc = fc.args.location;
        if (isHereKeyword(loc)) {
          loc = userProfile.current_city || userProfile.hometown || loc;
        }
        result = await fetchRestaurants(loc, fc.args.cuisine);
      } else if (fc.name === 'save_user_preference') {
        result = await saveUserPreference(userProfile.user_id, fc.args.key, fc.args.value);
      } else if (fc.name === 'get_user_preferences') {
        result = await getUserPreferences(userProfile.user_id);
      } else if (fc.name === 'send_telegram_message') {
        result = await handleSendTelegram(fc.args.chat_id, fc.args.text);
      } else if (fc.name === 'find_contact') {
        result = await handleFindContact(userProfile.user_id, fc.args.name);
      } else if (fc.name === 'save_contact') {
        const { name: cname, ...fields } = fc.args;
        result = await handleSaveContact(userProfile.user_id, cname, fields);
      } else if (fc.name === 'forget_contact') {
        result = await handleForgetContact(userProfile.user_id, fc.args.name);
      } else if (fc.name === 'list_contacts') {
        result = await handleListContacts(userProfile.user_id);
      } else if (fc.name === 'find_group') {
        result = await handleFindGroup(userProfile.user_id, fc.args.name);
      } else if (fc.name === 'save_group') {
        result = await handleSaveGroup(userProfile.user_id, fc.args.name, fc.args.members, fc.args.notes);
      } else if (fc.name === 'forget_group') {
        result = await handleForgetGroup(userProfile.user_id, fc.args.name);
      } else if (fc.name === 'list_groups') {
        result = await handleListGroups(userProfile.user_id);
      } else if (fc.name === 'resolve_recipients') {
        result = await handleResolveRecipients(userProfile.user_id, fc.args.names);
      } else if (fc.name === 'save_user_profile') {
        result = await handleSaveUserProfile(userProfile.user_id, fc.args);
      } else if (fc.name === 'show_draft') {
        result = await handleShowDraft(userProfile.user_id, fc.args.to, fc.args.subject, fc.args.body, fc.args.tone);
      } else if (fc.name === 'send_email') {
        result = await handleSendEmail(fc.args.to, fc.args.subject, fc.args.body, userProfile, fc.args.tone || 'persönlich');
      } else if (fc.name === 'generate_script') {
        result = await generateScriptAndSend(
          clientWs,
          userProfile.user_id,
          fc.args.topic,
          fc.args.audience,
          fc.args.focus,
          fc.args.slide_count
        );
      } else if (fc.name === 'generate_image') {
        result = await generateImageAndSend(
          clientWs,
          userProfile.user_id,
          fc.args.prompt,
          fc.args.slide_number
        );
      } else if (fc.name === 'send_carousel_email') {
        result = await handleSendCarouselEmail(userProfile.user_id, fc.args.to, userProfile);
      } else if (fc.name === 'send_carousel_telegram') {
        result = await handleSendCarouselTelegram(userProfile.user_id, fc.args.chat_id);
      }
    } catch (e) {
      console.error('❌ Tool-Fehler:', e);
      result = { error: String(e.message || e) };
    }

    responses.push({ id: fc.id, name: fc.name, response: result });
  }

  if (session) {
    try {
      session.sendToolResponse({ functionResponses: responses });
      console.log('📤 Tool-Results gesendet:', responses.length);
    } catch (e) {
      console.error('❌ sendToolResponse Fehler:', e);
    }
  }
}

// ==================== HANDLER ====================

async function handleSendTelegram(chatId, text) {
  try {
    const res = await sendTelegramMessage(chatId, text);
    return { success: true, to: res.to, message: 'Nachricht gesendet.' };
  } catch (e) {
    return { error: e.message };
  }
}

async function handleShowDraft(userId, to, subject, body, tone) {
  try {
    await fetch(SELF_URL + '/api/draft/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        to, subject, body, tone,
      }),
    }).catch(() => null);

    console.log(`📝 Voice-Draft angezeigt: an ${to} (${tone})`);

    return {
      success: true,
      message: 'Entwurf wird in der App angezeigt. Warte auf Reaktion des Nutzers.',
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function handleSendEmail(to, subject, body, profile = {}, tone = 'persönlich') {
  try {
    const res = await fetch(SELF_URL + '/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, body, profile, tone }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Server-Fehler: ${res.status} ${errText.substring(0, 100)}`);
    }
    return { success: true, message: `E-Mail an ${to} gesendet.` };
  } catch (e) {
    return { error: e.message };
  }
}

async function handleSendCarouselEmail(userId, to, profile = {}) {
  try {
    const carousel = getCarousel(userId);
    if (!carousel) {
      return { error: 'Kein Karussell gefunden. Erst eins erstellen.' };
    }
    const res = await sendCarouselByEmail(to, carousel, profile);
    return {
      success: true,
      message: `Karussell "${res.topic}" mit ${res.imageCount} Bildern an ${to} gesendet.`,
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function handleSendCarouselTelegram(userId, chatId) {
  try {
    const carousel = getCarousel(userId);
    if (!carousel) {
      return { error: 'Kein Karussell gefunden. Erst eins erstellen.' };
    }

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
      return { error: `Telegram-Karussell fehlgeschlagen: ${res.status}` };
    }

    const data = await res.json();
    return {
      success: true,
      message: `Karussell "${carousel.topic}" mit ${data.imagesSent} Bildern auf Telegram gesendet.`,
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function handleFindContact(userId, name) {
  try {
    const res = await fetch(SELF_URL + '/api/contacts/find', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, name }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function handleSaveContact(userId, name, fields) {
  try {
    const res = await fetch(SELF_URL + '/api/contacts/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, name, ...fields }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function handleForgetContact(userId, name) {
  try {
    const res = await fetch(SELF_URL + '/api/contacts/forget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, name }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function handleListContacts(userId) {
  try {
    const res = await fetch(SELF_URL + '/api/contacts/list/' + userId);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function handleFindGroup(userId, name) {
  try {
    const res = await fetch(SELF_URL + '/api/groups/find', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, name }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function handleSaveGroup(userId, name, members, notes) {
  try {
    const res = await fetch(SELF_URL + '/api/groups/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, name, members, notes }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function handleForgetGroup(userId, name) {
  try {
    const res = await fetch(SELF_URL + '/api/groups/forget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, name }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function handleListGroups(userId) {
  try {
    const res = await fetch(SELF_URL + '/api/groups/list/' + userId);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function handleResolveRecipients(userId, names) {
  try {
    const res = await fetch(SELF_URL + '/api/contacts/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, names }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function handleSaveUserProfile(userId, fields) {
  try {
    const res = await fetch(SELF_URL + '/api/user-profile/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, ...fields }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
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
    feels_like: data.current?.feels_like,
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

async function saveUserPreference(userId, key, value) {
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
  if (!res.ok) throw new Error('Speicher-Fehler: ' + res.status);
  return { success: true, key, value: valueStr };
}

async function getUserPreferences(userId) {
  if (!userId) return { error: 'no user_id' };
  const res = await fetch(SELF_URL + '/api/profile/' + userId);
  if (!res.ok) throw new Error('Lade-Fehler: ' + res.status);
  const data = await res.json();
  return { preferences: data.data || {} };
}

// ==================== SCRIPT GENERATION ====================

async function generateScriptAndSend(clientWs, userId, topic, audience, focus, slideCount) {
  console.log(`📝 Groq generiert Skript: "${topic}"`);
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
    '    {"slide": 1, "title": "Kurzer Hook-Titel (max 5 Wörter)", "body": "Text max 20 Wörter", "image_prompt": "DETAILED ENGLISH IMAGE PROMPT 35-50 Wörter"}',
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
      clientWs.send(JSON.stringify({ type: 'script', topic, slides }));

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

// ==================== IMAGE GENERATION ====================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function generateImageAndSend(clientWs, userId, prompt, slideNumber) {
  console.log(`🎨 Generiere Slide ${slideNumber}...`);

  const lastImgTime = clientWs._lastImageTime || 0;
  const timeSince = Date.now() - lastImgTime;
  const minGap = 2000;
  if (timeSince < minGap) await sleep(minGap - timeSince);
  clientWs._lastImageTime = Date.now();

  try {
    const englishPrompt = await translateToEnglishImagePrompt(prompt);
    let result = null;
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        result = await generateImageWithCloudflare(englishPrompt);
        break;
      } catch (e) {
        lastError = e;
        if (attempt < 3) await sleep(3000 * attempt);
      }
    }

    if (!result) throw lastError || new Error('Cloudflare fehlgeschlagen');

    if (userId) addImage(userId, slideNumber, result.imageBase64, result.mimeType);

    clientWs.send(JSON.stringify({
      type: 'image',
      slide: slideNumber,
      mimeType: result.mimeType,
      data: result.imageBase64,
    }));

    return { success: true, slide: slideNumber };
  } catch (e) {
    return { error: 'Bildgenerierung fehlgeschlagen: ' + e.message, slide: slideNumber };
  }
}

// ==================== WEBSOCKET-SERVER ====================

export function setupGeminiWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws/gemini-live' });

  wss.on('connection', async (clientWs, req) => {
    console.log('📱 App verbunden via WebSocket');
    activeClients.add(clientWs);

    let userProfile = {};

    clientWs._session = null;
    clientWs._currentAgent = 'jony';
    clientWs._currentRole = 'freund';
    clientWs._lastMode = 'normal';
    clientWs._lastImuState = 'unknown';
    clientWs._lastLat = null;
    clientWs._lastLon = null;
    clientWs._lastUserSpeechTime = Date.now();
    clientWs._geminiIsSpeaking = false;
    clientWs._proactiveTimer = null;
    clientWs._lastImageTime = 0;
    clientWs._dolmetscherActive = false;
    clientWs._uiMode = 'voice';
    clientWs._currentAttachments = [];

    clientWs.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'init') {
          userProfile = msg.profile || {};
          clientWs._uiMode = msg.uiMode || 'voice';
          console.log(`🎛️ Init-Modus: ${clientWs._uiMode}`);

          if (clientWs._uiMode === 'voice') {
            clientWs._session = await createGeminiSession(clientWs, userProfile, 'jony');
          } else {
            clientWs.send(JSON.stringify({ type: 'status', status: 'connected', agent: 'jony' }));
          }
          return;
        }

        if (msg.type === 'mode_switch') {
          const newMode = msg.mode || 'voice';
          const oldMode = clientWs._uiMode;
          clientWs._uiMode = newMode;

          if (oldMode === 'voice' && newMode === 'chat') {
            if (clientWs._session) {
              try { await clientWs._session.close(); } catch (e) {}
              clientWs._session = null;
            }
          }

          if (oldMode === 'chat' && newMode === 'voice') {
            if (!clientWs._session) {
              clientWs._session = await createGeminiSession(clientWs, userProfile, 'jony');
            }
          }
          return;
        }

        if (msg.type === 'context') {
          clientWs._lastImuState = msg.imu_state;
          clientWs._lastLat = msg.lat;
          clientWs._lastLon = msg.lon;

          if (userProfile.user_id) {
            await logPresence(userProfile.user_id, msg.imu_state, msg.lat, msg.lon);
          }

          if (msg.lat != null && msg.lon != null) {
            userProfile.current_lat = msg.lat;
            userProfile.current_lon = msg.lon;
            if (!userProfile.current_city) {
              userProfile.current_city = userProfile.hometown;
            }
          }
          return;
        }

        if (msg.type === 'attachment_added') {
          console.log(`📎 Anhang-Event von App: ${msg.filename || 'unbekannt'}`);

          const freshAttachments = await fetchUserAttachments(userProfile.user_id);
          clientWs._currentAttachments = freshAttachments;

          if (clientWs._session && freshAttachments.length > 0) {
            const names = freshAttachments.map(a => a.filename).join(', ');
            try {
              clientWs._session.sendClientContent({
                turns: [{
                  role: 'user',
                  parts: [{ text: '[SYSTEM] Anhänge bereit: ' + names + '.' }],
                }],
                turnComplete: true,
              });
            } catch (e) {}
          }

          clientWs.send(JSON.stringify({
            type: 'attachment_ack',
            count: freshAttachments.length,
            filenames: freshAttachments.map(a => a.filename),
          }));
          return;
        }

        if (msg.type === 'attachment_removed') {
          const freshAttachments = await fetchUserAttachments(userProfile.user_id);
          clientWs._currentAttachments = freshAttachments;
          return;
        }

        if (msg.type === 'draft_confirm') {
          console.log(`✅ Draft bestätigt von App`);
          if (clientWs._session) {
            try {
              clientWs._session.sendClientContent({
                turns: [{
                  role: 'user',
                  parts: [{ text: '[SYSTEM] Der Nutzer hat den Entwurf in der Karte bestätigt. Rufe jetzt send_email auf mit den gleichen Werten wie show_draft.' }],
                }],
                turnComplete: true,
              });
            } catch (e) {}
          }
          return;
        }

        if (msg.type === 'draft_cancel') {
          console.log(`❌ Draft abgebrochen von App`);
          if (clientWs._session) {
            try {
              clientWs._session.sendClientContent({
                turns: [{
                  role: 'user',
                  parts: [{ text: '[SYSTEM] Der Nutzer hat den Entwurf verworfen. Frage was stattdessen.' }],
                }],
                turnComplete: true,
              });
            } catch (e) {}
          }
          return;
        }

        if (msg.type === 'audio' && clientWs._session) {
          clientWs._session.sendRealtimeInput({
            audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' },
          });
        }

        if (msg.type === 'video' && clientWs._session) {
          try {
            clientWs._session.sendRealtimeInput({
              video: { data: msg.data, mimeType: 'image/jpeg' },
            });
          } catch (e) {}
        }

        if (msg.type === 'text' && clientWs._session) {
          clientWs._session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: msg.text }] }],
            turnComplete: true,
          });
        }
      } catch (error) {
        console.error('❌ WS-Nachricht Fehler:', error);
      }
    });

    clientWs._proactiveTimer = setInterval(async () => {
      if (!clientWs._session) return;
      if (clientWs._currentAgent !== 'jony') return;
      if (clientWs._geminiIsSpeaking) return;
      if (clientWs._lastMode === 'silent') return;
      if (clientWs._dolmetscherActive) return;
      if (clientWs._uiMode === 'chat') return;

      const role = clientWs._currentRole || 'freund';
      const interval = PROACTIVE_INTERVALS[role];
      if (!interval) return;

      const elapsed = Date.now() - (clientWs._lastUserSpeechTime || 0);
      if (elapsed < interval) return;

      const prompt = buildProactivePrompt(role);
      if (!prompt) return;

      try {
        clientWs._session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: prompt }] }],
          turnComplete: true,
        });
        clientWs._lastUserSpeechTime = Date.now();
      } catch (e) {}
    }, 5000);

    clientWs.on('close', async () => {
      console.log('📱 App getrennt');
      activeClients.delete(clientWs);
      if (clientWs._proactiveTimer) {
        clearInterval(clientWs._proactiveTimer);
        clientWs._proactiveTimer = null;
      }
      if (clientWs._session) {
        try { await clientWs._session.close(); } catch (e) {}
        clientWs._session = null;
      }
    });

    clientWs.on('error', (error) => {
      console.error('❌ WS-Fehler:', error);
      activeClients.delete(clientWs);
      if (clientWs._proactiveTimer) {
        clearInterval(clientWs._proactiveTimer);
        clientWs._proactiveTimer = null;
      }
      if (clientWs._session) clientWs._session.close();
    });
  });

  console.log('✅ Gemini WebSocket-Server bereit: /ws/gemini-live');
  return wss;
}

// ==================== TELEGRAM → APP FORWARDING ====================

onTelegramMessage((payload) => {
  console.log(`📨 Telegram: ${payload.fromName}: "${payload.text.substring(0, 60)}"`);
});