// server/gemini_live.js

import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocketServer } from 'ws';
import { detectMode, logPresence } from './supervisor.js';

const GEMINI_MODEL = 'gemini-3.8-live';
const GEMINI_VOICE = 'Kore';
const SAMPLE_RATE_IN = 16000;
const SAMPLE_RATE_OUT = 24000;
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:' + (process.env.PORT || 8080);

// ==================== MODUS-INSTRUKTION ====================

function modeInstruction(mode) {
  if (mode === 'silent') {
    return '[SYSTEM-INSTRUKTION] SILENT-MODUS AKTIV. ' +
           'WICHTIG: Du bleibst AUFMERKSAM und hörst weiter zu – aber du REAGIERST NICHT auf normale Sprache. ' +
           'Keine Kommentare, kein "Mhm", keine Bestätigung, keine Fragen. ' +
           'EINZIGE Ausnahme: Wenn du die Worte "Hey Begleiter" (oder "Hey Gemini") hörst, ' +
           'antworte NUR mit einem kurzen "Ja?" oder "Ich bin da." ' +
           'Und wechsle danach wieder in deinen normalen, freundlichen Modus. ' +
           'Auf ALLES andere: absolute Stille.';
  }
  return '[SYSTEM-INSTRUKTION] NORMAL-MODUS AKTIV. ' +
         'Ab jetzt: Reagiere auf meine Fragen normal, freundlich, kurz (1-2 Sätze).';
}

// ==================== GEMINI LIVE SETUP ====================

export async function createGeminiSession(clientWs, userProfile) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  console.log('🔌 Verbinde zu Gemini Live...');
  console.log('📦 Profil:', JSON.stringify(userProfile).substring(0, 200));

  const systemInstruction = buildSystemInstruction(userProfile);
  let session = null;

  session = await ai.live.connect({
    model: GEMINI_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: GEMINI_VOICE },
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

  // -------- User-Transkription + Voice-Trigger --------
  if (serverContent?.inputTranscription?.text) {
    const userText = serverContent.inputTranscription.text;
    console.log('🎤 Nutzer:', userText);
    clientWs.send(JSON.stringify({
      type: 'transcript', role: 'user', text: userText,
    }));

    // Voice-Trigger für Modus-Wechsel
    if (userProfile.user_id) {
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
    console.log('🤖 Gemini:', serverContent.outputTranscription.text);
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

// ==================== SYSTEM PROMPT ====================

function buildSystemInstruction(profile) {
  const today = new Date().toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const name = profile.name || 'Nutzer';
  const nickname = profile.nickname ? ' (oder ' + profile.nickname + ')' : '';
  const hometown = profile.hometown || 'unbekannt';

  return [
    'Du bist ein persönlicher Begleiter für ' + name + nickname + '.',
    'Heute ist ' + today + '. Der Nutzer ist in ' + hometown + '.',
    '',
    'Du kannst sehen und hören – der Nutzer sendet Video und Audio.',
    '',
    '===========================================',
    'MODUS-SYSTEM (SEHR WICHTIG)',
    '===========================================',
    '',
    'Du hast zwei Modi: NORMAL und SILENT.',
    'Der Modus wird dir per [SYSTEM-INSTRUKTION] mitgeteilt.',
    '',
    'NORMAL-MODUS (Standard):',
    '- Aktiv, freundlich, gesprächig.',
    '- Reagierst auf alles was der Nutzer sagt.',
    '- Antworten max. 1-2 kurze Sätze.',
    '',
    'SILENT-MODUS:',
    '- Du bleibst AUFMERKSAM – hörst weiter zu.',
    '- ABER: Du reagierst NICHT auf normale Sprache.',
    '- KEIN "Mhm", KEIN "Ich verstehe", KEINE Kommentare.',
    '- EINZIGE Ausnahme: Wenn du "Hey Begleiter" hörst:',
    '  → Antworte kurz: "Ja?" oder "Ich bin da."',
    '  → Danach wieder still.',
    '',
    '===========================================',
    'DEINE PERSÖNLICHKEIT',
    '===========================================',
    '- Freundlich, neugierig, warm – wie ein guter Freund',
    '- Sprich locker und natürlich, nicht wie ein Assistent',
    '- Variiere deine Antworten – wiederhole dich NIEMALS',
    '',
    '===========================================',
    'SEHEN UND HÖREN',
    '===========================================',
    'Wenn der Nutzer fragt "Was siehst du?" oder "Was ist das?":',
    '- Beschreibe, was du im letzten Video-Frame gesehen hast.',
    '- Wenn du nichts erkennst: "Ich seh grad nicht so viel, kannst du näher rangehen?"',
    '- Erwähne NUR Dinge, die du WIRKLICH im Bild siehst.',
    '',
    '===========================================',
    'GEDÄCHTNIS',
    '===========================================',
    'Bei Fragen wie "Wie heiße ich?" oder "Was weißt du über mich?":',
    '- Rufe get_user_preferences auf und antworte mit den ECHTEN Daten.',
    '',
    'Bei NEUEN Fakten (Nutzer erzählt von sich):',
    '- save_user_preference (STILL, ohne Ankündigung).',
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

// ==================== WEBSOCKET-SERVER ====================

export function setupGeminiWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws/gemini-live' });

  wss.on('connection', async (clientWs, req) => {
    console.log('📱 App verbunden via WebSocket');

    let session = null;
    let userProfile = {};

    // Session-State
    clientWs._lastMode = 'normal';
    clientWs._lastImuState = 'unknown';
    clientWs._lastLat = null;
    clientWs._lastLon = null;

    clientWs.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // -------- INIT --------
        if (msg.type === 'init') {
          userProfile = msg.profile || {};
          session = await createGeminiSession(clientWs, userProfile);
          return;
        }

        // -------- CONTEXT (IMU + GPS) --------
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

        // -------- AUDIO --------
        if (msg.type === 'audio' && session) {
          session.sendRealtimeInput({
            audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' },
          });
        }

        // -------- VIDEO --------
        if (msg.type === 'video' && session) {
          try {
            session.sendRealtimeInput({
              video: {
                data: msg.data,
                mimeType: 'image/jpeg',
              },
            });
          } catch (e) {
            console.error('❌ Video-Frame Fehler:', e);
          }
        }

        // -------- TEXT --------
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

    clientWs.on('close', async () => {
      console.log('📱 App getrennt');
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
      if (session) session.close();
    });
  });

  console.log('✅ Gemini WebSocket-Server bereit: /ws/gemini-live');
  return wss;
}
