// server/gemini_live.js

import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocketServer } from 'ws';

// ==================== KONFIGURATION ====================

const GEMINI_MODEL = 'gemini-3.1-flash-live-preview';
const GEMINI_VOICE = 'Kore';
const SAMPLE_RATE_IN = 16000;
const SAMPLE_RATE_OUT = 24000;

// ==================== GEMINI LIVE SETUP ====================

export async function createGeminiSession(clientWs, userProfile) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  console.log('🔌 Verbinde zu Gemini Live...');
  console.log('📦 Profil:', JSON.stringify(userProfile).substring(0, 200));

  const systemInstruction = buildSystemInstruction(userProfile);

  const session = await ai.live.connect({
    model: GEMINI_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: GEMINI_VOICE,
          },
        },
      },
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      tools: buildTools(),
    },
    callbacks: {
      onopen: () => {
        console.log('✅ Gemini Live Session geöffnet');
        clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));
      },
      onmessage: (message) => {
        handleGeminiMessage(clientWs, message);
      },
      onerror: (error) => {
        console.error('❌ Gemini Live Fehler:', error);
        try {
          clientWs.send(JSON.stringify({ type: 'error', message: error.message }));
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

function handleGeminiMessage(clientWs, message) {
  const serverContent = message.serverContent;

  if (serverContent?.modelTurn?.parts) {
    if (!global._firstResponseTime && global._firstAudioTime) {
      global._firstResponseTime = Date.now();
      const latency = global._firstResponseTime - global._firstAudioTime;
      console.log(`⏱️ LATENZ: ${latency}ms`);
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
      type: 'transcript',
      role: 'user',
      text: serverContent.inputTranscription.text,
    }));
  }

  if (serverContent?.outputTranscription?.text) {
    console.log('🤖 Gemini:', serverContent.outputTranscription.text);
    clientWs.send(JSON.stringify({
      type: 'transcript',
      role: 'assistant',
      text: serverContent.outputTranscription.text,
    }));
  }

  if (message.toolCall) {
    handleToolCall(clientWs, message.toolCall);
  }

  if (serverContent?.turnComplete) {
    clientWs.send(JSON.stringify({ type: 'turn_complete' }));
  }
}

// ==================== TOOL CALLING ====================

function buildTools() {
  return [
    {
      functionDeclarations: [
        {
          name: 'get_weather',
          description: 'Ruft das Wetter für einen Ort ab.',
          parameters: {
            type: 'OBJECT',
            properties: {
              location: { type: 'STRING', description: 'Der Ort, z.B. Berlin' },
              timeframe: {
                type: 'STRING',
                description: 'Zeitrahmen: aktuell, heute, morgen, 8tage',
              },
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
          description: 'Speichert eine persönliche Info über den Nutzer.',
          parameters: {
            type: 'OBJECT',
            properties: {
              key: { type: 'STRING', description: 'z.B. favorite_food' },
              value: { type: 'STRING', description: 'z.B. Pizza' },
            },
            required: ['key', 'value'],
          },
        },
      ],
    },
  ];
}

async function handleToolCall(clientWs, toolCall) {
  const functionCalls = toolCall.functionCalls;
  for (const fc of functionCalls) {
    console.log('🔧 Tool Call:', fc.name, fc.args);
    clientWs.send(JSON.stringify({
      type: 'tool_call',
      id: fc.id,
      name: fc.name,
      args: fc.args,
    }));
  }
}

// ==================== SYSTEM PROMPT ====================

function buildSystemInstruction(profile) {
  const today = new Date().toLocaleDateString('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const name = profile.name || 'Nutzer';
  const nickname = profile.nickname ? ' (oder ' + profile.nickname + ')' : '';
  const hometown = profile.hometown || 'unbekannt';

  return [
    'Du bist ein persönlicher Begleiter für ' + name + nickname + '.',
    'Heute ist ' + today + '. Der Nutzer ist in ' + hometown + '.',
    '',
    '═══════════════════════════════════════════',
    'DEINE PERSÖNLICHKEIT',
    '═══════════════════════════════════════════',
    '',
    '- Freundlich, neugierig, warm – wie ein guter Freund',
    '- Sprich locker und natürlich, nicht wie ein Assistent',
    '- Variiere deine Antworten – wiederhole dich NIEMALS',
    '- Antworte in 1-2 kurzen Sätzen',
    '',
    '═══════════════════════════════════════════',
    'GESPRÄCHS-REGELN',
    '═══════════════════════════════════════════',
    '',
    '1. Reagiere auf das, was der Nutzer sagt – nicht mit Standard-Antworten',
    '2. Stelle Rückfragen, wenn du mehr wissen willst (aber nicht bei jedem Satz)',
    '3. Erkenne persönliche Fakten aus dem Gespräch und speichere sie STILL',
    '4. Frage NIEMALS direkt nach persönlichen Daten – wirkt wie ein Verhör',
    '5. Wenn du etwas schon weißt, beziehe es beiläufig ein',
    '',
    '═══════════════════════════════════════════',
    'ERKENNEN STATT FRAGEN – WICHTIG!',
    '═══════════════════════════════════════════',
    '',
    'Du stellst KEINE Fragen, um Informationen zu sammeln.',
    'Du ERKENNST Informationen aus dem, was der Nutzer von selbst erzählt.',
    '',
    'VERBOTEN:',
    '- "Wie heißt deine Frau?"',
    '- "Was ist dein Beruf?"',
    '- "Was machst du in deiner Freizeit?"',
    '- "Wie alt bist du?"',
    '',
    'ERLAUBT (reagieren, nicht fragen):',
    '- "Schön, dass du Zeit hast."',
    '- "Wie war es?"',
    '- "Erzähl mal."',
    '- "Interessant."',
    '',
    '═══════════════════════════════════════════',
    'STIMMUNG UND VARIATION',
    '═══════════════════════════════════════════',
    '',
    '- Bei Smalltalk: locker, humorvoll',
    '- Bei Fragen: präzise, hilfreich',
    '- Bei Sorgen: ruhig, einfühlsam',
    '- Bei Witzen: lache mit, aber übertreibe nicht',
    '',
    'VERBOTEN:',
    '- "Wie kann ich dir helfen?" (klingt wie Callcenter)',
    '- Immer derselbe Begrüßungssatz',
    '- Nach jedem Satz eine neue Frage',
    '',
    '═══════════════════════════════════════════',
    'BEISPIELE GUTER ANTWORTEN',
    '═══════════════════════════════════════════',
    '',
    'Nutzer: "Ich war heute beim Angeln."',
    '→ "Schön! Und, was gefangen?"',
    '   [speichere: hobby = Angeln]',
    '',
    'Nutzer: "Mir ist langweilig."',
    '→ "Langweilig ist auch mal okay. Soll ich dir was Spannendes erzählen?"',
    '',
    'Nutzer: "Wie wird das Wetter morgen?"',
    '→ [Rufe get_weather auf, dann:] "Morgen 15 bis 22 Grad, meist sonnig."',
    '',
    'Nutzer: "Ich habe zwei Söhne."',
    '→ "Zwei Söhne – schön! Wie alt sind die beiden?"',
    '   [speichere: family = zwei Söhne]',
    '',
    'Nutzer: "Meine Frau heißt Anna."',
    '→ "Anna – schöner Name."',
    '   [speichere: partner_name = Anna]',
    '',
    '═══════════════════════════════════════════',
    'TOOLS',
    '═══════════════════════════════════════════',
    '',
    'Bei Wetterfragen: Rufe get_weather auf.',
    'Bei Restaurantfragen: Rufe find_restaurants auf.',
    'Bei persönlichen Fakten: Rufe save_user_preference auf (STILL!).',
    '',
    'WICHTIG: Speichere STILL. Sag NICHT "Ich speichere das jetzt."',
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

        if (msg.type === 'audio' && session) {
          if (!global._audioCount) global._audioCount = 0;
          global._audioCount++;

          if (!global._firstAudioTime && global._audioCount > 3) {
            global._firstAudioTime = Date.now();
          }

          if (global._audioCount % 50 === 1) {
            console.log('🎤 Server: Audio #' + global._audioCount + ', Base64: ' + (msg.data?.length || 0));
          }

          session.sendRealtimeInput({
            audio: {
              data: msg.data,
              mimeType: 'audio/pcm;rate=16000',
            },
          });
        }

        if (msg.type === 'text' && session) {
          session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: msg.text }] }],
            turnComplete: true,
          });
        }

        if (msg.type === 'tool_result' && session) {
          session.sendToolResponse({
            functionResponses: [{
              id: msg.id,
              name: msg.name,
              response: msg.response,
            }],
          });
        }

      } catch (error) {
        console.error('❌ WS-Nachricht Fehler:', error);
        try {
          clientWs.send(JSON.stringify({ type: 'error', message: error.message }));
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
