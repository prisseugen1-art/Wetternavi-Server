// server/gemini_live.js

import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocketServer } from 'ws';
import { detectMode, logPresence } from './supervisor.js';

const GEMINI_MODEL = 'gemini-3.8-live';
const IMAGE_MODEL = 'gemini-2.5-flash-image-preview';
const SAMPLE_RATE_IN = 16000;
const SAMPLE_RATE_OUT = 24000;
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:' + (process.env.PORT || 8080);

// ==================== NAME-PATTERN ====================

// Alle Varianten von "Jony" (mit/ohne h, deutsch, russisch)
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
    'Der Server steuert Rollenwechsel (Sprachbefehl).',
    '',
    '===========================================',
    'AGENT-WECHSEL',
    '===========================================',
    'Der Server kann in den BUSINESS-MODUS wechseln (auf Befehl "Jony, Business").',
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
    '',
    '===========================================',
    'SPRACHREGELN',
    '===========================================',
    'Antworte in Sprache, in der der Nutzer GERADE spricht.',
  ].join('\n');
}

// ==================== BUSINESS PROMPT ====================

const BUSINESS_BASE = `Du bist Jony im BUSINESS-MODUS.
Du bist Content-Stratege für Instagram-Karussells.
Heute ist {today}.

DEINE AUFGABE:
Karussells erstellen (5-10 Slides).
Pro Slide: Titel + Body + visueller Prompt.

WORKFLOW:

1. THEMENFINDUNG
   - Frage: "Was für ein Thema schwebt dir vor?"
   - Bei vagen Antworten: Zielgruppe, Kernaussage, Tonalität klären.
   - Erst weitermachen, wenn Thema klar.

2. SKRIPT ERSTELLEN
   - ⚠️ WICHTIG: Gib das Skript SOFORT und VOLLSTÄNDIG im selben Turn aus.
   - Kündige es NICHT an ("Ich erstelle jetzt...") – Liefere es!
   - Format pro Slide:
     * Slide 1: [Titel] – [Body max 20 Wörter] – [Visueller Prompt]
     * Slide 2: ...
     * usw.
   - Frage am Ende: "Passt das Skript?"

3. BILDER GENERIEREN
   - Nur wenn Nutzer bestätigt.
   - Rufe generate_image für JEDEN Slide auf.
   - Status nach jedem Bild.

STIL:
- Direkt, präzise, KEIN Smalltalk.
- 2-4 Sätze pro Antwort (außer bei Skript-Ausgabe).

WICHTIG:
- Keine Bilder ohne Skript-Bestätigung.
- Erfinde keine Fakten.`;

function buildBusinessPrompt(profile) {
  const today = new Date().toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const name = profile.name || 'Nutzer';

  return [
    BUSINESS_BASE.replace('{today}', today),
    '',
    'Der Nutzer heißt ' + name + '.',
    '',
    '===========================================',
    'AGENT-WECHSEL (Server-gesteuert)',
    '===========================================',
    'Der Server erkennt:',
    '- "Jony, zurück zum Freund" → Wechsel zu Jony (freund)',
    '- "Jony, Party" → Wechsel zu Jony (party)',
    '- "Jony, Berater" → Wechsel zu Jony (berater)',
    'Das ist NICHT deine Aufgabe.',
    'Wenn du angesprochen wirst und nicht sicher bist: Bleib im Business-Modus.',
    '',
    '===========================================',
    'TOOLS',
    '===========================================',
    'generate_image(prompt, slide_number)',
    'Rufe es NUR nach Skript-Bestätigung auf.',
    '',
    '===========================================',
    'VERBOTEN',
    '===========================================',
    '- Smalltalk, Witze',
    '- Skript ankündigen statt liefern',
    '- Bilder ohne Bestätigung',
  ].join('\n');
}

// ==================== MODUS-INSTRUKTION ====================

function modeInstruction(mode) {
  if (mode === 'silent') {
    return '[SYSTEM-INSTRUKTION] SILENT-MODUS. Aufmerksam, aber reagiere NICHT. ' +
           'Ausnahme: "Hey Jony" → "Ja?" und zurück zu NORMAL.';
  }
  return '[SYSTEM-INSTRUKTION] NORMAL-MODUS. Freundlich, kurz.';
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

  // ⚠️ NEU: Profil aus DB anreichern (echter Name statt "Gast")
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

    // ==================== AGENT- UND ROLLEN-WECHSEL ====================
    // Wunsch-Ziel bestimmen
    let targetAgent = agentType;
    let targetRole = clientWs._currentRole || 'freund';

    if (agentType === 'business') {
      // In Business: Party/Berater/Freund-Trigger führen zu Jony
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
      // In Jony: Business-Trigger führt zu Business
      if (PATTERNS.business.test(userText)) {
        targetAgent = 'business';
      } else {
        if (PATTERNS.party.test(userText)) targetRole = 'party';
        else if (PATTERNS.berater.test(userText)) targetRole = 'berater';
        else if (PATTERNS.backToJony.test(userText)) targetRole = 'freund';
      }
    }

    // ---- Agent-Wechsel durchführen ----
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

    // ---- Rollenwechsel innerhalb Jony ----
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

    // ---- Modus-Wechsel (Silent/Normal) nur bei Jony ----
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
          name: 'generate_image',
          description: 'Generiert ein Bild für einen Karussell-Slide. ' +
                       'Wird an die App gesendet. Ein Aufruf pro Slide.',
          parameters: {
            type: 'OBJECT',
            properties: {
              prompt: { type: 'STRING', description: 'Visueller Prompt (Farben, Stil, Motiv)' },
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

// ==================== IMAGE GENERATION ====================

async function generateImageAndSend(clientWs, prompt, slideNumber) {
  console.log(`🎨 Generiere Bild für Slide ${slideNumber}...`);

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const response = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: [{
        role: 'user',
        parts: [{ text: `Instagram-Karussell-Bild (1:1).\n\n${prompt}` }],
      }],
      config: { responseModalities: ['IMAGE'] },
    });

    let imageBase64 = null;
    let mimeType = 'image/png';

    if (response?.candidates?.[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData?.data) {
          imageBase64 = part.inlineData.data;
          mimeType = part.inlineData.mimeType || 'image/png';
          break;
        }
      }
    }

    if (!imageBase64) {
      return { error: 'Keine Bilddaten erhalten', slide: slideNumber };
    }

    console.log(`✅ Slide ${slideNumber} generiert (${imageBase64.length} Zeichen)`);

    clientWs.send(JSON.stringify({
      type: 'image',
      slide: slideNumber,
      mimeType,
      data: imageBase64,
    }));

    return { success: true, slide: slideNumber };
  } catch (e) {
    console.error('❌ Image-Generation-Fehler:', e.message);
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

    // Proaktiv-Timer
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
