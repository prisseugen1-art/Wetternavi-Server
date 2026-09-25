// server/gemini_live.js

import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import { detectMode, logPresence } from './supervisor.js';

const GEMINI_MODEL = 'gemini-3.8-live';
const GROQ_MODEL = 'llama-3.3-70b-versatile';   // oder 'llama-3.1-8b-instant' (schneller, günstiger)
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

🚨 WICHTIGSTE REGEL: Du SPRICHST Skripte NIEMALS laut vor.
Skripte werden als TEXT in der App angezeigt – nicht gesprochen.
Deine Stimme nutzt du nur für KURZE Ansagen (max 1-2 Sätze).

DEINE AUFGABE:
Karussells erstellen (1-10 Slides) – aber NUR über das Tool generate_script.
Du LIEST NICHTS vor. Du SPRICHST NICHTS vom Skript.
Du SCHREIBST NICHTS vom Skript-Inhalt in deine Antwort.

WORKFLOW:

1. THEMENFINDUNG (Gespräch)
   - Frage: "Was für ein Thema?"
   - Bei vagen Antworten: Zielgruppe, Kernaussage, Fokus klären.
   - Wenn klar: Weiter zu Schritt 2.

2. SKRIPT GENERIEREN
   - Sage NUR: "Alles klar, ich erstelle das Skript."
   - Rufe SOFORT generate_script auf mit:
     * topic: das Thema
     * audience: Zielgruppe
     * focus: Kernaussage
     * slide_count: 1-10 (Standard 8)
   - Das Tool liefert das Skript direkt an die App.
   - Nach dem Tool: Sage NUR: "Skript ist da. Schau in die App."
   - ⚠️ DU NIMMST DEN SKRIPT-INHALT NICHT IN DEINE ANTWORT AUF.
   - ⚠️ KEIN "Slide 1: ... Slide 2: ..." in deiner Antwort.

3. ITERATION
   - Nutzer sagt "Slide 3 gefällt nicht" → Frag was geändert werden soll
   - Nutzer bestätigt Skript → Nutzer sagt "generier die Bilder"
   - Dann: Rufe generate_image für JEDEN Slide auf (einzeln, nacheinander)

STIL:
- Direkt, präzise, kurz.
- 1-2 Sätze pro Antwort.
- KEIN Smalltalk, keine Witze.

⚠️ WICHTIG bei Tool-Fehlern:
- Wenn generate_script oder generate_image einen Fehler liefert:
  * Rufe es NICHT erneut auf.
  * Sage dem Nutzer: "Es gibt ein technisches Problem. Bitte später nochmal versuchen."
  * Warte auf eine neue Anweisung des Nutzers.

VERBOTEN:
- Skript vorlesen
- Skript-Inhalt in Antwort ausgeben
- Slides einzeln aufzählen
- Bilder ohne Skript-Bestätigung generieren
- Mehr als 2 Sätze pro Antwort
- Tools mehrfach hintereinander aufrufen wenn Fehler`;

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
    '',
    '===========================================',
    'TOOLS',
    '===========================================',
    'generate_script(topic, audience, focus, slide_count)',
    '  → Erstellt das Skript und zeigt es in der App (NICHT sprechen!)',
    '',
    'generate_image(prompt, slide_number)',
    '  → Generiert ein Bild für einen Slide. Nur nach Skript-Bestätigung.',
    '',
    '===========================================',
    'VERBOTEN',
    '===========================================',
    '- Smalltalk, Witze, lockere Sprache',
    '- Skript vorlesen oder in Antwort ausgeben',
    '- Slides einzeln aufzählen',
    '- Bilder ohne Bestätigung',
    '- Tools nach Fehler wiederholen',
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

  // Profil aus DB anreichern
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
          name: 'generate_script',
          description: 'Erstellt das Instagram-Karussell-Skript (Slides mit Titel, Body, Bild-Prompt). ' +
                       'Das Skript wird automatisch als TEXT in der App angezeigt. ' +
                       'Rufe dieses Tool NUR auf, wenn das Thema klar ist. ' +
                       'Sage danach NUR kurz "Skript ist da, schau in die App." und NIEMALS den Inhalt.',
          parameters: {
            type: 'OBJECT',
            properties: {
              topic: { type: 'STRING', description: 'Das Thema, z.B. "Angeln"' },
              audience: { type: 'STRING', description: 'Zielgruppe, z.B. "Anfänger"' },
              focus: { type: 'STRING', description: 'Kernaussage' },
              slide_count: { type: 'INTEGER', description: 'Anzahl Slides (1-10). Standard: 8.' },
            },
            required: ['topic'],
          },
        },
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

// ==================== SCRIPT GENERATION (Groq – kostenlos) ====================

async function generateScriptAndSend(clientWs, topic, audience, focus, slideCount) {
  console.log(`📝 Groq generiert Skript: "${topic}" (Zielgruppe: ${audience || '-'}, Fokus: ${focus || '-'})`);

  if (!process.env.GROQ_API_KEY) {
    console.error('❌ GROQ_API_KEY fehlt!');
    return { error: 'GROQ_API_KEY ist nicht konfiguriert.' };
  }

  const count = slideCount && slideCount >= 1 && slideCount <= 10 ? slideCount : 8;

  const prompt = `Erstelle ein Instagram-Karussell-Skript als JSON.

Thema: ${topic}
Zielgruppe: ${audience || 'Allgemein'}
Fokus: ${focus || 'Tipps, Fakten und Mehrwert'}
Anzahl Slides: ${count}

Antworte NUR mit einem JSON-Objekt in diesem Format:
{
  "slides": [
    {"slide": 1, "title": "Kurzer Hook-Titel", "body": "Erklärender Text (max 20 Wörter)", "image_prompt": "Bildbeschreibung mit Stil, Farben, Motiv"},
    {"slide": 2, "title": "...", "body": "...", "image_prompt": "..."}
  ]
}

Regeln:
- Slide 1: Hook (neugierig machend)
- Slides 2-${count - 1}: Kerninhalt
- Slide ${count}: Call-to-Action
- Titel: max 5 Wörter
- Body: max 20 Wörter
- image_prompt: 1-2 Sätze, beschreibt Motiv, Stil, Farben, Stimmung
- Sprache: Deutsch

NUR das JSON, sonst nichts.`;

  try {
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'Du bist ein Assistent, der Instagram-Karussell-Skripte als JSON erstellt. Antworte ausschließlich mit gültigem JSON.'
        },
        { role: 'user', content: prompt }
      ],
      model: GROQ_MODEL,
      temperature: 0.7,
      response_format: { type: 'json_object' },
    });

    const text = completion.choices[0]?.message?.content || '';
    console.log(`   Groq Antwort (${text.length} Zeichen):`, text.substring(0, 150) + '...');

    // JSON extrahieren
    let slides = null;
    try {
      const parsed = JSON.parse(text);
      // Kann entweder {slides: [...]} oder direkt [...] sein
      if (Array.isArray(parsed)) {
        slides = parsed;
      } else if (parsed.slides && Array.isArray(parsed.slides)) {
        slides = parsed.slides;
      }
    } catch (e) {
      console.error('❌ JSON-Parse-Fehler:', e.message);
      console.error('   Text war:', text.substring(0, 300));
      return { error: 'Skript-JSON konnte nicht geparst werden' };
    }

    if (!slides || slides.length === 0) {
      return { error: 'Skript ist leer oder ungültig' };
    }

    console.log(`✅ Skript mit ${slides.length} Slides via Groq (${GROQ_MODEL})`);

    // An App senden
    clientWs.send(JSON.stringify({
      type: 'script',
      topic: topic,
      slides: slides,
    }));

    return {
      success: true,
      slide_count: slides.length,
      model: GROQ_MODEL,
      message: `Skript mit ${slides.length} Slides erstellt und in App angezeigt. ` +
               `Sage dem Nutzer NUR: "Skript ist da, schau in die App." ` +
               `Wiederhole NIEMALS den Inhalt.`,
    };
  } catch (e) {
    console.error('❌ Groq-Fehler:', e.message);
    return { error: 'Skript-Generierung fehlgeschlagen: ' + e.message };
  }
}

// ==================== IMAGE GENERATION (Pollinations.AI – kostenlos) ====================

async function generateImageAndSend(clientWs, prompt, slideNumber) {
  console.log(`🎨 Pollinations.AI generiert Bild für Slide ${slideNumber}...`);

  try {
    // Prompt URL-kodieren + anreichern für bessere Qualität
    const enhancedPrompt = `${prompt}. Instagram carousel slide, high quality, professional photography, sharp focus, vibrant colors`;
    const encodedPrompt = encodeURIComponent(enhancedPrompt);

    // Pollinations.AI URL
    // Model: flux (beste Qualität), width/height 1024 (1:1), nologo=true (kein Wasserzeichen)
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?model=flux&width=1024&height=1024&nologo=true&enhance=true`;

    console.log(`   URL: ${imageUrl.substring(0, 120)}...`);

    // Bild abrufen (kann 10-30 Sek dauern bei Pollinations)
    const response = await fetch(imageUrl);

    if (!response.ok) {
      throw new Error(`Pollinations HTTP ${response.status}`);
    }

    // Bild als Buffer holen
    const arrayBuffer = await response.arrayBuffer();
    const imageBase64 = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = response.headers.get('content-type') || 'image/jpeg';

    if (!imageBase64 || imageBase64.length < 1000) {
      return { error: 'Pollinations lieferte kein gültiges Bild', slide: slideNumber };
    }

    console.log(`✅ Slide ${slideNumber} generiert (${imageBase64.length} Zeichen, ${mimeType})`);

    // An App senden
    clientWs.send(JSON.stringify({
      type: 'image',
      slide: slideNumber,
      mimeType,
      data: imageBase64,
    }));

    return { success: true, slide: slideNumber, model: 'pollinations-flux' };
  } catch (e) {
    console.error('❌ Pollinations-Fehler:', e.message);
    return {
      error: 'Bildgenerierung fehlgeschlagen: ' + e.message,
      slide: slideNumber,
    };
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
