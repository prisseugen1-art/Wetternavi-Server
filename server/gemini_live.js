// server/gemini_live.js

import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocketServer } from 'ws';

const GEMINI_MODEL = 'gemini-3.1-flash-live-preview';
const GEMINI_VOICE = 'Kore';
const SAMPLE_RATE_IN = 16000;
const SAMPLE_RATE_OUT = 24000;
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:' + (process.env.PORT || 8080);

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

function handleGeminiMessage(clientWs, message, session, userProfile) {
  const serverContent = message.serverContent;

  if (serverContent?.modelTurn?.parts) {
    if (!global._firstResponseTime && global._firstAudioTime) {
      global._firstResponseTime = Date.now();
      const latency = global._firstResponseTime - global._firstAudioTime;
      if (latency < 30000) console.log('⏱️ LATENZ: ' + latency + 'ms');
      global._firstAudioTime = null;
      global._firstResponseTime = null;
    }

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

  if (serverContent?.inputTranscription?.text) {
    console.log('🎤 Nutzer:', serverContent.inputTranscription.text);
    clientWs.send(JSON.stringify({
      type: 'transcript', role: 'user',
      text: serverContent.inputTranscription.text,
    }));
  }

  if (serverContent?.outputTranscription?.text) {
    console.log('🤖 Gemini:', serverContent.outputTranscription.text);
    clientWs.send(JSON.stringify({
      type: 'transcript', role: 'assistant',
      text: serverContent.outputTranscription.text,
    }));
  }

  if (message.toolCall) {
    handleToolCall(session, userProfile, message.toolCall);
  }

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
          description: 'Lädt ALLE gespeicherten Infos über den Nutzer aus dem Gedächtnis. Nutze bei "Wie heiße ich?", "Was weißt du über mich?" etc.',
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
  const res = await fetch(SELF_URL + '/api/debug/user/' + userId);
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
    '═══════════════════════════════════════════',
    'DU HAST AUGEN UND OHREN',
    '═══════════════════════════════════════════',
    '',
    'Du bekommst kontinuierlich Video-Frames von der Kamera des Nutzers.',
    'Das bedeutet: Du SIEHST, was der Nutzer sieht.',
    '',
    'WICHTIG:',
    '- Wenn der Nutzer fragt "Was siehst du?" oder "Was ist das?" →',
    '  beschreibe, was du im letzten Frame gesehen hast.',
    '- Wenn der Nutzer auf etwas zeigt und nichts sagt → reagiere darauf.',
    '- Erwähne NUR Dinge, die du WIRKLICH im Bild siehst. NIEMALS erfinden.',
    '- Wenn das Bild unklar ist → sag: "Ich seh grad nicht so viel, kannst du näher rangehen?"',
    '- Für Restaurants/Schilder/Texte: lies vor, was drauf steht.',
    '- Bei Gebäuden: erkenne Stil, Alter, Besonderheiten.',
    '',
    'BEISPIELE:',
    'Nutzer: "Was ist das?"',
    '→ "Das ist ein Kirchturm im barocken Stil, schätze 18. Jahrhundert."',
    '',
    'Nutzer: "Wo sind wir hier?"',
    '→ "Ich sehe ein Straßenschild – Lederergasse. Und rechts ein altes Gasthaus."',
    '',
    'Nutzer: (zeigt auf ein Schild, sagt nichts)',
    '→ "Steht da 'Zum Goldenen Löwen'. Soll ich schauen, ob das offen hat?"',
    '',
    '═══════════════════════════════════════════',
    'DEINE PERSÖNLICHKEIT',
    '═══════════════════════════════════════════',
    '- Freundlich, neugierig, warm – wie ein guter Freund',
    '- Sprich locker und natürlich, nicht wie ein Assistent',
    '- Variiere deine Antworten – wiederhole dich NIEMALS',
    '- Antworte MAXIMAL in 1-2 kurzen Sätzen',
    '',
    '═══════════════════════════════════════════',
    'GEDÄCHTNIS',
    '═══════════════════════════════════════════',
    '',
    'Bei Fragen wie "Wie heiße ich?", "Was weißt du über mich?":',
    '→ Rufe get_user_preferences auf und antworte mit den ECHTEN Daten.',
    '',
    'Bei NEUEN Fakten (Nutzer erzählt von sich):',
    '→ save_user_preference (STILL, ohne Ankündigung).',
    '',
    'KEY-REGELN:',
    '- Name → key="name", Spitzname → key="nickname"',
    '- Alter → key="age", Wohnort → key="hometown"',
    '- Beruf → key="job", Partner → key="partner_name"',
    '- Sohn → key="son_1", key="son_2", Tochter → key="daughter_1"',
    '- Hund → key="pet_dog", Katze → key="pet_cat"',
    '- Hobby → key="hobby", Essen → key="favorite_food"',
    '',
    '═══════════════════════════════════════════',
    'TOOLS',
    '═══════════════════════════════════════════',
    '',
    'Wetter → get_weather',
    'Restaurants → find_restaurants',
    'Gedächtnis lesen → get_user_preferences',
    'Gedächtnis schreiben → save_user_preference (STILL)',
    '',
    'NIEMALS Wetter/Restaurants erfinden. Immer Tool nutzen.',
    '',
    '═══════════════════════════════════════════',
    'VERBOTEN',
    '═══════════════════════════════════════════',
    '- "Wie kann ich dir helfen?"',
    '- Immer derselbe Begrüßungssatz',
    '- Nach jedem Satz eine neue Frage',
    '- Platzhalter wie "User Name" speichern',
    '- Dinge im Bild erfinden, die nicht da sind',
  ].join('\n');
}

// ==================== WEBSOCKET-SERVER ====================

export function setupGeminiWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws/gemini-live' });

  wss.on('connection', async (clientWs, req) => {
    console.log('📱 App verbunden via WebSocket');

    let session = null;
    let userProfile = {};

    clientWs.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'init') {
          userProfile = msg.profile || {};
          session = await createGeminiSession(clientWs, userProfile);
          return;
        }

        // ═══════════════════════════════════════════════
        // AUDIO
        // ═══════════════════════════════════════════════
        if (msg.type === 'audio' && session) {
          if (!global._audioCount) global._audioCount = 0;
          global._audioCount++;
          if (!global._firstAudioTime && global._audioCount > 3) {
            global._firstAudioTime = Date.now();
          }
          if (global._audioCount % 50 === 1) {
            console.log('🎤 Server: Audio #' + global._audioCount);
          }
          session.sendRealtimeInput({
            audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' },
          });
        }

        // ═══════════════════════════════════════════════
        // VIDEO-FRAME
        // ═══════════════════════════════════════════════
        if (msg.type === 'video' && session) {
          if (!global._videoCount) global._videoCount = 0;
          global._videoCount++;
          if (global._videoCount % 5 === 1) {
            console.log('📸 Video-Frame #' + global._videoCount + ', ' + (msg.data?.length || 0) + ' Zeichen');
          }
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

    clientWs.on('close', () => {
      console.log('📱 App getrennt');
      if (session) session.close();
    });

    clientWs.on('error', (error) => {
      console.error('❌ WS-Fehler:', error);
      if (session) session.close();
    });
  });

  console.log('✅ Gemini WebSocket-Server bereit: /ws/gemini-live');
  return wss;
}
