// server/gemini_live.js

import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import { detectMode, logPresence } from './supervisor.js';
import { sendTelegramMessage, onTelegramMessage } from './telegram.js';
import { sendCarouselByEmail } from './email.js';
import { setScript, addImage, getCarousel } from './carousel_store.js';

const GEMINI_MODEL = 'gemini-3.8-live';
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

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

// ==================== TOKEN-LOGGING (VOICE) ====================

let _tokenPool = null;
async function logVoiceTokens(userId, model, inputTokens, outputTokens) {
  try {
    if (!_tokenPool) {
      const pg = (await import('pg')).default;
      _tokenPool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      });
    }
    const total = (inputTokens || 0) + (outputTokens || 0);
    if (total === 0) return;
    await _tokenPool.query(`
      INSERT INTO token_usage (user_id, source, model, input_tokens, output_tokens, total_tokens)
      VALUES ($1, 'voice', $2, $3, $4, $5)
    `, [userId, model, inputTokens || 0, outputTokens || 0, total]);
  } catch (e) {
    console.error('⚠️ Voice-Token-Log-Fehler:', e.message);
  }
}

// ==================== HILFE ====================

function isHereKeyword(loc) {
  if (!loc || typeof loc !== 'string') return false;
  const t = loc.toLowerCase().trim();
  return /^(hier|hier\s+bei\s+mir|bei\s+mir|mein\s+standort|meine\s+position|aktueller\s+standort|vor\s+ort|hier\s+vor\s+ort|здесь|тут|у\s+меня|моё\s+местоположение)$/.test(t);
}

function getTimeContext() {
  const now = new Date();
  const h = now.getHours();
  let t;
  if (h >= 5 && h < 11) t = 'Morgen';
  else if (h >= 11 && h < 14) t = 'Mittag';
  else if (h >= 14 && h < 18) t = 'Nachmittag';
  else if (h >= 18 && h < 22) t = 'Abend';
  else t = 'Nacht';
  const wd = now.toLocaleDateString('de-DE', { weekday: 'long' });
  return wd + (t === 'Morgen' ? 'morgen' : ', ' + t);
}

// ==================== KOMPAKTES FUNDAMENT ====================

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

// ==================== KOMPAKTE REGELN ====================

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
  'DRAFT: Niemals laut vorlesen. Nur "Entwurf ist da. Schau auf den Bildschirm."',
  '',
  'TELEGRAM: send_telegram_message(chat_id, text). Eugen: 8448058381.',
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
  '6. Skript NIEMALS laut vorlesen. Skript erscheint in der App als Karte.',
  '',
  'STANDARD-EMP: "an mich" → eugen.priss@yahoo.com',
  '',
  'Bei "beide" (Mail + Telegram): beide Tools hintereinander aufrufen.',
].join('\n');

const ROLES = {
  freund: {
    name: 'Freund',
    prompt: 'FREUND-MODUS: Wie ein guter alter Freund. Warm, direkt, 1-3 Sätze. Variiere.',
  },
  party: {
    name: 'Party',
    prompt: 'PARTY-MODUS: Locker, jugendlich, Humor, Slang. Coole Kumpel.',
  },
  berater: {
    name: 'Berater',
    prompt: 'BERATER-MODUS: Sachlich, präzise. Bei Recht/Medizin/Finanzen: Hinweis auf Prüfung. 2-4 Sätze.',
  },
  kids: {
    name: 'Kids',
    prompt: 'KIDS-MODUS (8-14 Jahre): Wie ein älterer Cousin. Gaming, Fußball, coole Fakten, Tiere. NIE herablassend.',
  },
};

const JONY_BASE = 'Du bist Jony, persönlicher Begleiter von Eugen (auch Jackson). Ehrlich, warmherzig, humorvoll. Kein Assistent – ein Freund. Beim Voice-Modus: sprich natürlich, kurz, variiere.';

const JONY_TOOLS_LIST = 'TOOLS: get_weather, find_restaurants, save_user_preference, get_user_preferences, find_contact, save_contact, forget_contact, list_contacts, find_group, save_group, forget_group, list_groups, resolve_recipients, save_user_profile, show_draft, send_email, send_telegram_message';

const BUSINESS_TOOLS_LIST = 'TOOLS: generate_script, generate_image, send_carousel_email, send_carousel_telegram + alle Kontakt-/Gruppen-/E-Mail-Tools';

// ==================== ANTI-REPETITION ====================

const ANTI_REPETITION = [
  'ANTI-WIEDERHOLUNG: Wähle jedes Mal eine andere Begrüßung.',
  'BEGRÜSSUNGEN: "Hey" / "Na" / "Servus" / "Moin" / "Endlich" / "Was geht" / "Grüß dich"',
  'VARIIERE Satzlängen (mal 3 Wörter, mal 15). Nutze Namen nur ab und zu.',
  'Erwähne NICHT automatisch den Standort.',
].join('\n');

// ==================== PROMPT-BUILD ====================

function buildJonyPrompt(userData, role = 'freund', currentLocation = null, attachments = []) {
  const foundation = buildFoundation(userData, currentLocation, attachments);
  const roleData = ROLES[role] || ROLES.freund;

  return [
    foundation,
    '',
    CORE_RULES,
    '',
    JONY_BASE,
    '',
    ANTI_REPETITION,
    '',
    'ROLLE: ' + roleData.name.toUpperCase(),
    roleData.prompt,
    '',
    'MODUS (NORMAL/SILENT):',
    'NORMAL: aktiv, freundlich.',
    'SILENT: aufmerksam, aber reagiere NICHT – Ausnahme "Hey Jony".',
    '',
    JONY_TOOLS_LIST,
    '',
    'NIEMALS Wetter/Restaurants erfinden.',
  ].join('\n');
}

function buildBusinessPrompt(userData, currentLocation = null, attachments = []) {
  const foundation = buildFoundation(userData, currentLocation, attachments);

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

// ==================== MODUS-INSTRUKTION ====================

function modeInstruction(mode) {
  if (mode === 'silent') return '[SYSTEM] SILENT-MODUS. Reagiere NICHT. Ausnahme: "Hey Jony" → "Ja?".';
  return '[SYSTEM] NORMAL-MODUS. Freundlich, kurz. Variiere.';
}

function roleSwitchInstruction(role) {
  const r = ROLES[role] || ROLES.freund;
  return '[SYSTEM] Rollenwechsel zu ' + r.name.toUpperCase() + '.\n\n' + r.prompt;
}

function dolmetscherInstruction(active) {
  if (active) {
    return '[SYSTEM] DOLMETSCHER-MODUS AKTIV.\n' +
           'Übersetze zwischen beliebigen Sprachen:\n' +
           '- Fremde Person spricht → DEUTSCH für Eugen\n' +
           '- Eugen spricht DE/RU → Zielsprache\n' +
           'Format: NUR die Übersetzung. Bestätige mit "Dolmetscher-Modus aktiv."';
  }
  return '[SYSTEM] Dolmetscher-Modus beendet.';
}

// ==================== NAME-PATTERN ====================

const NAME_PATTERN = '(jony|johnny|joni|джони|джонни|джонi)';

const PATTERNS = {
  business: new RegExp(`\\b(${NAME_PATTERN}.?business|business.?modus|business\\s+mode|бизнес.?мод|бизнес)\\b`, 'i'),
  backToJony: new RegExp(
    `\\b(${NAME_PATTERN}.?(zur[üu]ck|freund|normal|back|обратно|вернись)|` +
    `zur[üu]ck.*(freund|jony|johnny)|freund.?modus|normal.?modus|freundesmodus|` +
    `вернись.*друг|обратно.*друг|режим.?друга)\\b`, 'i'),
  party: new RegExp(`\\b(${NAME_PATTERN}.?party|party.?modus|partymodus|party\\s+mode|${NAME_PATTERN}.?пати|пати.?мод|вечеринк)\\b`, 'i'),
  berater: new RegExp(`\\b(${NAME_PATTERN}.?(berater|sachlich|intellektuell)|berater.?modus|beratermodus|${NAME_PATTERN}.?советник|советник.?мод|консультант)\\b`, 'i'),
  kids: new RegExp(`\\b(${NAME_PATTERN}.?(kids|niklas|kinder|kind|junge|junior|kumpel)|kids.?modus|kinder.?modus|niklas.?modus|junge.?modus|${NAME_PATTERN}.?(детск|пацан|малой|ребенок|ребёнок)|детск.?мод|детск.?режим)\\b`, 'i'),
  dolmetscher: new RegExp(`\\b(${NAME_PATTERN}.?(dolmetscher|übersetz|uebersetz|translator)|dolmetscher.?modus|übersetzer|uebersetzer|${NAME_PATTERN}.?(перевод|переводчик)|переводчик|режим.?перевода)\\b`, 'i'),
};

// ==================== PROAKTIV ====================

const PROACTIVE_INTERVALS = {
  kids: 25000,
  party: 15000,
  freund: 45000,
  berater: 0,
};

function buildProactivePrompt(role) {
  if (role === 'kids') return '[SYSTEM] Kurze Pause. Frag locker nach was Cooles (Gaming, Fußball, Hobbys). 1 Satz. NICHT dieselbe Frage wie vorher.';
  if (role === 'party') return '[SYSTEM] Stille. Lockerer Spruch oder Kommentar. 1 Satz. NICHT dieselbe Formulierung.';
  if (role === 'freund') return '[SYSTEM] Stille. Neugierige Frage oder warme Bemerkung. 1 kurzer Satz. NICHT dieselbe Frage.';
  return null;
}

// ==================== AGENTS ====================

const AGENTS = {
  jony: {
    voice: 'Fenrir',
    buildPrompt: (userData, role, loc, att) => buildJonyPrompt(userData, role, loc, att),
    tools: () => buildJonyTools(),
  },
  business: {
    voice: 'Charon',
    buildPrompt: (userData, role, loc, att) => buildBusinessPrompt(userData, loc, att),
    tools: () => buildBusinessTools(),
  },
};

// ==================== AKTIVE CLIENTS ====================

const activeClients = new Set();

export function broadcastToClients(msg) {
  console.log(`📢 Broadcast an ${activeClients.size}: ${msg.type}`);
  for (const c of activeClients) {
    try { c.send(JSON.stringify(msg)); } catch (e) {}
  }
}

// ==================== HELPER ====================

async function fetchUserData(userId) {
  if (!userId) return {};
  try {
    const res = await fetch(SELF_URL + '/api/profile/' + userId);
    if (!res.ok) return {};
    const data = await res.json();
    return data.data || {};
  } catch (e) { return {}; }
}

async function fetchUserAttachments(userId) {
  if (!userId) return [];
  try {
    const res = await fetch(SELF_URL + '/api/attachments/list/' + userId);
    if (!res.ok) return [];
    const data = await res.json();
    return data.attachments || [];
  } catch (e) { return []; }
}

// ==================== GEMINI LIVE ====================

export async function createGeminiSession(clientWs, userProfile, agentType = 'jony') {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const agentConfig = AGENTS[agentType] || AGENTS.jony;

  const userData = await fetchUserData(userProfile.user_id);
  clientWs._userData = userData;

  let currentLocation = null;
  if (clientWs._lastLat != null && clientWs._lastLon != null) {
    currentLocation = {
      lat: clientWs._lastLat,
      lon: clientWs._lastLon,
      city: userData.hometown || userProfile.hometown,
    };
  } else if (userData.hometown) {
    currentLocation = { city: userData.hometown };
  }

  const attachments = await fetchUserAttachments(userProfile.user_id);
  clientWs._currentAttachments = attachments;

  console.log(`🔌 Gemini Live (${agentType}, Voice: ${agentConfig.voice}, Anhänge: ${attachments.length})...`);

  const systemInstruction = agentConfig.buildPrompt(
    userData,
    clientWs._currentRole || 'freund',
    currentLocation,
    attachments
  );

  console.log(`   📏 Prompt: ${systemInstruction.length} Zeichen`);

  let session = null;

  session = await ai.live.connect({
    model: GEMINI_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: agentConfig.voice } },
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
        console.log(`✅ Gemini Live (${agentType})`);
        clientWs.send(JSON.stringify({ type: 'status', status: 'connected', agent: agentType }));
      },
      onmessage: (message) => {
        if (clientWs._session !== session) return;
        handleGeminiMessage(clientWs, message, session, userProfile, agentType);
      },
      onerror: (error) => {
        console.error('❌ Gemini Live:', error);
        try { clientWs.send(JSON.stringify({ type: 'error', message: String(error) })); } catch (e) {}
      },
      onclose: () => {
        console.log(`🔌 Gemini Live geschlossen (${agentType})`);
        try { clientWs.send(JSON.stringify({ type: 'status', status: 'disconnected' })); } catch (e) {}
      },
    },
  });

  return session;
}

// ==================== NACHRICHTEN ====================

async function handleGeminiMessage(clientWs, message, session, userProfile, agentType) {
  const sc = message.serverContent;

  if (sc?.modelTurn?.parts) {
    clientWs._geminiIsSpeaking = true;
    for (const part of sc.modelTurn.parts) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) {
        clientWs.send(JSON.stringify({ type: 'audio', data: part.inlineData.data, sampleRate: SAMPLE_RATE_OUT }));
      }
    }
  }

  if (sc?.inputTranscription?.text) {
    const userText = sc.inputTranscription.text;
    clientWs._lastUserSpeechTime = Date.now();
    console.log('🎤 Nutzer:', userText);
    clientWs.send(JSON.stringify({ type: 'transcript', role: 'user', text: userText }));

    let targetAgent = agentType;
    let targetRole = clientWs._currentRole || 'freund';
    let toggledDolm = null;

    if (agentType === 'jony' && PATTERNS.dolmetscher.test(userText)) {
      const on = clientWs._dolmetscherActive || false;
      const isOff = /\b(aus|beenden|stop|off|хватит|стоп|выключи)\b/i.test(userText);
      if (on && isOff) { clientWs._dolmetscherActive = false; toggledDolm = false; }
      else if (!on && !isOff) { clientWs._dolmetscherActive = true; toggledDolm = true; }
      if (toggledDolm !== null) {
        clientWs.send(JSON.stringify({ type: 'dolmetscher', active: toggledDolm }));
        try { session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: dolmetscherInstruction(toggledDolm) }] }], turnComplete: true }); } catch (e) {}
        return;
      }
    }

    if (agentType === 'business') {
      if (PATTERNS.party.test(userText)) { targetAgent = 'jony'; targetRole = 'party'; }
      else if (PATTERNS.berater.test(userText)) { targetAgent = 'jony'; targetRole = 'berater'; }
      else if (PATTERNS.kids.test(userText)) { targetAgent = 'jony'; targetRole = 'kids'; }
      else if (PATTERNS.backToJony.test(userText)) { targetAgent = 'jony'; targetRole = 'freund'; }
    } else {
      if (PATTERNS.business.test(userText)) targetAgent = 'business';
      else {
        if (PATTERNS.party.test(userText)) targetRole = 'party';
        else if (PATTERNS.berater.test(userText)) targetRole = 'berater';
        else if (PATTERNS.kids.test(userText)) targetRole = 'kids';
        else if (PATTERNS.backToJony.test(userText)) targetRole = 'freund';
      }
    }

    if (targetAgent !== agentType) {
      console.log(`🔄 Agent: ${agentType} → ${targetAgent}`);
      try { await clientWs._session?.close(); } catch (e) {}
      await new Promise(r => setTimeout(r, 300));
      clientWs._currentRole = targetRole;
      clientWs._session = await createGeminiSession(clientWs, userProfile, targetAgent);
      clientWs._currentAgent = targetAgent;
      clientWs.send(JSON.stringify({ type: 'agent', agent: targetAgent }));
      return;
    }

    if (agentType === 'jony' && targetRole !== clientWs._currentRole) {
      clientWs._currentRole = targetRole;
      console.log(`🎭 Rolle: → ${targetRole}`);
      clientWs.send(JSON.stringify({ type: 'role', role: targetRole }));
      try { session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: roleSwitchInstruction(targetRole) }] }], turnComplete: true }); } catch (e) {}
    }

    if (agentType === 'jony' && userProfile.user_id) {
      const cur = clientWs._lastMode || 'normal';
      const mode = await detectMode(userProfile.user_id, clientWs._lastImuState || 'unknown', clientWs._lastLat, clientWs._lastLon, userText, cur);
      if (mode !== cur) {
        clientWs._lastMode = mode;
        clientWs.send(JSON.stringify({ type: 'mode', mode }));
        try { session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: modeInstruction(mode) }] }], turnComplete: true }); } catch (e) {}
      }
    }
  }

  if (sc?.outputTranscription?.text) {
    console.log(`🤖 ${agentType === 'business' ? 'Business' : 'Jony'}:`, sc.outputTranscription.text);
    clientWs.send(JSON.stringify({ type: 'transcript', role: 'assistant', text: sc.outputTranscription.text }));
  }

  if (message.toolCall) {
    handleToolCall(clientWs, session, userProfile, message.toolCall, agentType);
  }

  if (sc?.turnComplete) {
    clientWs._geminiIsSpeaking = false;
    clientWs._lastUserSpeechTime = Date.now();
    clientWs.send(JSON.stringify({ type: 'turn_complete' }));

    // ★ Token-Usage loggen (falls Gemini Live sie liefert)
    if (sc.usageMetadata && userProfile?.user_id) {
      const u = sc.usageMetadata;
      const inTok = u.promptTokenCount || 0;
      const outTok = u.candidatesTokenCount || 0;
      console.log(`   📊 VOICE-TOKENS: input=${inTok}, output=${outTok}`);
      logVoiceTokens(userProfile.user_id, 'gemini-live', inTok, outTok);
    }
  }

  // Fallback: Usage manchmal auf Top-Level
  if (message.usageMetadata && userProfile?.user_id) {
    const u = message.usageMetadata;
    const inTok = u.promptTokenCount || 0;
    const outTok = u.candidatesTokenCount || 0;
    if (inTok + outTok > 0) {
      console.log(`   📊 VOICE-TOKENS (top): input=${inTok}, output=${outTok}`);
      logVoiceTokens(userProfile.user_id, 'gemini-live', inTok, outTok);
    }
  }
}

// ==================== TOOLS ====================

function buildJonyTools() {
  return [
    {
      functionDeclarations: [
        { name: 'get_weather', description: 'Wetter für einen Ort.', parameters: { type: 'OBJECT', properties: { location: { type: 'STRING' }, timeframe: { type: 'STRING' } }, required: ['location'] } },
        { name: 'find_restaurants', description: 'Restaurants in der Nähe.', parameters: { type: 'OBJECT', properties: { location: { type: 'STRING' }, cuisine: { type: 'STRING' } }, required: ['location'] } },
        { name: 'save_user_preference', description: 'Speichert Nutzer-Info.', parameters: { type: 'OBJECT', properties: { key: { type: 'STRING' }, value: { type: 'STRING' } }, required: ['key', 'value'] } },
        { name: 'get_user_preferences', description: 'Lädt alle Nutzer-Infos.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'send_telegram_message', description: 'Sendet Telegram-Text. Frage IMMER zuerst.', parameters: { type: 'OBJECT', properties: { chat_id: { type: 'STRING' }, text: { type: 'STRING' } }, required: ['chat_id', 'text'] } },
        { name: 'find_contact', description: 'Sucht Kontakt.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
        { name: 'save_contact', description: 'Speichert Kontakt.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' }, email: { type: 'STRING' }, telegram: { type: 'STRING' }, phone: { type: 'STRING' }, aliases: { type: 'STRING' }, relation: { type: 'STRING' }, birthday: { type: 'STRING' }, tone: { type: 'STRING' }, notes: { type: 'STRING' } }, required: ['name'] } },
        { name: 'forget_contact', description: 'Löscht Kontakt.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
        { name: 'list_contacts', description: 'Listet Kontakte.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'find_group', description: 'Sucht Gruppe.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
        { name: 'save_group', description: 'Speichert Gruppe.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' }, members: { type: 'ARRAY', items: { type: 'STRING' } }, notes: { type: 'STRING' } }, required: ['name', 'members'] } },
        { name: 'forget_group', description: 'Löscht Gruppe.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
        { name: 'list_groups', description: 'Listet Gruppen.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'resolve_recipients', description: 'Löst Namen zu Empfängern auf.', parameters: { type: 'OBJECT', properties: { names: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['names'] } },
        { name: 'save_user_profile', description: 'Speichert Nutzer-Profil.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' }, address: { type: 'STRING' }, birthdate: { type: 'STRING' }, phone: { type: 'STRING' }, default_email: { type: 'STRING' } } } },
        { name: 'show_draft', description: 'Zeigt E-Mail-Entwurf als Karte (NUR normale Mails, NICHT Karussell). Nie laut vorlesen.', parameters: { type: 'OBJECT', properties: { to: { type: 'STRING' }, subject: { type: 'STRING' }, body: { type: 'STRING' }, tone: { type: 'STRING' } }, required: ['to', 'subject', 'body', 'tone'] } },
        { name: 'send_email', description: 'Sendet E-Mail nach Bestätigung.', parameters: { type: 'OBJECT', properties: { to: { type: 'STRING' }, subject: { type: 'STRING' }, body: { type: 'STRING' }, tone: { type: 'STRING' } }, required: ['to', 'subject', 'body', 'tone'] } },
      ],
    },
  ];
}

function buildBusinessTools() {
  return [
    {
      functionDeclarations: [
        { name: 'find_contact', description: 'Sucht Kontakt.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
        { name: 'save_contact', description: 'Speichert Kontakt.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' }, email: { type: 'STRING' }, telegram: { type: 'STRING' }, phone: { type: 'STRING' }, aliases: { type: 'STRING' }, relation: { type: 'STRING' }, birthday: { type: 'STRING' }, tone: { type: 'STRING' }, notes: { type: 'STRING' } }, required: ['name'] } },
        { name: 'forget_contact', description: 'Löscht Kontakt.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
        { name: 'list_contacts', description: 'Listet Kontakte.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'find_group', description: 'Sucht Gruppe.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
        { name: 'save_group', description: 'Speichert Gruppe.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' }, members: { type: 'ARRAY', items: { type: 'STRING' } }, notes: { type: 'STRING' } }, required: ['name', 'members'] } },
        { name: 'forget_group', description: 'Löscht Gruppe.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
        { name: 'list_groups', description: 'Listet Gruppen.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'resolve_recipients', description: 'Löst Namen zu Empfängern auf.', parameters: { type: 'OBJECT', properties: { names: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['names'] } },
        { name: 'save_user_profile', description: 'Speichert Nutzer-Profil.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' }, address: { type: 'STRING' }, birthdate: { type: 'STRING' }, phone: { type: 'STRING' }, default_email: { type: 'STRING' } } } },
        { name: 'get_weather', description: 'Wetter.', parameters: { type: 'OBJECT', properties: { location: { type: 'STRING' }, timeframe: { type: 'STRING' } }, required: ['location'] } },
        { name: 'find_restaurants', description: 'Restaurants.', parameters: { type: 'OBJECT', properties: { location: { type: 'STRING' }, cuisine: { type: 'STRING' } }, required: ['location'] } },
        { name: 'send_telegram_message', description: 'Sendet Telegram-Text. Frage IMMER zuerst.', parameters: { type: 'OBJECT', properties: { chat_id: { type: 'STRING' }, text: { type: 'STRING' } }, required: ['chat_id', 'text'] } },
        { name: 'show_draft', description: 'Zeigt E-Mail-Entwurf als Karte (NUR normale Mails, NICHT Karussell). Nie laut vorlesen.', parameters: { type: 'OBJECT', properties: { to: { type: 'STRING' }, subject: { type: 'STRING' }, body: { type: 'STRING' }, tone: { type: 'STRING' } }, required: ['to', 'subject', 'body', 'tone'] } },
        { name: 'send_email', description: 'Sendet E-Mail nach Bestätigung.', parameters: { type: 'OBJECT', properties: { to: { type: 'STRING' }, subject: { type: 'STRING' }, body: { type: 'STRING' }, tone: { type: 'STRING' } }, required: ['to', 'subject', 'body', 'tone'] } },
        { name: 'generate_script', description: 'Erstellt Karussell-Skript.', parameters: { type: 'OBJECT', properties: { topic: { type: 'STRING' }, audience: { type: 'STRING' }, focus: { type: 'STRING' }, slide_count: { type: 'INTEGER' } }, required: ['topic'] } },
        { name: 'generate_image', description: 'Generiert Bild für Karussell-Slide.', parameters: { type: 'OBJECT', properties: { prompt: { type: 'STRING' }, slide_number: { type: 'INTEGER' } }, required: ['prompt', 'slide_number'] } },
        { name: 'send_carousel_email', description: 'Sendet Karussell MIT ALLEN BILDERN als E-Mail. Nutze das IMMER für Karussell-Versand, NICHT show_draft.', parameters: { type: 'OBJECT', properties: { to: { type: 'STRING' } }, required: ['to'] } },
        { name: 'send_carousel_telegram', description: 'Sendet Karussell MIT ALLEN BILDERN an Telegram.', parameters: { type: 'OBJECT', properties: { chat_id: { type: 'STRING' } }, required: ['chat_id'] } },
      ],
    },
  ];
}

async function handleToolCall(clientWs, session, userProfile, toolCall, agentType) {
  const functionCalls = toolCall.functionCalls;
  const responses = [];

  for (const fc of functionCalls) {
    console.log('🔧 Tool:', fc.name, JSON.stringify(fc.args));
    let result = { status: 'ok' };

    try {
      if (fc.name === 'get_weather') {
        let loc = fc.args.location;
        if (isHereKeyword(loc)) loc = clientWs._userData?.hometown || userProfile.hometown || loc;
        result = await fetchWeather(loc, fc.args.timeframe);
      } else if (fc.name === 'find_restaurants') {
        let loc = fc.args.location;
        if (isHereKeyword(loc)) loc = clientWs._userData?.hometown || userProfile.hometown || loc;
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
        const { name: c, ...f } = fc.args;
        result = await handleSaveContact(userProfile.user_id, c, f);
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
        result = await handleSendEmail(fc.args.to, fc.args.subject, fc.args.body, { ...clientWs._userData, user_id: userProfile.user_id }, fc.args.tone || 'persönlich');
      } else if (fc.name === 'generate_script') {
        result = await generateScriptAndSend(clientWs, userProfile.user_id, fc.args.topic, fc.args.audience, fc.args.focus, fc.args.slide_count);
      } else if (fc.name === 'generate_image') {
        result = await generateImageAndSend(clientWs, userProfile.user_id, fc.args.prompt, fc.args.slide_number);
      } else if (fc.name === 'send_carousel_email') {
        result = await handleSendCarouselEmail(userProfile.user_id, fc.args.to, { ...clientWs._userData, user_id: userProfile.user_id });
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
      console.log('📤 Tool-Results:', responses.length);
    } catch (e) { console.error('❌ sendToolResponse:', e); }
  }
}

// ==================== HANDLER ====================

async function handleSendTelegram(chatId, text) {
  try {
    const res = await sendTelegramMessage(chatId, text);
    return { success: true, message: 'Telegram gesendet.' };
  } catch (e) { return { error: e.message }; }
}

async function handleShowDraft(userId, to, subject, body, tone) {
  try {
    await fetch(SELF_URL + '/api/draft/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, to, subject, body, tone }),
    });
    console.log(`📝 Draft angezeigt: an ${to} (${tone})`);
    return { success: true, message: 'Entwurf wird in der App angezeigt. Warte auf Bestätigung.' };
  } catch (e) { return { error: e.message }; }
}

async function handleSendEmail(to, subject, body, profile = {}, tone = 'persönlich') {
  try {
    const res = await fetch(SELF_URL + '/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, body, profile, tone }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { success: true, message: `E-Mail an ${to} gesendet.` };
  } catch (e) { return { error: e.message }; }
}

async function handleSendCarouselEmail(userId, to, profile = {}) {
  try {
    const carousel = getCarousel(userId);
    if (!carousel) return { error: 'Kein Karussell im Speicher.' };
    const res = await sendCarouselByEmail(to, carousel, profile);
    return { success: true, message: `Karussell "${res.topic}" mit ${res.imageCount} Bildern an ${to} gesendet.` };
  } catch (e) { return { error: e.message }; }
}

async function handleSendCarouselTelegram(userId, chatId) {
  try {
    const carousel = getCarousel(userId);
    if (!carousel) return { error: 'Kein Karussell im Speicher.' };
    const res = await fetch(SELF_URL + '/api/telegram/send-carousel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, topic: carousel.topic, slides: carousel.slides, images: carousel.images }),
    });
    if (!res.ok) return { error: `Telegram fehlgeschlagen: ${res.status}` };
    const data = await res.json();
    return { success: true, message: `Karussell "${carousel.topic}" mit ${data.imagesSent} Bildern auf Telegram gesendet.` };
  } catch (e) { return { error: e.message }; }
}

async function handleFindContact(userId, name) {
  try {
    const res = await fetch(SELF_URL + '/api/contacts/find', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, name }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

async function handleSaveContact(userId, name, fields) {
  try {
    const res = await fetch(SELF_URL + '/api/contacts/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, name, ...fields }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

async function handleForgetContact(userId, name) {
  try {
    const res = await fetch(SELF_URL + '/api/contacts/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, name }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

async function handleListContacts(userId) {
  try {
    const res = await fetch(SELF_URL + '/api/contacts/list/' + userId);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

async function handleFindGroup(userId, name) {
  try {
    const res = await fetch(SELF_URL + '/api/groups/find', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, name }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

async function handleSaveGroup(userId, name, members, notes) {
  try {
    const res = await fetch(SELF_URL + '/api/groups/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, name, members, notes }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

async function handleForgetGroup(userId, name) {
  try {
    const res = await fetch(SELF_URL + '/api/groups/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, name }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

async function handleListGroups(userId) {
  try {
    const res = await fetch(SELF_URL + '/api/groups/list/' + userId);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

async function handleResolveRecipients(userId, names) {
  try {
    const res = await fetch(SELF_URL + '/api/contacts/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, names }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

async function handleSaveUserProfile(userId, fields) {
  try {
    const res = await fetch(SELF_URL + '/api/user-profile/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, ...fields }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

// ==================== WEATHER / RESTAURANTS ====================

async function fetchWeather(location, timeframe = 'aktuell') {
  const url = SELF_URL + '/api/get-weather?location=' + encodeURIComponent(location);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeframe }) });
  if (!res.ok) throw new Error('Wetter-Fehler');
  const data = await res.json();
  return { location: data.location, current_temp: data.current?.temp, current_desc: data.current?.description, today_min: data.today?.min, today_max: data.today?.max, tomorrow_desc: data.tomorrow?.description, rain_chance: data.today?.rain_chance };
}

async function fetchRestaurants(location, cuisine = 'Restaurant') {
  const url = SELF_URL + '/api/search-restaurant?location=' + encodeURIComponent(location);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cuisine }) });
  if (!res.ok) throw new Error('Restaurant-Fehler');
  const data = await res.json();
  return { count: data.count, restaurants: (data.restaurants || []).map(r => ({ name: r.name, rating: r.rating, address: r.address, phone: r.phone })) };
}

async function saveUserPreference(userId, key, value) {
  if (!userId) return { error: 'no user_id' };
  const v = String(value || '').trim();
  if (!v || v === 'User Name' || v === 'undefined') return { success: false };
  const res = await fetch(SELF_URL + '/api/save-preference', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, key, value: v }) });
  return { success: res.ok };
}

async function getUserPreferences(userId) {
  if (!userId) return { error: 'no user_id' };
  const res = await fetch(SELF_URL + '/api/profile/' + userId);
  if (!res.ok) throw new Error('Lade-Fehler');
  const data = await res.json();
  return { preferences: data.data || {} };
}

// ==================== SCRIPT GENERATION ====================

async function generateScriptAndSend(clientWs, userId, topic, audience, focus, slideCount) {
  console.log(`📝 Skript: "${topic}"`);
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
      clientWs.send(JSON.stringify({ type: 'script', topic, slides }));
      return { success: true, slide_count: slides.length, message: `Skript mit ${slides.length} Slides in App angezeigt.` };
    } catch (e) {
      lastError = e;
      const errMsg = e.message || String(e);
      if (errMsg.includes('404') || errMsg.includes('does not exist')) continue;
    }
  }
  return { error: 'Skript-Generierung fehlgeschlagen: ' + (lastError?.message || '?') };
}

// ==================== IMAGE GENERATION ====================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function generateImageAndSend(clientWs, userId, prompt, slideNumber) {
  console.log(`🎨 Slide ${slideNumber}...`);
  const last = clientWs._lastImageTime || 0;
  const elapsed = Date.now() - last;
  if (elapsed < 2000) await sleep(2000 - elapsed);
  clientWs._lastImageTime = Date.now();

  try {
    const en = await translateToEnglishImagePrompt(prompt);
    let result = null;
    let lastError = null;
    for (let a = 1; a <= 3; a++) {
      try { result = await generateImageWithCloudflare(en); break; }
      catch (e) { lastError = e; if (a < 3) await sleep(3000 * a); }
    }
    if (!result) throw lastError || new Error('Cloudflare fehlgeschlagen');
    if (userId) addImage(userId, slideNumber, result.imageBase64, result.mimeType);
    clientWs.send(JSON.stringify({ type: 'image', slide: slideNumber, mimeType: result.mimeType, data: result.imageBase64 }));
    return { success: true, slide: slideNumber };
  } catch (e) { return { error: 'Bildgenerierung fehlgeschlagen: ' + e.message, slide: slideNumber }; }
}

// ==================== WEBSOCKET ====================

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
    clientWs._userData = {};

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
            if (clientWs._session) { try { await clientWs._session.close(); } catch (e) {} clientWs._session = null; }
          }
          if (oldMode === 'chat' && newMode === 'voice') {
            if (!clientWs._session) clientWs._session = await createGeminiSession(clientWs, userProfile, 'jony');
          }
          return;
        }

        if (msg.type === 'context') {
          clientWs._lastImuState = msg.imu_state;
          clientWs._lastLat = msg.lat;
          clientWs._lastLon = msg.lon;
          if (userProfile.user_id) await logPresence(userProfile.user_id, msg.imu_state, msg.lat, msg.lon);
          if (msg.lat != null && msg.lon != null && !clientWs._userData.current_city) {
            clientWs._userData.current_city = clientWs._userData.hometown;
          }
          return;
        }

        if (msg.type === 'attachment_added') {
          console.log(`📎 Anhang: ${msg.filename || '?'}`);
          const fresh = await fetchUserAttachments(userProfile.user_id);
          clientWs._currentAttachments = fresh;
          if (clientWs._session && fresh.length > 0) {
            try {
              clientWs._session.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: '[SYSTEM] Anhänge bereit: ' + fresh.map(a => a.filename).join(', ') }] }],
                turnComplete: true,
              });
            } catch (e) {}
          }
          clientWs.send(JSON.stringify({ type: 'attachment_ack', count: fresh.length, filenames: fresh.map(a => a.filename) }));
          return;
        }

        if (msg.type === 'attachment_removed') {
          clientWs._currentAttachments = await fetchUserAttachments(userProfile.user_id);
          return;
        }

        if (msg.type === 'draft_confirm') {
          console.log(`✅ Draft bestätigt`);
          if (clientWs._session) {
            try {
              clientWs._session.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: '[SYSTEM] Nutzer hat bestätigt. Rufe jetzt send_email auf mit denselben Werten wie show_draft.' }] }],
                turnComplete: true,
              });
            } catch (e) {}
          }
          return;
        }

        if (msg.type === 'draft_cancel') {
          console.log(`❌ Draft verworfen`);
          if (clientWs._session) {
            try {
              clientWs._session.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: '[SYSTEM] Nutzer hat verworfen. Frage was stattdessen.' }] }],
                turnComplete: true,
              });
            } catch (e) {}
          }
          return;
        }

        if (msg.type === 'audio' && clientWs._session) {
          clientWs._session.sendRealtimeInput({ audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' } });
        }

        if (msg.type === 'video' && clientWs._session) {
          try { clientWs._session.sendRealtimeInput({ video: { data: msg.data, mimeType: 'image/jpeg' } }); } catch (e) {}
        }

        if (msg.type === 'text' && clientWs._session) {
          clientWs._session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: msg.text }] }], turnComplete: true });
        }
      } catch (error) { console.error('❌ WS-Fehler:', error); }
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
        clientWs._session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: prompt }] }], turnComplete: true });
        clientWs._lastUserSpeechTime = Date.now();
      } catch (e) {}
    }, 5000);

    clientWs.on('close', async () => {
      console.log('📱 App getrennt');
      activeClients.delete(clientWs);
      if (clientWs._proactiveTimer) { clearInterval(clientWs._proactiveTimer); clientWs._proactiveTimer = null; }
      if (clientWs._session) { try { await clientWs._session.close(); } catch (e) {} clientWs._session = null; }
    });

    clientWs.on('error', (error) => {
      console.error('❌ WS:', error);
      activeClients.delete(clientWs);
      if (clientWs._proactiveTimer) { clearInterval(clientWs._proactiveTimer); clientWs._proactiveTimer = null; }
      if (clientWs._session) clientWs._session.close();
    });
  });

  console.log('✅ WebSocket: /ws/gemini-live');
  return wss;
}

onTelegramMessage((payload) => {
  console.log(`📨 Telegram: ${payload.fromName}: "${payload.text.substring(0, 60)}"`);
});