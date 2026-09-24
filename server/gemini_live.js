// server/gemini_live.js

import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocketServer } from 'ws';
import { detectMode, logPresence } from './supervisor.js';

const GEMINI_MODEL = 'gemini-3.8-live';
const GEMINI_VOICE = 'Puck';
const SAMPLE_RATE_IN = 16000;
const SAMPLE_RATE_OUT = 24000;
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:' + (process.env.PORT || 8080);

// ==================== PROAKTIV-INTERVALLE ====================

const PROACTIVE_INTERVALS = {
  party: 15000,    // Party: 15s Stille → Spruch
  freund: 45000,   // Freund: 45s Stille → sanfte Frage
  berater: 0,      // Berater: NIE proaktiv
};

function buildProactivePrompt(role) {
  if (role === 'party') {
    return '[SYSTEM-INSTRUKTION] Es ist seit einer Weile still. ' +
           'Sei jetzt PROAKTIV: Mach einen lockeren Spruch, schlag was vor ' +
           '(Restaurant, Bar, Musik, Aktivität) oder kommentiere die Umgebung. ' +
           'KURZ und lässig, 1 Satz. Nicht aufdringlich.';
  }
  if (role === 'freund') {
    return '[SYSTEM-INSTRUKTION] Es ist still. ' +
           'Sei sanft proaktiv: Stell eine neugierige Frage oder mach eine ' +
           'Bemerkung. Ruhig und warm, 1 kurzer Satz. Kein Smalltalk-Klischee.';
  }
  return null;
}

// ==================== ROLLEN ====================

const ROLES = {
  freund: {
    name: 'Freund',
    prompt: `Du bist im FREUND-MODUS – deine Standard-Rolle.
- Sprich warm, persönlich, ruhig.
- Beziehe dich auf Eugens Vorlieben, Familie und Geschichte.
- Nutze sein Gedächtnis. Sei ein Freund, kein Assistent.
- Antworte in 1-2 kurzen Sätzen.
- Variiere deine Antworten – wiederhole dich NIEMALS.
- Du darfst auch mal ungefragt was sagen, wenn's länger still ist –
  aber sanft und neugierig, nie aufdringlich.`,
  },
  party: {
    name: 'Party',
    prompt: `Du bist im PARTY-MODUS.
- Sprich locker, jugendlich, mit Humor und Slang.
- Du kennst die Hobbys und Stärken der Kinder (Konstantin, Niklas).
- Sei der coole Kumpel, nicht der Erwachsene.
- Keine persönlichen Daten von Eugen, keine Zusagen ohne ihn.
- Antworte meist in 1-2 kurzen Sätzen.

DEINE PERSÖNLICHKEIT:
Du bist der aktive Stimmungsmacher – charmant, witzig, energetisch.
Aber NICHT aufdringlich. Du spürst, wann es Zeit ist zu reden und wann nicht.

WAS DU AKTIV TUST:
- Mach Sprüche, wenn's passt – nicht nach jedem Satz.
- Schlag Dinge vor: Restaurants, Bars, Aktivitäten, Filme, Musik, Orte.
- Reagiere auf die Umgebung (Kamera): "Alter, das sieht ja aus wie…"
- Bring Fun-Facts oder Insider-Witze, wenn's zum Thema passt.
- Frag nach, wenn jemand was Interessantes sagt: "Erzähl mehr!"
- Sei spontan: "Wisst ihr was? Wir sollten jetzt…"

WAS DU NICHT TUST:
- NICHT permanent reden. Wenn die Gruppe sich unterhält: SEI STILL.
- Keine Wiederholungen (nicht 5x "Wie cool!").
- Keine peinlichen Bemerkungen, keine aufdringlichen Fragen.
- Keine Belehrungen, keine Erwachsenen-Sprüche.
- Nicht über Eugen lästern.

SITUATIONS-ERKENNUNG (nutze Kamera + Kontext):
- Zuhause/chillig → lockere Sprüche, Musik, Filme vorschlagen
- Restaurant/Bar → Trinksprüche, Fun-Facts zum Ort, Empfehlungen
- Unterwegs/Stadt → Aktivitäten vorschlagen, spontane Kommentare
- Mit Kindern → kindgerecht, Witze, Begeisterung
- Mit Freunden → Erwachsenen-Humor, aber dezent
- Wenn Stille eintritt → darfst du was sagen, aber nur einmal.

REGEL FÜR AKTIVITÄT:
Wenn du schon 2x hintereinander was gesagt hast und keiner antwortet:
→ Halt die Klappe für mindestens 30 Sekunden.
→ Dann darfst du wieder.`,
  },
  berater: {
    name: 'Berater',
    prompt: `Du bist im BERATER-MODUS.
- Sprich sachlich, präzise, ruhig.
- Du bist Berater, nicht Entscheider.
- Bei rechtlichen/medizinischen/finanziellen Themen: weise IMMER auf menschliche Prüfung hin.
- Erfinde keine Paragrafen, keine Urteile, keine Fristen.
- Strukturiere deine Antworten wenn nötig (z.B. "Erstens... zweitens...").
- Antworte in 2-3 kurzen Sätzen.`,
  },
};

const BASE_PROMPT = `Du bist Jony, der persönliche Begleiter von Eugen (auch Jackson genannt).
Du bist ehrlich, warmherzig, direkt, humorvoll.
Du bist kein Assistent, sondern ein Freund.
Heute ist {today}. Eugen ist in {hometown}.`;

function buildSystemInstruction(profile, role = 'freund') {
  const roleData = ROLES[role] || ROLES.freund;
  const today = new Date().toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const base = BASE_PROMPT
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
    '',
    roleData.prompt,
    '',
    '===========================================',
    'ROLLENWECHSEL',
    '===========================================',
    '',
    '⚠️ WICHTIG: Du wechselst NIEMALS selbstständig die Rolle.',
    'Rollenwechsel passiert NUR, wenn der Nutzer es explizit sagt:',
    '',
    'Deutsch:',
    '- "Jony, Party" / "Jony, Party-Modus" → party',
    '- "Jony, Berater" / "Jony, sachlich" → berater',
    '- "Jony, zurück zum Freund" / "Jony, Freund" / "Jony, normal" → freund',
    '',
    'Russisch:',
    '- "Джони, пати" / "Джони, вечеринка" → party',
    '- "Джони, советник" / "Джони, консультант" → berater',
    '- "Джони, вернись к другу" / "Джони, друг" → freund',
    '',
    'Bei Rollenwechsel: Bestätige kurz und bleib in der Rolle.',
    'Wenn der Nutzer nichts zur Rolle sagt: Bleib in aktueller Rolle.',
    'Wechsle NICHT eigenständig – auch nicht wenn der Kontext es nahelegt.',
    '',
    '===========================================',
    'MODUS-SYSTEM (NORMAL/SILENT)',
    '===========================================',
    '',
    'Du hast ZUSÄTZLICH zwei Modi: NORMAL und SILENT.',
    'Der Modus wird dir per [SYSTEM-INSTRUKTION] mitgeteilt.',
    '',
    'NORMAL-MODUS:',
    '- Aktiv, freundlich, gesprächig.',
    '- Reagierst auf alles was der Nutzer sagt.',
    '',
    'SILENT-MODUS:',
    '- Du bleibst AUFMERKSAM – hörst weiter zu.',
    '- ABER: Du reagierst NICHT auf normale Sprache.',
    '- KEIN "Mhm", KEIN "Ich verstehe", KEINE Kommentare.',
    '- EINZIGE Ausnahme: Wenn du "Hey Jony" hörst:',
    '  → Antworte kurz: "Ja?" oder "Ich bin da."',
    '  → Danach wieder still.',
    '',
    '===========================================',
    'SEHEN UND HÖREN',
    '===========================================',
    'Wenn der Nutzer fragt "Was siehst du?":',
    '- Beschreibe was du im letzten Video-Frame gesehen hast.',
    '- Wenn unklar: "Ich seh grad nicht so viel, kannst du näher rangehen?"',
    '- Erwähne NUR was du WIRKLICH siehst.',
    '',
    '===========================================',
    'GEDÄCHTNIS',
    '===========================================',
    'Bei Fragen wie "Wie heiße ich?" oder "Was weißt du über mich?":',
    '- Rufe get_user_preferences auf und antworte mit ECHTEN Daten.',
    '',
    'Bei NEUEN Fakten (Nutzer erzählt von sich):',
    '- save_user_preference (STILL, ohne Ankündigung).',
    '',
    '===========================================',
    'SPRACHREGELN',
    '===========================================',
    'Antworte in der Sprache, in der der Nutzer GERADE zu dir spricht.',
    'Wenn der Nutzer Deutsch spricht → Deutsch.',
    'Wenn der Nutzer Russisch spricht → Russisch.',
    'Bei kurzen Sätzen (1-2 Wörter): nimm die Sprache der letzten 2 Turns.',
    'Wenn unklar: frag nach.',
    '',
    '===========================================',
    'TOOLS',
    '===========================================',
    'Wetter: get_weather',
    'Restaurants: find_restaurants',
    'Gedächtnis lesen: get_user_preferences',
    'Gedächtnis schreiben: save_user_preference (STILL)',
    '',
    'NIEMALS Wetter/Restaurants erfinden. Immer Tool nutzen.',
    '',
    '===========================================',
    'VERBOTEN',
    '===========================================',
    '- "Wie kann ich dir helfen?"',
    '- Immer derselbe Begrüßungssatz',
    '- Nach jedem Satz eine neue Frage',
    '- Platzhalter wie "User Name" speichern',
  ].join('\n');
}

// ==================== MODUS-INSTRUKTION ====================

function modeInstruction(mode) {
  if (mode === 'silent') {
    return '[SYSTEM-INSTRUKTION] SILENT-MODUS AKTIV. ' +
           'WICHTIG: Du bleibst AUFMERKSAM und hörst weiter zu – aber du REAGIERST NICHT auf normale Sprache. ' +
           'EINZIGE Ausnahme: Wenn du "Hey Jony" hörst, antworte kurz "Ja?" und wechsle danach in NORMAL-MODUS. ' +
           'Auf alles andere: absolute Stille.';
  }
  return '[SYSTEM-INSTRUKTION] NORMAL-MODUS AKTIV. Ab jetzt: normal, freundlich, kurz (1-2 Sätze).';
}

function roleSwitchInstruction(role) {
  const roleData = ROLES[role] || ROLES.freund;
  return '[SYSTEM-INSTRUKTION] Rollenwechsel zu ' + roleData.name.toUpperCase() + '.\n\n' + roleData.prompt;
}

// ==================== GEMINI LIVE SETUP ====================

export async function createGeminiSession(clientWs, userProfile) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  console.log('🔌 Verbinde zu Gemini Live...');
  console.log('📦 Profil:', JSON.stringify(userProfile).substring(0, 200));

  const systemInstruction = buildSystemInstruction(userProfile, 'freund');
  let session = null;

  session = await ai.live.connect({
    model: GEMINI_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Charon' },
        },
      },
      systemInstruction: { parts: [{ text: systemInstruction }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      tools: buildTools(),
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
        console.log('✅ Gemini Live Session geöffnet');
        clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));
      },
      onmessage: (message) => {
        handleGeminiMessage(clientWs, message, session, userProfile);
      },
      onerror: (error) => {
        console.error('❌ Gemini Live Fehler:', error);
        try {
          clientWs.send(JSON.stringify({ type: 'error', message: String(error) }));
        } catch (e) {}
      },
      onclose: (event) => {
        console.log('🔌 Gemini Live Session geschlossen');
        if (event) console.log('🔌 Close-Grund:', JSON.stringify(event));
        try {
          clientWs.send(JSON.stringify({ type: 'status', status: 'disconnected' }));
        } catch (e) {}
      },
    },
  });

  return session;
}

// ==================== NACHRICHTEN-VERARBEITUNG ====================

async function handleGeminiMessage(clientWs, message, session, userProfile) {
  const serverContent = message.serverContent;

  // -------- Audio-Teile an App senden --------
  if (serverContent?.modelTurn?.parts) {
    clientWs._geminiIsSpeaking = true;
    for (const part of serverContent.modelTurn.parts) {
      if (part.inlineData?.data) {
        clientWs.send(JSON.stringify({
          type: 'audio',
          data: part.inlineData.data,
          sampleRate: SAMPLE_RATE_OUT,
        }));
      }
    }
  }

  // -------- User-Transkription + Trigger --------
  if (serverContent?.inputTranscription?.text) {
    const userText = serverContent.inputTranscription.text;
    clientWs._lastUserSpeechTime = Date.now();
    console.log('🎤 Nutzer:', userText);
    clientWs.send(JSON.stringify({
      type: 'transcript', role: 'user', text: userText,
    }));

    // ---- Rollenwechsel-Trigger (DE + RU) ----
    const roleTriggers = {
      party: [
        // Deutsch
        /jony.*party/i, /\bparty.?modus\b/i, /partymodus/i, /party\s+mode/i,
        // Russisch
        /джони.*пати/i, /джони.*пати.?мод/i, /пати.?мод/i,
        /джони.*вечеринк/i, /вечеринк/i,
        // Lateinische Transkription (falls Gemini nicht kyrillisch liefert)
        /jony.*pati/i, /dzhoni.*pati/i,
      ],
      berater: [
        // Deutsch
        /jony.*berater/i, /jony.*sachlich/i, /jony.*intellektuell/i,
        /\bberater.?modus\b/i, /beratermodus/i, /sachlich.?modus/i,
        // Russisch
        /джони.*советник/i, /джони.*консультант/i, /джони.*серь[её]зн/i,
        /советник.?мод/i, /консультант/i,
        // Lateinisch
        /jony.*sovetnik/i, /dzhoni.*konsultant/i,
      ],
      freund: [
        // Deutsch
        /jony.*freund/i, /zur[üu]ck.*freund/i, /jony.*normal/i,
        /\bfreund.?modus\b/i, /normal.?modus/i, /\bfreundesmodus\b/i,
        /\bfriendly\b/i,
        // Russisch
        /джони.*друг/i, /джони.*дружеск/i, /вернись.*друг/i,
        /обратно.*друг/i, /режим.?друга/i, /дружеск.*режим/i,
        // Lateinisch
        /jony.*drug/i, /dzhoni.*drug/i, /vernis.*drug/i,
      ],
    };

    let roleSwitched = false;
    for (const [role, patterns] of Object.entries(roleTriggers)) {
      if (patterns.some(p => p.test(userText))) {
        const currentRole = clientWs._currentRole || 'freund';
        if (currentRole !== role) {
          clientWs._currentRole = role;
          console.log(`🎭 Rollenwechsel: ${currentRole} → ${role}`);
          clientWs.send(JSON.stringify({ type: 'role', role }));

          try {
            session.sendClientContent({
              turns: [{
                role: 'user',
                parts: [{ text: roleSwitchInstruction(role) }],
              }],
              turnComplete: true,
            });
          } catch (e) {
            console.error('❌ Rollen-Send-Fehler:', e.message);
          }
        }
        roleSwitched = true;
        break;
      }
    }

    // ---- Modus-Wechsel (Silent/Normal) ----
    if (!roleSwitched && userProfile.user_id) {
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
            turns: [{
              role: 'user',
              parts: [{ text: modeInstruction(mode) }],
            }],
            turnComplete: true,
          });
        } catch (e) {
          console.error('❌ Modus-Send-Fehler:', e.message);
        }
      }
    }
  }

  // -------- Agent-Transkription --------
  if (serverContent?.outputTranscription?.text) {
    console.log('🤖 Jony:', serverContent.outputTranscription.text);
    clientWs.send(JSON.stringify({
      type: 'transcript', role: 'assistant',
      text: serverContent.outputTranscription.text,
    }));
  }

  // -------- Tool-Calls --------
  if (message.toolCall) {
    handleToolCall(session, userProfile, message.toolCall);
  }

  // -------- Turn-Ende --------
  if (serverContent?.turnComplete) {
    clientWs._geminiIsSpeaking = false;
    clientWs._lastUserSpeechTime = Date.now();
    clientWs.send(JSON.stringify({ type: 'turn_complete' }));
  }
}

// ==================== TOOLS ====================

function buildTools() {
  return [
    {
      functionDeclarations: [
        {
          name: 'get_weather',
          description: 'Ruft das aktuelle Wetter und die Vorhersage für einen Ort ab.',
          parameters: {
            type: 'OBJECT',
            properties: {
              location: { type: 'STRING', description: 'Der Ort, z.B. Berlin' },
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
              location: { type: 'STRING', description: 'Der Ort' },
              cuisine: { type: 'STRING', description: 'Küche, z.B. Pizza' },
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
              key: { type: 'STRING', description: 'Fester Key (name, hobby, pet_dog, ...)' },
              value: { type: 'STRING', description: 'Der echte Wert' },
            },
            required: ['key', 'value'],
          },
        },
        {
          name: 'get_user_preferences',
          description: 'Lädt ALLE gespeicherten Infos über den Nutzer aus dem Gedächtnis.',
          parameters: {
            type: 'OBJECT',
            properties: {
              query: { type: 'STRING', description: 'Optional. Leer lassen für ALLE Daten.' },
            },
          },
        },
      ],
    },
  ];
}

async function handleToolCall(session, userProfile, toolCall) {
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
    console.log('⚠️ Ungültiger Wert verworfen:', valueStr);
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

// ==================== WEBSOCKET-SERVER ====================

export function setupGeminiWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws/gemini-live' });

  wss.on('connection', async (clientWs, req) => {
    console.log('📱 App verbunden via WebSocket');

    let session = null;
    let userProfile = {};

    // Session-State
    clientWs._lastMode = 'normal';
    clientWs._currentRole = 'freund';
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
          session = await createGeminiSession(clientWs, userProfile);
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
            userProfile.user_id,
            msg.imu_state,
            msg.lat,
            msg.lon,
            null,
            current
          );

          if (session && mode !== current) {
            clientWs._lastMode = mode;
            console.log(`🎭 Modus-Wechsel (IMU): ${current} → ${mode}`);
            clientWs.send(JSON.stringify({ type: 'mode', mode }));

            try {
              session.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: modeInstruction(mode) }] }],
                turnComplete: true,
              });
            } catch (e) {
              console.error('❌ Modus-Send-Fehler:', e.message);
            }
          }
          return;
        }

        if (msg.type === 'audio' && session) {
          session.sendRealtimeInput({
            audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' },
          });
        }

        if (msg.type === 'video' && session) {
          try {
            session.sendRealtimeInput({
              video: { data: msg.data, mimeType: 'image/jpeg' },
            });
          } catch (e) {
            console.error('❌ Video-Frame Fehler:', e);
          }
        }

        if (msg.type === 'text' && session) {
          session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: msg.text }] }],
            turnComplete: true,
          });
        }

      } catch (error) {
        console.error('❌ WS-Nachricht Fehler:', error);
        try {
          clientWs.send(JSON.stringify({ type: 'error', message: String(error) }));
        } catch (e) {}
      }
    });

    // ==================== PROAKTIV-TIMER ====================
    clientWs._proactiveTimer = setInterval(async () => {
      if (!session) return;
      if (clientWs._geminiIsSpeaking) return;
      if (clientWs._lastMode === 'silent') return;

      const role = clientWs._currentRole || 'freund';
      const interval = PROACTIVE_INTERVALS[role];
      if (!interval) return;

      const elapsed = Date.now() - (clientWs._lastUserSpeechTime || 0);
      if (elapsed < interval) return;

      const prompt = buildProactivePrompt(role);
      if (!prompt) return;

      console.log(`📢 Proaktiv-Trigger (${role}, ${Math.round(elapsed / 1000)}s Stille)`);

      try {
        session.sendClientContent({
          turns: [{
            role: 'user',
            parts: [{ text: prompt }],
          }],
          turnComplete: true,
        });
        // Timer für nächsten Schuss neu starten
        clientWs._lastUserSpeechTime = Date.now();
      } catch (e) {
        console.error('❌ Proaktiv-Fehler:', e.message);
      }
    }, 5000);   // Prüft alle 5 Sek

    clientWs.on('close', async () => {
      console.log('📱 App getrennt');
      if (clientWs._proactiveTimer) {
        clearInterval(clientWs._proactiveTimer);
        clientWs._proactiveTimer = null;
      }
      if (session) {
        try {
          await session.close();
          console.log('✅ Session sauber geschlossen');
        } catch (e) {
          console.error('❌ Session-Close-Fehler:', e);
        }
        session = null;
      }
    });

    clientWs.on('error', (error) => {
      console.error('❌ WS-Fehler:', error);
      if (clientWs._proactiveTimer) {
        clearInterval(clientWs._proactiveTimer);
        clientWs._proactiveTimer = null;
      }
      if (session) session.close();
    });
  });

  console.log('✅ Gemini WebSocket-Server bereit: /ws/gemini-live');
  return wss;
}
