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

// ==================== TON-SYSTEM ====================

const TONE_RULES = [
  '===========================================',
  '🎭 TON-SYSTEM',
  '===========================================',
  '',
  'Beim Verfassen von E-Mails wählst du IMMER einen Ton:',
  '',
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
].join('\n');

// ==================== SPRACHREGEL ====================

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

// ==================== ANTI-WIEDERHOLUNG ====================

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

// ==================== ROLLEN ====================

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

// ==================== JONY PROMPT ====================

const JONY_BASE = [
  'Du bist Jony, der persönliche Begleiter von Eugen (auch Jackson genannt).',
  'Ehrlich, warmherzig, direkt, humorvoll. Kein Assistent – ein Freund.',
].join('\n');

// ==================== KONTAKT + GRUPPEN ====================

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
  'REGEL 3: NIEMALS mit dem Verfassen beginnen, solange eine der',
  '  Pflichtinfos (Ton, Adresse) fehlt. Erst sammeln — DANN verfassen.',
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
  '  ⛔ Lies den Entwurf NICHT laut vor!',
  '  Die App zeigt die Entwurf-Karte.',
  '  Sage dem Nutzer nur KURZ: "Entwurf ist da. Schau auf den Bildschirm."',
  '',
  'Schritt 6: WARTE auf "ja" / "ok" / "senden"',
  '',
  'Schritt 7: send_email(to, subject, body, tone)',
  '  ⛔ Du schreibst KEINE Signatur — der Server hängt sie an.',
  '  📎 Anhänge werden AUTOMATISCH mitgeschickt — du rufst nichts extra auf.',
  '',
  'Schritt 8: Bei NEUEN Kontakten: "Soll ich mir [Name] merken?"',
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
].join('\n');

// ==================== SIGNATUR-REGEL ====================

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

// ==================== ANHANG-REGEL ====================

const ATTACHMENT_RULE = [
  '===========================================',
  '📎 ANHANG-REGEL',
  '===========================================',
  '',
  'Anhänge werden AUTOMATISCH mitgeschickt — du rufst KEIN Tool extra auf.',
  '',
  'WENN Anhänge bereit sind:',
  '- Der System-Prompt sagt es dir unter "📎 AKTUELLE ANHÄNGE:"',
  '- Erwähne sie im Entwurf NICHT explizit im body.',
  '- Die App zeigt sie in der Entwurf-Karte automatisch an.',
  '',
  'Der Nutzer kann JEDERZEIT einen Anhang hinzufügen:',
  '- Er klickt auf den 📎-Button in der Entwurf-Karte.',
  '- Oder sagt "Ich füge jetzt einen Anhang hinzu".',
  '- Du wirst darüber informiert mit einer System-Nachricht.',
].join('\n');

// ==================== ENTWURF-REGEL ====================

const DRAFT_RULE = [
  const DRAFT_RULE = [
  '===========================================',
  '📝 ENTWURF-REGEL (SEHR WICHTIG)',
  '===========================================',
  '',
  'Wenn Ton + Adresse geklärt sind, rufst du IMMER show_draft auf.',
  '',
  '⛔ LIES DEN ENTWURF NIEMALS LAUT VOR!',
  '⛔ WIEDERHOLE NICHT: An:, Betreff:, Text: in deiner Sprache.',
  '',
  'Die App zeigt die Entwurf-Karte automatisch mit 📎-Button.',
  'Du sagst dem Nutzer nur EINEN kurzen Satz wie:',
  '- "Entwurf ist da. Schau auf den Bildschirm."',
  '- "Hab einen Entwurf erstellt."',
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '⏸️ NACH show_draft: WARTE auf Reaktion',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  '✅ JA-WÖRTER → Rufe SOFORT send_email auf:',
  '- "ja" / "jep" / "jup" / "ok" / "okay"',
  '- "senden" / "schick" / "schick weg" / "schick ab"',
  '- "raus" / "raus damit" / "weg damit" / "los"',
  '- "passt" / "passt so" / "so lassen" / "ab damit"',
  '- "sende" / "sende ab" / "los geht\'s"',
  '- "yes" / "yep" / "jo" / "klar"',
  '',
  'WICHTIG:',
  '- "schick weg" = SENDEN (nicht warten!)',
  '- "raus damit" = SENDEN',
  '- "weg" (allein) = SENDEN',
  '',
  '❌ NEIN-WÖRTER → Verwirf den Entwurf (KEIN send_email):',
  '- "nein" / "no" / "nö"',
  '- "abbrechen" / "cancel" / "stop" / "stopp"',
  '- "vergiss es" / "vergiss das" / "lösch" / "lösche"',
  '- "verwerfen" / "verwerfe"',
  '- "anders" / "änder" / "ändern" / "nochmal" / "neu"',
  '- "gefällt mir nicht" / "passt nicht"',
  '',
  'WICHTIG:',
  '- "lösch das" = ABBRECHEN (nicht senden!)',
  '- "vergiss es" = ABBRECHEN',
  '- "schmeiß weg" = ABBRECHEN',
  '',
  '🖱️ APP-BUTTONS (automatisch, kein Sprachbefehl nötig):',
  '- Wenn App ✅ klickt → automatisch send_email',
  '- Wenn App ❌ klickt → automatisch verwerfen',
  '',
  '❓ UNKLAR → Kurze Rückfrage:',
  '- "Soll ich senden oder verwerfen?"',
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  'NACH DEM SENDEN:',
  '- Kurz bestätigen: "✅ Ist raus."',
  '',
  'NACH DEM VERWERFEN:',
  '- Kurz bestätigen: "Okay, verworfen."',
].join('\n');


function buildJonyPrompt(profile, role = 'freund', attachments = []) {
  const roleData = ROLES[role] || ROLES.freund;
  const today = new Date().toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const timeContext = getTimeContext();

  const name = profile.name || 'Nutzer';
  const nickname = profile.nickname ? ' (' + profile.nickname + ')' : '';

  let locationLine = null;
  if (profile.current_city) {
    locationLine = 'Aktueller Standort: ' + profile.current_city;
    if (profile.current_lat != null && profile.current_lon != null) {
      locationLine += ' (GPS: ' + profile.current_lat.toFixed(3) + ', ' + profile.current_lon.toFixed(3) + ')';
    }
  }

  const userProfileLines = [];
  if (profile.user_name) userProfileLines.push('Name: ' + profile.user_name);
  if (profile.user_address) userProfileLines.push('Adresse: ' + profile.user_address);
  if (profile.user_birthdate) userProfileLines.push('Geburtsdatum: ' + profile.user_birthdate);
  if (profile.user_phone) userProfileLines.push('Telefon: ' + profile.user_phone);
  if (profile.user_email_default) userProfileLines.push('Standard-E-Mail: ' + profile.user_email_default);

  const userProfileText = userProfileLines.length > 0
    ? 'NUTZER-PROFIL:\n' + userProfileLines.join('\n')
    : null;

  let attachmentNote = null;
  if (attachments && attachments.length > 0) {
    const lines = attachments.map(a =>
      '  - ' + a.filename + ' (' + Math.round(a.size / 1024) + ' KB)'
    );
    attachmentNote = '📎 AKTUELLE ANHÄNGE: ' + attachments.length + ' Datei(en) bereit:\n' + lines.join('\n');
  }

  const lines = [
    LANGUAGE_RULE,
    '',
    ANTI_REPETITION,
    '',
    TONE_RULES,
    '',
    JONY_BASE,
    '',
    'Heute ist ' + today + ' (' + timeContext + ').',
    'Der Nutzer heißt ' + name + nickname + '.',
    'Aber nutze seinen Namen NICHT in jeder Antwort. Nur manchmal.',
  ];

  if (locationLine) {
    lines.push('');
    lines.push(locationLine);
  }

  if (userProfileText) {
    lines.push('');
    lines.push(userProfileText);
  }

  lines.push(
    '',
    '===========================================',
    'AKTIVE ROLLE: ' + roleData.name.toUpperCase(),
    '===========================================',
    roleData.prompt,
    '',
    '===========================================',
    'STANDORT-REGEL',
    '===========================================',
    'Wenn der Nutzer "hier", "bei mir" oder "mein Standort" sagt →',
    'nutze das als location für get_weather / find_restaurants.',
    '',
    DRAFT_RULE,
    '',
    CONTACT_RULES,
    '',
    SIGNATURE_RULE,
    '',
    ATTACHMENT_RULE,
    '',
    '===========================================',
    '📧 E-MAIL-VERSAND',
    '===========================================',
    'Ablauf: show_draft(to, subject, body, tone) → Bestätigung → send_email(to, subject, body, tone)',
    '⛔ NIEMALS ohne Bestätigung senden.',
    'STANDARD "an mich" → eugen.priss@yahoo.com',
    '',
    '===========================================',
    'TELEGRAM',
    '===========================================',
    'Tool: send_telegram_message(chat_id, text)',
    'Frage IMMER zuerst: "Soll ich das schicken?"',
    '',
    '===========================================',
    'TOOLS',
    '===========================================',
    'get_weather, find_restaurants, get_user_preferences, save_user_preference,',
    'find_contact, save_contact, forget_contact, list_contacts,',
    'find_group, save_group, forget_group, list_groups, resolve_recipients,',
    'save_user_profile, show_draft, send_email, send_telegram_message',
    '',
    'NIEMALS Wetter/Restaurants erfinden.'
  );

  if (attachmentNote) {
    lines.push('');
    lines.push(attachmentNote);
  }

  return lines.join('\n');
}

// ==================== BUSINESS PROMPT ====================

function buildBusinessPrompt(profile) {
  const today = new Date().toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const name = profile.name || 'Nutzer';

  return [
    LANGUAGE_RULE,
    '',
    '===========================================',
    'BUSINESS-MODUS',
    '===========================================',
    'Du bist Jony im BUSINESS-MODUS. Content-Stratege für Instagram-Karussells.',
    'Heute ist ' + today + '.',
    '',
    'WICHTIG: Du SPRICHST Skripte NIEMALS laut vor.',
    '',
    'WORKFLOW:',
    '1. Thema klären',
    '2. Sage "Alles klar, ich erstelle das Skript."',
    '3. Rufe generate_script auf',
    '4. Nach Tool: "Skript ist da. Schau in die App."',
    '5. Bei "mach Bilder": generate_image für JEDEN Slide',
    '6. Bei "schick per Mail": ERST Adresse + Bestätigung, DANN send_carousel_email',
    '',
    'Der Nutzer heißt ' + name + '.',
    '',
    'TOOLS: generate_script, generate_image, send_carousel_email',
    '',
    'VERBOTEN: Skript vorlesen, Smalltalk, Tools nach Fehler wiederholen.',
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

// ==================== AGENT-DEFINITIONEN ====================

const AGENTS = {
  jony: {
    voice: 'Fenrir',
    buildPrompt: (profile, role, attachments) => buildJonyPrompt(profile, role, attachments),
    tools: () => buildJonyTools(),
  },
  business: {
    voice: 'Charon',
    buildPrompt: (profile) => buildBusinessPrompt(profile),
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

  if (userProfile.user_id) {
    try {
      const dbRes = await fetch(SELF_URL + '/api/profile/' + userProfile.user_id);
      if (dbRes.ok) {
        const dbData = await dbRes.json();
        const dbProfile = dbData.data || {};
        if (dbProfile.name) userProfile.name = dbProfile.name;
        if (dbProfile.nickname) userProfile.nickname = dbProfile.nickname;
        if (dbProfile.hometown) userProfile.hometown = dbProfile.hometown;
        if (dbProfile.user_name) userProfile.user_name = dbProfile.user_name;
        if (dbProfile.user_address) userProfile.user_address = dbProfile.user_address;
        if (dbProfile.user_birthdate) userProfile.user_birthdate = dbProfile.user_birthdate;
        if (dbProfile.user_phone) userProfile.user_phone = dbProfile.user_phone;
        if (dbProfile.user_email_default) userProfile.user_email_default = dbProfile.user_email_default;
        console.log(`✅ Profil angereichert: name="${userProfile.name}"`);
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

  // Aktuelle Anhänge holen
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

// ==================== PROAKTIV-INTERVALLE ====================

const PROACTIVE_INTERVALS = {
  kids: 25000,
  party: 15000,
  freund: 45000,
  berater: 0,
};

function buildProactivePrompt(role) {
  if (role === 'kids') {
    return '[SYSTEM-INSTRUKTION] Es ist kurz still. ' +
           'Sei PROAKTIV aber LOCKER: Frag nach was Coolem.';
  }
  if (role === 'party') {
    return '[SYSTEM-INSTRUKTION] Es ist seit einer Weile still. ' +
           'Sei PROAKTIV: Lockerer Spruch, 1 Satz.';
  }
  if (role === 'freund') {
    return '[SYSTEM-INSTRUKTION] Es ist still. ' +
           'Sei sanft proaktiv: Neugierige Frage oder warme Bemerkung. 1 kurzer Satz.';
  }
  return null;
}

// ==================== TOOLS ====================

function buildJonyTools() {
  return [
    {
      functionDeclarations: [
        {
          name: 'get_weather',
          description: 'Ruft das aktuelle Wetter und die Vorhersage für einen Ort ab.',
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
          description: 'Sucht einen Kontakt im Gedächtnis.',
          parameters: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING' },
            },
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
            properties: {
              name: { type: 'STRING' },
            },
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
          description: 'Sucht eine Gruppe (z.B. "familie").',
          parameters: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING' },
            },
            required: ['name'],
          },
        },
        {
          name: 'save_group',
          description: 'Speichert eine Gruppe. members ist eine Liste von Kontakt-Namen.',
          parameters: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING' },
              members: {
                type: 'ARRAY',
                items: { type: 'STRING' },
              },
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
            properties: {
              name: { type: 'STRING' },
            },
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
          description: 'Löst mehrere Namen (Kontakte + Gruppen) zu Empfängern auf.',
          parameters: {
            type: 'OBJECT',
            properties: {
              names: {
                type: 'ARRAY',
                items: { type: 'STRING' },
              },
            },
            required: ['names'],
          },
        },
        {
          name: 'save_user_profile',
          description: 'Speichert Nutzer-Profil (Name, Adresse, Geburtsdatum, Telefon).',
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
          description: 'Zeigt den E-Mail-Entwurf strukturiert in der App an. ' +
                       '⛔ Lies ihn NICHT laut vor. Sage nur kurz: "Entwurf ist da."',
          parameters: {
            type: 'OBJECT',
            properties: {
              to: { type: 'STRING' },
              subject: { type: 'STRING' },
              body: { type: 'STRING', description: 'Nur Text der E-Mail (ohne Signatur)' },
              tone: { type: 'STRING', description: 'formell | persönlich | locker' },
            },
            required: ['to', 'subject', 'body', 'tone'],
          },
        },
        {
          name: 'send_email',
          description: 'Sendet die E-Mail NACH Bestätigung.',
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
          description: 'Sendet das Karussell per E-Mail.',
          parameters: {
            type: 'OBJECT',
            properties: {
              to: { type: 'STRING' },
            },
            required: ['to'],
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
    const attachments = await fetchUserAttachments(userId);

    // Draft über API speichern
    const res = await fetch(SELF_URL + '/api/draft/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        to, subject, body, tone,
      }),
    }).catch(() => null);

    // Falls kein /api/draft/save Endpunkt existiert, zeigen wir es trotzdem per broadcast
    // (Fallback für Voice — nutzt den /api/draft/get Endpunkt aus server.js)

    broadcastToClients({
      type: 'draft_shown',
      draft: {
        to, subject, body, tone,
        attachments: attachments.map(a => ({
          id: a.id,
          filename: a.filename,
          size: a.size,
        })),
      },
    });

    console.log(`📝 Voice-Draft angezeigt: an ${to} (${tone})`);

    return {
      success: true,
      message: 'Entwurf wird in der App angezeigt. Warte auf Bestätigung des Nutzers.',
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

        // ⬇️ NEU: App meldet neuen Anhang
        if (msg.type === 'attachment_added') {
          console.log(`📎 Anhang-Event von App: ${msg.filename || 'unbekannt'}`);

          // Anhänge frisch holen
          const freshAttachments = await fetchUserAttachments(userProfile.user_id);
          clientWs._currentAttachments = freshAttachments;

          if (clientWs._session && freshAttachments.length > 0) {
            const names = freshAttachments.map(a => a.filename).join(', ');
            try {
              clientWs._session.sendClientContent({
                turns: [{
                  role: 'user',
                  parts: [{ text: '[SYSTEM] Anhänge bereit: ' + names + '. Du kannst sie bei show_draft/send_email nutzen.' }],
                }],
                turnComplete: true,
              });
            } catch (e) {
              console.error('❌ Anhang-Info an Gemini Fehler:', e.message);
            }
          }

          clientWs.send(JSON.stringify({
            type: 'attachment_ack',
            count: freshAttachments.length,
            filenames: freshAttachments.map(a => a.filename),
          }));
          return;
        }

        // ⬇️ NEU: App meldet Anhang entfernt
        if (msg.type === 'attachment_removed') {
          const freshAttachments = await fetchUserAttachments(userProfile.user_id);
          clientWs._currentAttachments = freshAttachments;
          console.log(`📎 Anhang entfernt. Jetzt: ${freshAttachments.length}`);
          return;
        }

        // ⬇️ NEU: App bestätigt Draft (klick auf ✅)
        if (msg.type === 'draft_confirm') {
          console.log(`✅ Draft bestätigt von App`);
          // Sende internen Trigger an Gemini → send_email aufrufen
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

        // ⬇️ NEU: App bricht Draft ab (klick auf ❌)
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
