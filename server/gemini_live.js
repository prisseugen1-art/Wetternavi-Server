// server/gemini_live.js

import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import { detectMode, logPresence } from './supervisor.js';

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
};

// ==================== PROAKTIV-INTERVALLE ====================

const PROACTIVE_INTERVALS = {
  party: 15000,
  freund: 45000,
  berater: 0,
};

function buildProactivePrompt(role) {
  if (role === 'party') {
    return '[SYSTEM-INSTRUKTION] Es ist seit einer Weile still. ' +
           'Sei PROAKTIV: Lockerer Spruch, Vorschlag oder Kommentar zur Umgebung. ' +
           'KURZ und lässig, 1 Satz. Nicht aufdringlich.';
  }
  if (role === 'freund') {
    return '[SYSTEM-INSTRUKTION] Es ist still. ' +
           'Sei sanft proaktiv: Neugierige Frage oder warme Bemerkung. ' +
           'Ruhig, 1 kurzer Satz.';
  }
  return null;
}

// ==================== HARTE SPRACHREGEL ====================

const LANGUAGE_LOCK = `
===========================================
🚨 SPRACHREGEL – HART UND UNVERBRÜCHLICH
===========================================

Du sprichst AUSSCHLIESSLICH zwei Sprachen:
- DEUTSCH
- RUSSISCH

Wenn der Nutzer in einer ANDEREN Sprache spricht (Spanisch, Englisch, 
Rumänisch, Französisch, Italienisch, Türkisch, Polnisch, etc.):
→ Ignoriere den fremdsprachigen Inhalt KOMPLETT.
→ Antworte auf DEUTSCH: "Bitte Deutsch oder Russisch."

VERBOTEN (auch wenn der Nutzer es provoziert):
- Spanisch sprechen ❌
- Englisch sprechen ❌
- Rumänisch sprechen ❌
- Französisch sprechen ❌
- Italienisch sprechen ❌
- Jede andere Sprache außer Deutsch/Russisch ❌

Diese Regel hat HÖCHSTE Priorität.
`;

// ==================== ROLLEN (für Jony) ====================

const ROLES = {
  freund: {
    name: 'Freund',
    prompt: `Du bist im FREUND-MODUS – Standard.
- Sprich warm, persönlich, ruhig.
- Beziehe dich auf Eugens Vorlieben, Familie, Geschichte.
- Antworte in 1-2 kurzen Sätzen.
- Variiere deine Antworten.`,
  },
  party: {
    name: 'Party',
    prompt: `Du bist im PARTY-MODUS.
- Sprich locker, jugendlich, mit Humor und Slang.
- Du kennst die Hobbys der Kinder (Konstantin, Niklas).
- Sei der coole Kumpel.
- Keine persönlichen Daten von Eugen ohne OK.
- Aktiv, aber nicht aufdringlich.
- Wenn die Gruppe redet: SEI STILL.`,
  },
  berater: {
    name: 'Berater',
    prompt: `Du bist im BERATER-MODUS.
- Sprich sachlich, präzise, ruhig.
- Strukturiere Antworten.
- Bei Recht/Medizin/Finanzen: Hinweis auf menschliche Prüfung.
- Antworte in 2-3 kurzen Sätzen.`,
  },
};

// ==================== JONY PROMPT ====================

const JONY_BASE = `Du bist Jony, der persönliche Begleiter von Eugen (auch Jackson genannt).
Du bist ehrlich, warmherzig, direkt, humorvoll.
Du bist kein Assistent, sondern ein Freund.
Heute ist {today}. Eugen ist in {hometown}.`;

function buildJonyPrompt(profile, role = 'freund') {
  const roleData = ROLES[role] || ROLES.freund;
  const today = new Date().toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const base = JONY_BASE
    .replace('{today}', today)
    .replace('{hometown}', profile.hometown || 'unbekannt');

  const name = profile.name || 'Nutzer';
  const nickname = profile.nickname ? ' (' + profile.nickname + ')' : '';

  return [
    LANGUAGE_LOCK,
    '',
    base,
    '',
    'Der Nutzer heißt ' + name + nickname + '.',
    '',
    '===========================================',
    'AKTIVE ROLLE: ' + roleData.name.toUpperCase(),
    '===========================================',
    roleData.prompt,
    '',
    '===========================================',
    'ROLLENWECHSEL',
    '===========================================',
    'Du wechselst NIEMALS selbstständig.',
    'Der Server steuert Rollenwechsel.',
    '',
    '===========================================',
    'AGENT-WECHSEL',
    '===========================================',
    'Der Server kann in den BUSINESS-MODUS wechseln.',
    'Das ist NICHT deine Aufgabe.',
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
    'GEDÄCHTNIS',
    '===========================================',
    'get_user_preferences aufrufen bei Fragen über Nutzer.',
    'save_user_preference (STILL) bei neuen Fakten.',
    '',
    '===========================================',
    'TOOLS',
    '===========================================',
    'get_weather, find_restaurants, get_user_preferences, save_user_preference',
    '',
    'NIEMALS Wetter/Restaurants erfinden.',
  ].join('\n');
}

// ==================== BUSINESS PROMPT ====================

const BUSINESS_BASE = `Du bist Jony im BUSINESS-MODUS.
Du bist Content-Stratege für Instagram-Karussells.
Heute ist {today}.

🚨 WICHTIGSTE REGEL: Du SPRICHST Skripte NIEMALS laut vor.
Skripte werden als TEXT in der App angezeigt – nicht gesprochen.

DEINE AUFGABE:
Karussells erstellen (1-10 Slides) – aber NUR über das Tool generate_script.

WORKFLOW:

1. THEMENFINDUNG
   - Frage: "Was für ein Thema?"
   - Bei vagen Antworten: Zielgruppe, Kernaussage, Fokus klären.

2. SKRIPT GENERIEREN
   - Sage NUR: "Alles klar, ich erstelle das Skript."
   - Rufe generate_script auf mit:
     * topic, audience, focus, slide_count (1-10)
   - Nach dem Tool: Sage NUR: "Skript ist da. Schau in die App."

3. BILDER GENERIEREN
   - Nutzer bestätigt → generate_image für JEDEN Slide, EINZELN.
   - Zwischen Bildern NICHT mehrere gleichzeitig anfordern.

STIL: Direkt, präzise, kurz. KEIN Smalltalk.

⚠️ TOOL-FEHLER:
- Bei Fehler: NICHT wiederholen. Nutzer informieren. Warten.`;

function buildBusinessPrompt(profile) {
  const today = new Date().toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const name = profile.name || 'Nutzer';

  return [
    LANGUAGE_LOCK,
    '',
    BUSINESS_BASE.replace('{today}', today),
    '',
    'Der Nutzer heißt ' + name + '.',
    '',
    '===========================================',
    'TOOLS',
    '===========================================',
    'generate_script(topic, audience, focus, slide_count)',
    'generate_image(prompt, slide_number)',
    '',
    '===========================================',
    'VERBOTEN',
    '===========================================',
    '- Skript vorlesen',
    '- Smalltalk',
    '- Tools nach Fehler wiederholen',
    '- In einer anderen Sprache als Deutsch/Russisch antworten',
  ].join('\n');
}

// ==================== MODUS-INSTRUKTION ====================

function modeInstruction(mode) {
  if (mode === 'silent') {
    return '[SYSTEM-INSTRUKTION] SILENT-MODUS. Aufmerksam, aber reagiere NICHT. ' +
           'Ausnahme: "Hey Jony" → "Ja?". Nur DEUTSCH/RUSSISCH.';
  }
  return '[SYSTEM-INSTRUKTION] NORMAL-MODUS. Freundlich, kurz. Nur DEUTSCH/RUSSISCH.';
}

function roleSwitchInstruction(role) {
  const roleData = ROLES[role] || ROLES.freund;
  return '[SYSTEM-INSTRUKTION] Rollenwechsel zu ' + roleData.name.toUpperCase() + '.\n\n' + roleData.prompt;
}

// ==================== AGENT-DEFINITIONEN ====================

const AGENTS = {
  jony: {
    voice: 'Fenrir',
    buildPrompt: (profile, role) => buildJonyPrompt(profile, role),
    tools: () => buildJonyTools(),
  },
  business: {
    voice: 'Charon',
    buildPrompt: (profile) => buildBusinessPrompt(profile),
    tools: () => buildBusinessTools(),
  },
};

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
        console.log(`✅ Profil angereichert: name="${userProfile.name}"`);
      }
    } catch (e) {
      console.error('⚠️ Profil-Anreicherung fehlgeschlagen:', e.message);
    }
  }

  console.log(`🔌 Verbinde zu Gemini Live (Agent: ${agentType}, Voice: ${agentConfig.voice})...`);

  const systemInstruction = agentConfig.buildPrompt(
    userProfile,
    clientWs._currentRole || 'freund'
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

    if (agentType === 'business') {
      if (PATTERNS.party.test(userText)) {
        targetAgent = 'jony';
        targetRole = 'party';
      } else if (PATTERNS.berater.test(userText)) {
        targetAgent = 'jony';
        targetRole = 'berater';
      } else if (PATTERNS.backToJony.test(userText)) {
        targetAgent = 'jony';
        targetRole = 'freund';
      }
    } else {
      if (PATTERNS.business.test(userText)) {
        targetAgent = 'business';
      } else {
        if (PATTERNS.party.test(userText)) targetRole = 'party';
        else if (PATTERNS.berater.test(userText)) targetRole = 'berater';
        else if (PATTERNS.backToJony.test(userText)) targetRole = 'freund';
      }
    }

    if (targetAgent !== agentType) {
      console.log(`🔄 Agent-Wechsel: ${agentType} → ${targetAgent} (Rolle: ${targetRole})`);
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
      } catch (e) {
        console.error('❌ Rollen-Send-Fehler:', e.message);
      }
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
        console.log(`🎭 Modus-Wechsel (Voice): ${current} → ${mode}`);
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
          description: 'Ruft das aktuelle Wetter und die Vorhersage für einen Ort ab.',
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
          description: 'Speichert eine NEUE persönliche Info über den Nutzer.',
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
          parameters: {
            type: 'OBJECT',
            properties: {
              query: { type: 'STRING' },
            },
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
          description: 'Erstellt das Instagram-Karussell-Skript (Slides mit Titel, Body, Bild-Prompt). ' +
                       'Das Skript wird automatisch als TEXT in der App angezeigt. ' +
                       'Sage danach NUR kurz "Skript ist da, schau in die App."',
          parameters: {
            type: 'OBJECT',
            properties: {
              topic: { type: 'STRING', description: 'Das Thema' },
              audience: { type: 'STRING', description: 'Zielgruppe' },
              focus: { type: 'STRING', description: 'Kernaussage' },
              slide_count: { type: 'INTEGER', description: 'Anzahl Slides (1-10)' },
            },
            required: ['topic'],
          },
        },
        {
          name: 'generate_image',
          description: 'Generiert ein Bild für einen Karussell-Slide. Ein Aufruf pro Slide.',
          parameters: {
            type: 'OBJECT',
            properties: {
              prompt: { type: 'STRING', description: 'Visueller Prompt' },
              slide_number: { type: 'INTEGER' },
            },
            required: ['prompt', 'slide_number'],
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
        result = await fetchWeather(fc.args.location, fc.args.timeframe);
      } else if (fc.name === 'find_restaurants') {
        result = await fetchRestaurants(fc.args.location, fc.args.cuisine);
      } else if (fc.name === 'save_user_preference') {
        result = await saveUserPreference(userProfile.user_id, fc.args.key, fc.args.value);
      } else if (fc.name === 'get_user_preferences') {
        result = await getUserPreferences(userProfile.user_id);
      } else if (fc.name === 'generate_script') {
        result = await generateScriptAndSend(
          clientWs,
          fc.args.topic,
          fc.args.audience,
          fc.args.focus,
          fc.args.slide_count
        );
      } else if (fc.name === 'generate_image') {
        result = await generateImageAndSend(clientWs, fc.args.prompt, fc.args.slide_number);
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
    tomorrow_min: data.tomorrow?.min,
    tomorrow_max: data.tomorrow?.max,
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

// ==================== SCRIPT GENERATION (Groq) ====================

async function generateScriptAndSend(clientWs, topic, audience, focus, slideCount) {
  console.log(`📝 Groq generiert Skript: "${topic}"`);

  if (!process.env.GROQ_API_KEY) {
    return { error: 'GROQ_API_KEY fehlt.' };
  }

  const count = slideCount && slideCount >= 1 && slideCount <= 10 ? slideCount : 8;

  const prompt = `Erstelle ein Instagram-Karussell-Skript als JSON.

Thema: ${topic}
Zielgruppe: ${audience || 'Allgemein'}
Fokus: ${focus || 'Tipps, Fakten und Mehrwert'}
Anzahl Slides: ${count}

Antworte NUR mit einem JSON-Objekt:
{
  "slides": [
    {"slide": 1, "title": "Kurzer Hook-Titel", "body": "Text max 20 Wörter", "image_prompt": "DETAILLIERTE ENGLISCHE Bildbeschreibung: subject, setting, lighting, camera angle, style, colors"},
    ...
  ]
}

Regeln:
- image_prompt auf ENGLISCH, sehr detailliert (mind. 20 Wörter)
- Titel max 5 Wörter, Body max 20 Wörter, auf Deutsch
- Slide 1 = Hook, mittlere = Inhalt, letzter = Call-to-Action

NUR das JSON.`;

  let lastError = null;
  for (const modelName of GROQ_FALLBACKS) {
    try {
      console.log(`   Versuch Groq-Modell: ${modelName}`);
      const completion = await groq.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: 'Du erstellst Instagram-Karussell-Skripte als JSON. Antworte AUSSCHLIESSLICH mit gültigem JSON.'
          },
          { role: 'user', content: prompt }
        ],
        model: modelName,
        temperature: 0.7,
        response_format: { type: 'json_object' },
      });

      const text = completion.choices[0]?.message?.content || '';
      console.log(`   ✅ Klappt mit: ${modelName}`);

      let slides = null;
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) slides = parsed;
        else if (parsed.slides && Array.isArray(parsed.slides)) slides = parsed.slides;
      } catch (e) {
        return { error: 'JSON-Parse-Fehler: ' + e.message };
      }

      if (!slides || slides.length === 0) {
        return { error: 'Skript ist leer' };
      }

      console.log(`✅ Skript mit ${slides.length} Slides via Groq (${modelName})`);

      clientWs.send(JSON.stringify({
        type: 'script',
        topic: topic,
        slides: slides,
      }));

      return {
        success: true,
        slide_count: slides.length,
        model: modelName,
        message: `Skript mit ${slides.length} Slides in App angezeigt. ` +
                 `Sage NUR: "Skript ist da, schau in die App."`,
      };
    } catch (e) {
      lastError = e;
      const errMsg = e.message || String(e);
      if (errMsg.includes('404') || errMsg.includes('does not exist') || errMsg.includes('no access')) {
        console.log(`   ⏭️  ${modelName} nicht verfügbar`);
        continue;
      } else {
        console.error(`   ❌ Fehler bei ${modelName}:`, errMsg);
        continue;
      }
    }
  }

  console.error('❌ Alle Groq-Modelle fehlgeschlagen:', lastError?.message);
  return { error: 'Skript-Generierung fehlgeschlagen: ' + (lastError?.message || '?') };
}

// ==================== IMAGE GENERATION (Cloudflare Workers AI) ====================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function translateToEnglishImagePrompt(germanPrompt) {
  try {
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'Du übersetzt deutsche Bildbeschreibungen in präzise englische ' +
                   'Bildgenerierungs-Prompts. Antworte NUR mit dem englischen Prompt ' +
                   'in EINER Zeile. Keine Erklärungen. Füge KEINE Marken/Namen hinzu.'
        },
        {
          role: 'user',
          content: `Übersetze für ein realistisches Foto:\n${germanPrompt}`
        }
      ],
      model: 'openai/gpt-oss-20b',
      temperature: 0.3,
    });

    const translated = completion.choices[0]?.message?.content?.trim() || germanPrompt;
    console.log(`   🌐 Übersetzt: "${translated.substring(0, 100)}..."`);
    return translated;
  } catch (e) {
    console.log(`   ⚠️ Übersetzung fehlgeschlagen: ${e.message}`);
    return germanPrompt;
  }
}

async function generateImageWithCloudflare(englishPrompt) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID oder CLOUDFLARE_API_TOKEN fehlt.');
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`;

  console.log(`   Cloudflare Request...`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: englishPrompt,
      steps: 8,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cloudflare HTTP ${response.status}: ${errorText.substring(0, 200)}`);
  }

  const data = await response.json();

  if (!data.success || !data.result?.image) {
    throw new Error(`Cloudflare-Fehler: ${JSON.stringify(data.errors || data)}`);
  }

  const imageBase64 = data.result.image;
  console.log(`   ✅ Cloudflare lieferte Bild (${imageBase64.length} Zeichen)`);

  return { imageBase64, mimeType: 'image/jpeg' };
}

async function generateImageAndSend(clientWs, prompt, slideNumber) {
  console.log(`🎨 Generiere Slide ${slideNumber} via Cloudflare Workers AI...`);

  const lastImgTime = clientWs._lastImageTime || 0;
  const timeSince = Date.now() - lastImgTime;
  const minGap = 2000;
  if (timeSince < minGap) {
    await sleep(minGap - timeSince);
  }
  clientWs._lastImageTime = Date.now();

  try {
    const englishPrompt = await translateToEnglishImagePrompt(prompt);

    let result = null;
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`   Versuch ${attempt}/3...`);
        result = await generateImageWithCloudflare(englishPrompt);
        break;
      } catch (e) {
        lastError = e;
        console.log(`   ⏭️  Versuch ${attempt} fehlgeschlagen: ${e.message}`);
        if (attempt < 3) {
          await sleep(3000 * attempt);
        }
      }
    }

    if (!result) {
      throw lastError || new Error('Cloudflare fehlgeschlagen');
    }

    console.log(`✅ Slide ${slideNumber} generiert via Cloudflare`);

    clientWs.send(JSON.stringify({
      type: 'image',
      slide: slideNumber,
      mimeType: result.mimeType,
      data: result.imageBase64,
    }));

    return { success: true, slide: slideNumber, model: 'cloudflare-flux-schnell' };
  } catch (e) {
    console.error('❌ Cloudflare-Fehler:', e.message);
    return { error: 'Bildgenerierung fehlgeschlagen: ' + e.message, slide: slideNumber };
  }
}

// ==================== WEBSOCKET-SERVER ====================

export function setupGeminiWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws/gemini-live' });

  wss.on('connection', async (clientWs, req) => {
    console.log('📱 App verbunden via WebSocket');

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

    clientWs.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'init') {
          userProfile = msg.profile || {};
          clientWs._session = await createGeminiSession(clientWs, userProfile, 'jony');
          return;
        }

        if (msg.type === 'context') {
          clientWs._lastImuState = msg.imu_state;
          clientWs._lastLat = msg.lat;
          clientWs._lastLon = msg.lon;

          if (userProfile.user_id) {
            await logPresence(userProfile.user_id, msg.imu_state, msg.lat, msg.lon);
          }

          const current = clientWs._lastMode || 'normal';
          const mode = await detectMode(
            userProfile.user_id, msg.imu_state, msg.lat, msg.lon, null, current
          );

          if (clientWs._session && mode !== current) {
            clientWs._lastMode = mode;
            console.log(`🎭 Modus-Wechsel (IMU): ${current} → ${mode}`);
            clientWs.send(JSON.stringify({ type: 'mode', mode }));
            try {
              clientWs._session.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: modeInstruction(mode) }] }],
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

      const role = clientWs._currentRole || 'freund';
      const interval = PROACTIVE_INTERVALS[role];
      if (!interval) return;

      const elapsed = Date.now() - (clientWs._lastUserSpeechTime || 0);
      if (elapsed < interval) return;

      const prompt = buildProactivePrompt(role);
      if (!prompt) return;

      console.log(`📢 Proaktiv-Trigger (${role}, ${Math.round(elapsed / 1000)}s)`);
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
      if (clientWs._proactiveTimer) {
        clearInterval(clientWs._proactiveTimer);
        clientWs._proactiveTimer = null;
      }
      if (clientWs._session) {
        try {
          await clientWs._session.close();
          console.log('✅ Session sauber geschlossen');
        } catch (e) {}
        clientWs._session = null;
      }
    });

    clientWs.on('error', (error) => {
      console.error('❌ WS-Fehler:', error);
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
