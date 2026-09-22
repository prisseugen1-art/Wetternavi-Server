// server/gemini_live.js

import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocketServer } from 'ws';

// ==================== KONFIGURATION ====================

const GEMINI_MODEL = 'gemini-2.5-flash-live';
const GEMINI_VOICE = 'Kore';  // Puck, Charon, Kore, Fenrir, Aoede
const SAMPLE_RATE_IN = 16000;  // Von der App
const SAMPLE_RATE_OUT = 24000; // Von Gemini

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
      onclose: () => {
        console.log('🔌 Gemini Live Session geschlossen');
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

  // Audio-Ausgabe
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

  // Eingabe-Transkription
  if (serverContent?.inputTranscription?.text) {
    console.log('🎤 Nutzer:', serverContent.inputTranscription.text);
    clientWs.send(JSON.stringify({
      type: 'transcript',
      role: 'user',
      text: serverContent.inputTranscription.text,
    }));
  }

  // Ausgabe-Transkription
  if (serverContent?.outputTranscription?.text) {
    console.log('🤖 Gemini:', serverContent.outputTranscription.text);
    clientWs.send(JSON.stringify({
      type: 'transcript',
      role: 'assistant',
      text: serverContent.outputTranscription.text,
    }));
  }

  // Function Calls
  if (message.toolCall) {
    handleToolCall(clientWs, message.toolCall);
  }

  // Turn abgeschlossen
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
              location: { type: 'STRING', description: 'Der Ort, z.B. "Berlin"' },
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
              cuisine: { type: 'STRING', description: 'Küche, z.B. "Pizza"' },
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
              key: { type: 'STRING', description: 'z.B. "favorite_food"' },
              value: { type: 'STRING', description: 'z.B. "Pizza"' },
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
    console.log(`🔧 Tool Call: ${fc.name}`, fc.args);
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
  return `Du bist ein freundlicher Begleiter. Sprich Deutsch, sei locker und antworte kurz.

NUTZER-PROFIL:
- Name: ${profile.name || 'Gast'}
- Spitzname: ${profile.nickname || ''}
- Wohnort: ${profile.hometown || ''}

REGELN:
1. Antworte IMMER kurz (1-2 Sätze).
2. Erkenne persönliche Fakten aus dem Gespräch und speichere sie still.
3. Frage NIEMALS direkt nach persönlichen Daten.
4. Variiere deine Begrüßung.

Bei Wetterfragen: Rufe get_weather auf.
Bei Restaurantfragen: Rufe find_restaurants auf.
Bei persönlichen Fakten: Rufe save_user_preference auf.`;
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
  if (global._audioCount % 50 === 1) {
    console.log(`🎤 Server: Audio #${global._audioCount}, Base64: ${msg.data?.length || 0}`);
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