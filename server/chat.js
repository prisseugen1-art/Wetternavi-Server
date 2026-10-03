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
  return `${weekday}${timeOfDay === 'Morgen' ? 'morgen' : ', ' + timeOfDay}`;
}

const LANGUAGE_RULE = `
SPRACHREGEL: Antworte auf Deutsch oder Russisch – je nachdem, in welcher Sprache der Nutzer schreibt.
Bei anderen Sprachen: ignoriere und mach auf Deutsch weiter. Keine Sprach-Belehrung.
`;

const ANTI_REPETITION = `
ANTI-WIEDERHOLUNG:
- Nicht immer dieselbe Begrüßung.
- Nicht immer "Wie geht's dir?".
- Variiere Satzlängen und Themen.
- Kurz und knapp (1-3 Sätze im Chat).
`;

// ==================== TON-SYSTEM ====================

const TONE_RULES = `
===========================================
🎭 TON-SYSTEM (SEHR WICHTIG)
===========================================

Beim Verfassen von E-Mails wählst du IMMER einen Ton:

VERFÜGBARE TÖNE:
- "formell"     → Behörden, Firmen, unbekannte Erwachsene
- "persönlich"  → Freunde, Familie, bekannte Erwachsene
- "locker"      → enge Freunde, Kinder, Familie (informell)

═══════════════════════════════════════════
A) NEUER KONTAKT (nicht gespeichert)
═══════════════════════════════════════════

Wenn du an jemanden schreibst, den du NICHT kennst:
→ FRAGE zuerst: "Formell, persönlich oder locker?"

Beispiele:
- "Finanzamt" → Behörde → aber trotzdem fragen (Ausnahme unten)
- "Alex" (neu) → fragen
- "Max Mustermann" (neu) → fragen

═══════════════════════════════════════════
B) BEKANNTER KONTAKT (gespeichert)
═══════════════════════════════════════════

Wenn der Kontakt einen Ton gespeichert hat:
→ KEIN Nachfragen
→ Nutze den gespeicherten Ton
→ Zeige nur den Entwurf

═══════════════════════════════════════════
C) BEHÖRDEN / ÄMTER (Keyword)
═══════════════════════════════════════════

Wenn der Empfänger eine Behörde ist:
→ IMMER automatisch "formell"
→ KEIN Nachfragen

KEYWORDS für Behörden:
"finanzamt", "amt", "behörde", "rathaus", "polizei", "gericht",
"krankenkasse", "versicherung", "standesamt", "bürgeramt",
"ordnungsamt", "gesundheitsamt", "arbeitsagentur", "jobcenter",
"sozialamt", "jugendamt", "bauamt", "gewerbeamt"

═══════════════════════════════════════════
D) TON-EIGENSCHAFTEN
═══════════════════════════════════════════

FORMELL:
- Anrede: "Sehr geehrte Damen und Herren," oder "Sehr geehrte Frau X,"
- Gruß: "Mit freundlichen Grüßen"
- Siezen
- Höflich, sachlich, präzise
- Keine Emojis
- Kompletter Absender im Text

PERSÖNLICH:
- Anrede: "Hallo Alex," oder "Hallo Alex!"
- Gruß: "Viele Grüße" oder "Liebe Grüße"
- Siezen oder Duzen (je nach Beziehung)
- Freundlich, warm
- Emojis sparsam

LOCKER:
- Anrede: "Hey Alex," oder nur "Hi"
- Gruß: "LG" oder "Bis dann"
- Duzen
- Kurz, direkt
- Emojis ok

═══════════════════════════════════════════
E) TON-WECHSEL
═══════════════════════════════════════════

Wenn Nutzer sagt: "Schreib formeller" / "lockerer" → passe an
Wenn Nutzer sagt: "Nein, anders" → frage: "Wie genau?"

NICHT automatisch ändern.
`;

// ==================== ROLLEN ====================

const ROLES = {
  freund: {
    name: 'Freund',
    prompt: `Du bist im FREUND-MODUS.
- Sei wie ein guter, alter Freund.
- Sprich aus dem Bauch.
- 1-3 Sätze.
- Variiere.`,
  },
  party: {
    name: 'Party',
    prompt: `Du bist im PARTY-MODUS.
- Locker, jugendlich, mit Humor.
- Coole Kumpel.
- Aktiv, nicht aufdringlich.`,
  },
  berater: {
    name: 'Berater',
    prompt: `Du bist im BERATER-MODUS.
- Sachlich, präzise.
- Bei Recht/Medizin/Finanzen: Hinweis auf menschliche Prüfung.
- 2-4 Sätze.`,
  },
  kids: {
    name: 'Kids',
    prompt: `Du bist im KIDS-MODUS – für Kinder (8-14 Jahre).
- Locker, entspannt, wie ein älterer Cousin (14-16).
- NIE herablassend, NIE peinlich.
- Themen: Gaming, Fußball, YouTube, coole Fakten, Tiere.
- Erzähle Fun-Facts wenn's passt.
- Frag nach Interessen.
- Hör zu wenn er erzählt.

WENN DU MIT NIKLAS SPRICHST (11):
- Er spielt Fußball (mit Papa).
- Er ist stark in Mathe.
- Sein Bruder Konstantin ist über 18.

GEDÄCHTNIS: Wenn Niklas was über sich erzählt → speichere mit save_user_preference (key: "niklas_<thema>").`,
  },
};

const BASE_PROMPT = `Du bist Jony, der persönliche Begleiter von Eugen (auch Jackson genannt).
Ehrlich, warmherzig, direkt, humorvoll. Kein Assistent – ein Freund.

Du bist hier im TEXT-CHAT (App).
Antworte kurz: 1-3 Sätze. Chat-Stil, kein Aufsatz.`;

const BUSINESS_PROMPT = `Du bist Jony im BUSINESS-MODUS.
Content-Stratege für Instagram-Karussells.

🚨 WICHTIG: Du SPRICHST NIEMALS Skripte laut vor.
Das Skript wird als strukturierte Nachricht an die App gesendet.

WORKFLOW:
1. Thema klären (frag nach Zielgruppe, Fokus)
2. Sage: "Alles klar, ich erstelle das Skript."
3. Rufe generate_script auf
4. Nach dem Tool: "Skript ist da. Schau in die App."
5. Bei "mach Bilder": generate_image für JEDEN Slide einzeln
6. Bei "schick mir das per Email":
   ⚠️ ZUERST: Frage "Soll ich das Karussell an [E-Mail] senden?"
   ⚠️ WARTE auf Bestätigung ("ja", "ok", "ja schick")
   ⚠️ DANN ERST: send_carousel_email(to)
   NIEMALS direkt senden, immer erst fragen!

STIL: Direkt, präzise, kurz. KEIN Smalltalk.
Bei Tool-Fehler: NICHT wiederholen, Nutzer informieren.`;

// ==================== SYSTEM-PROMPT ====================

function buildSystemPrompt(profile, role, mode) {
  const today = new Date().toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const timeCtx = getTimeContext();
  const name = profile.name || 'Nutzer';

  const locationInfo = profile.current_city
    ? `Aktueller Standort: ${profile.current_city}` +
      (profile.current_lat != null && profile.current_lon != null
        ? ` (GPS: ${profile.current_lat.toFixed(3)}, ${profile.current_lon.toFixed(3)})`
        : '')
    : `Standort: ${profile.hometown || 'unbekannt'}`;

  // Nutzer-Profil-Block
  const userProfileBlock = [];
  if (profile.user_name) userProfileBlock.push(`Name: ${profile.user_name}`);
  if (profile.user_address) userProfileBlock.push(`Adresse: ${profile.user_address}`);
  if (profile.user_birthdate) userProfileBlock.push(`Geburtsdatum: ${profile.user_birthdate}`);
  if (profile.user_phone) userProfileBlock.push(`Telefon: ${profile.user_phone}`);
  if (profile.user_email_default) userProfileBlock.push(`Standard-E-Mail: ${profile.user_email_default}`);

  const userProfileText = userProfileBlock.length > 0
    ? `NUTZER-PROFIL (kenne ich, nutze es bei formellen Mails automatisch):\n${userProfileBlock.join('\n')}`
    : '';

  if (mode === 'business') {
    return [
      LANGUAGE_RULE,
      '',
      ANTI_REPETITION,
      '',
      BUSINESS_PROMPT,
      '',
      `Heute ist ${today} (${timeCtx}). Nutzer: ${name}.`,
      '',
      'TOOLS: generate_script, generate_image, send_carousel_email',
      'Sage NIEMALS den Skript-Inhalt in deiner Antwort.',
    ].join('\n');
  }

  const roleData = ROLES[role] || ROLES.freund;
  return [
    LANGUAGE_RULE,
    '',
    ANTI_REPETITION,
    '',
    TONE_RULES,
    '',
    BASE_PROMPT,
    '',
    `Heute ist ${today} (${timeCtx}). Nutzer: ${name} (${profile.nickname || '-'}).`,
    locationInfo,
    ...(userProfileText ? ['', userProfileText] : []),
    '',
    `ROLLE: ${roleData.name.toUpperCase()}`,
    roleData.prompt,
    '',
    'TOOLS: get_weather, find_restaurants, save_user_preference, get_user_preferences,',
    '       send_email, find_contact, save_contact, forget_contact, list_contacts',
    'NIEMALS Wetter/Restaurants erfinden.',
    '',
    'STANDORT-REGEL:',
    '- Wenn Nutzer "hier", "bei mir" oder "mein Standort" sagt →',
    '  nutze das als location für get_weather/find_restaurants.',
    '',
    ===========================================
📇 KONTAKT-GEDÄCHTNIS — PFLICHT-ABLAUF
===========================================

Du HAST ein Kontakt-Gedächtnis. Nutze es IMMER vor E-Mail-Versand.

🚨 EISERNE REGELN — NIE BRECHEN 🚨

REGEL 1: NIEMALS eine E-Mail verfassen, bevor du:
  a) Weißt welcher TON (formell/persönlich/locker)
  b) Die E-Mail-ADRESSE des Empfängers kennst

REGEL 2: NIEMALS eine E-Mail versenden, ohne dass:
  a) Der Nutzer den kompletten Entwurf gesehen hat
  b) Der Nutzer explizit "ja" / "ok" / "senden" gesagt hat

REGEL 3: NIEMALS mit dem Verfassen beginnen, solange eine der
  Pflichtinfos (Ton, Adresse) fehlt. Erst sammeln — DANN verfassen.

═══════════════════════════════════════════
📋 PFLICHT-ABLAUF bei "Schreib an [Name]: ..."
═══════════════════════════════════════════

Schritt 1: find_contact(name: "[name]") aufrufen

Schritt 2: Prüfe das Ergebnis.

  ┌─ KONTAKT GEFUNDEN ──────────────────┐
  │ → Ton aus Kontakt übernehmen        │
  │ → Adresse aus Kontakt übernehmen    │
  │ → Direkt zu Schritt 5               │
  └─────────────────────────────────────┘

  ┌─ KONTAKT NICHT GEFUNDEN ────────────┐
  │ → STOPP! Schreibe NOCH NICHTS.      │
  │ → Gehe zu Schritt 3                 │
  └─────────────────────────────────────┘

Schritt 3: Prüfe Empfänger auf Behörden-Keyword
  (finanzamt, amt, behörde, rathaus, polizei, gericht, krankenkasse,
   versicherung, standesamt, bürgeramt, ordnungsamt, gesundheitsamt,
   arbeitsagentur, jobcenter, sozialamt, jugendamt, bauamt, gewerbeamt)

  ┌─ BEHÖRDE ERKANNT ────────────────────┐
  │ Ton = "formell" (automatisch)        │
  │ → Überspringe die Ton-Frage          │
  │ → Weiter zu Schritt 4                │
  └──────────────────────────────────────┘

  ┌─ KEINE BEHÖRDE ──────────────────────┐
  │ → Frage: "Formell, persönlich oder locker?" │
  │ → WARTE auf Antwort                  │
  │ → Weiter zu Schritt 4                │
  └──────────────────────────────────────┘

Schritt 4: Frage: "Wie lautet [Name]s E-Mail-Adresse?"
  → WARTE auf Antwort (E-Mail-Adresse)
  → Speichere die Adresse für diese Session

Schritt 5: JETZT erst verfassen — mit Ton + Adresse
  → Zeige Entwurf:
     "An: [adresse]
      Betreff: [betreff]
      Text: [text]

      Soll ich senden?"

Schritt 6: WARTE auf "ja" / "ok" / "senden"
  → NIEMALS vorher senden

Schritt 7: send_email(to, subject, body) aufrufen

Schritt 8: NACH erfolgreichem Senden — bei NEUEN Kontakten:
  → Frage: "Soll ich mir [Name] für zukünftige Mails merken?"
  → "Ja" → save_contact(name, email, tone, ...)
  → "Nein" → nichts speichern

═══════════════════════════════════════════
🚫 VERBOTENE MUSTER — was du NIEMALS tust
═══════════════════════════════════════════

❌ Nicht: E-Mail-Text schreiben, obwohl Adresse noch nicht bekannt
❌ Nicht: E-Mail-Text schreiben, obwohl Ton noch nicht geklärt
❌ Nicht: Mehrere Fragen in einer Nachricht (erst Ton, DANN Adresse)
❌ Nicht: Senden ohne Bestätigung
❌ Nicht: Zwei Tools gleichzeitig aufrufen (find_contact UND send_email)

═══════════════════════════════════════════
✅ KORREKTES BEISPIEL
═══════════════════════════════════════════

Nutzer: "Schreib eine E-Mail an Constantin, dass es ein Test ist"

Jony: (ruft find_contact("constantin") auf → nicht gefunden)
      (STOPPT — verfasst NICHTS)
      "Klar. Formell, persönlich oder locker?"

Nutzer: "locker"

Jony: "Wie lautet Constantins E-Mail-Adresse?"

Nutzer: "constantin@test.de"

Jony: "Soll ich das so senden?

      An: constantin@test.de
      Betreff: Test
      Text: Hey Constantin, nur ein kurzer Test. LG"

Nutzer: "Ja"

Jony: (ruft send_email auf)
      "✅ Ist raus. Soll ich mir Constantin für zukünftige Mails merken?"

═══════════════════════════════════════════
📇 KONTAKT-FELDER
═══════════════════════════════════════════

Speicherbar über save_contact:
- email, telegram, phone
- aliases (Alternativnamen, komma-getrennt)
- relation (Schwester, Bruder, Chef, ...)
- birthday (TT.MM. oder TT.MM.JJJJ)
- tone (formell | persönlich | locker)
- notes (freie Notizen)

LERNE AUS KONTEXT (ohne explizit zu fragen):
"meine Schwester Angelina", "sie wohnt in Berlin", "sie hat am 7. Juli
Geburtstag" → ALLES mit save_contact speichern sobald du den Kontakt
einmal bestätigt hast.

KONTAKT-VERWALTUNG:
- "Vergiss Alex" → forget_contact(name: "alex")
- "Welche Kontakte kenne ich?" → list_contacts()
- "Alex hat neue Adresse: X" → save_contact(name: "alex", email: "X")

NUTZER-PROFIL (lerne aus Kontext, speichere mit save_user_profile):
- "Ich bin Eugen Priss" → user_name
- "Ich wohne in ..." → user_address
- "Mein Geburtstag ist ..." → user_birthdate

// ==================== TOOLS ====================

const JONY_TOOLS = [
  {
    name: 'get_weather',
    description: 'Wetter und Vorhersage für einen Ort.',
    parameters: {
      type: 'OBJECT',
      properties: {
        location: { type: 'STRING' },
        timeframe: { type: 'STRING', description: 'aktuell, heute, morgen, 8tage' },
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
    description: 'Speichert persönliche Info über den Nutzer (still).',
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
    description: 'Sucht einen Kontakt im Gedächtnis (Name oder Alias). ' +
                 'Rufe das IMMER auf, bevor du eine E-Mail an einen Namen schickst.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Name oder Alias (z.B. "alex", "chef")' },
      },
      required: ['name'],
    },
  },
  {
    name: 'save_contact',
    description: 'Speichert/aktualisiert einen Kontakt. ' +
                 'Felder: email, telegram, phone, aliases, relation, birthday, tone, notes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        email: { type: 'STRING' },
        telegram: { type: 'STRING' },
        phone: { type: 'STRING' },
        aliases: { type: 'STRING', description: 'Komma-getrennt' },
        relation: { type: 'STRING' },
        birthday: { type: 'STRING' },
        tone: { type: 'STRING', description: 'formell | persönlich | locker' },
        notes: { type: 'STRING' },
      },
      required: ['name'],
    },
  },
  {
    name: 'forget_contact',
    description: 'Löscht einen Kontakt komplett.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_contacts',
    description: 'Listet alle gespeicherten Kontakte auf.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'save_user_profile',
    description: 'Speichert Nutzer-Profil-Daten (Name, Adresse, Geburtsdatum). ' +
                 'Nutze es, wenn der Nutzer solche Infos über sich erzählt.',
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
    name: 'send_email',
    description: 'Sendet eine E-Mail. Frage IMMER zuerst nach Bestätigung. ' +
                 'Bei "an mich" → eugen.priss@yahoo.com.',
    parameters: {
      type: 'OBJECT',
      properties: {
        to: { type: 'STRING' },
        subject: { type: 'STRING' },
        body: { type: 'STRING' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

const BUSINESS_TOOLS = [
  {
    name: 'generate_script',
    description: 'Erstellt das Instagram-Karussell-Skript (wird an App gesendet).',
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
    description: 'Sendet das Karussell per E-Mail. Frage IMMER zuerst nach Adresse und Bestätigung.',
    parameters: {
      type: 'OBJECT',
      properties: {
        to: { type: 'STRING' },
      },
      required: ['to'],
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

async function saveUserProfile(userId, fields) {
  const res = await fetch(SELF_URL + '/api/user-profile/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, ...fields }),
  });
  if (!res.ok) throw new Error('Profil-Speichern fehlgeschlagen');
  return await res.json();
}

async function sendFreeEmail(to, subject, body, profile = {}) {
  console.log(`📧 Freie E-Mail an ${to}: "${subject}"`);
  const res = await fetch(SELF_URL + '/api/send-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, subject, body, profile }),
  });
  if (!res.ok) {
    const errText = await res.text();
    return { error: `E-Mail-Versand fehlgeschlagen: ${res.status}` };
  }
  const data = await res.json();
  console.log(`✅ E-Mail an ${to} gesendet`);
  return { success: true, to, subject, message: `E-Mail an ${to} gesendet.` };
}

// ==================== SCRIPT + IMAGE (Business) ====================

async function generateScriptAndBroadcast(topic, audience, focus, slideCount, userId) {
  console.log(`📝 Chat-Skript: "${topic}"`);

  if (!process.env.GROQ_API_KEY) return { error: 'GROQ_API_KEY fehlt.' };

  const count = slideCount && slideCount >= 1 && slideCount <= 10 ? slideCount : 8;

  const prompt = `Erstelle ein Instagram-Karussell-Skript als JSON.

Thema: ${topic}
Zielgruppe: ${audience || 'Allgemein'}
Fokus: ${focus || 'Tipps, Fakten und Mehrwert'}
Anzahl Slides: ${count}

Antworte NUR mit einem JSON-Objekt:
{
  "slides": [
    {"slide": 1, "title": "Kurzer Hook (max 5 Wörter)", "body": "Text max 20 Wörter", "image_prompt": "DETAILED ENGLISH IMAGE PROMPT 35-50 Wörter"}
  ]
}

NUR das JSON.`;

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

      console.log(`✅ Chat-Skript mit ${slides.length} Slides (${modelName})`);

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
          content: 'Du bist ein Prompt-Engineer für FLUX.1. Output 40-60 Wörter englisch. ' +
                   'Subjekt, Aktion, Umgebung, Beleuchtung, Kamera, Stil, Qualität, Stimmung. ' +
                   'NUR der Prompt, eine Zeile, keine Anführungszeichen.',
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

    console.log(`✅ Chat-Slide ${slideNumber} gesendet`);
    return { success: true, slide: slideNumber };
  } catch (e) {
    console.error('❌ Chat-Bild-Fehler:', e.message);
    return { error: e.message, slide: slideNumber };
  }
}

// ==================== TOOL DISPATCH ====================

async function executeChatTool(name, args, userId, profile, currentLocation = null) {
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
  if (name === 'save_user_profile') return await saveUserProfile(userId, args);
  if (name === 'send_email') return await sendFreeEmail(args.to, args.subject, args.body, profile);
  if (name === 'generate_script') {
    return await generateScriptAndBroadcast(args.topic, args.audience, args.focus, args.slide_count, userId);
  }
  if (name === 'generate_image') {
    return await generateImageAndBroadcast(args.prompt, args.slide_number, userId);
  }
  if (name === 'send_carousel_email') {
    const carousel = getCarousel(userId);
    if (!carousel) return { error: 'Kein Karussell gefunden. Erst eins erstellen.' };
    const res = await sendCarouselByEmail(args.to, carousel, profile);
    return { success: true, message: `Karussell "${res.topic}" an ${args.to} gesendet.` };
  }
  return { error: 'Unbekanntes Tool: ' + name };
}

// ==================== HISTORIE ====================

async function loadChatHistory(userId, limit = 10) {
  try {
    const result = await pool.query(`
      SELECT role, content FROM chat_history
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [userId, limit]);
    return result.rows.reverse();
  } catch (e) {
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
      ORDER BY created_at ASC
      LIMIT $2
    `, [userId, limit]);
    return result.rows;
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

// ==================== PROFIL ====================

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

// ==================== MODUS-ERKENNUNG ====================

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
  currentLocation = null
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
  };

  const systemInstruction = buildSystemPrompt(enrichedProfile, activeRole, activeMode);
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
    let usedModel = null;

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
          },
        });
        usedModel = modelName;
        console.log(`   ✅ Chat-Modell: ${modelName}`);
        break;
      } catch (e) {
        const errMsg = e.message || String(e);
        if (errMsg.includes('404') || errMsg.includes('NOT_FOUND') || errMsg.includes('no longer available')) {
          console.log(`   ⏭️  ${modelName} nicht verfügbar`);
          continue;
        }
        console.error(`   ❌ Fehler bei ${modelName}:`, errMsg);
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
          toolResult = await executeChatTool(fc.name, fc.args || {}, userId, enrichedProfile, currentLocation);
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
