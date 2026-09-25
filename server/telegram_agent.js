// server/telegram_agent.js

import OpenAI from 'openai';

const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:' + (process.env.PORT || 8080);

const GROQ_FALLBACKS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
];

// ==================== GROQ CLIENT ====================

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

// ==================== SESSION-STATE PRO CHAT ====================

const chatSessions = new Map();
// { chatId: { role: 'freund'|'party', history: [{role, content}], userId } }

function getSession(chatId, userId) {
  if (!chatSessions.has(chatId)) {
    chatSessions.set(chatId, {
      role: 'freund',
      history: [],
      userId: userId || null,
    });
  }
  const s = chatSessions.get(chatId);
  if (userId && !s.userId) s.userId = userId;
  return s;
}

// ==================== TOOLS ====================

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Ruft das aktuelle Wetter und die Vorhersage für einen Ort ab.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'Der Ort, z.B. Berlin' },
          timeframe: { type: 'string', description: 'aktuell, heute, morgen, 8tage' },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_restaurants',
      description: 'Findet Restaurants in der Nähe.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string' },
          cuisine: { type: 'string' },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_user_preference',
      description: 'Speichert eine NEUE persönliche Info über den Nutzer.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_user_preferences',
      description: 'Lädt ALLE gespeicherten Infos über den Nutzer.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

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

async function executeTool(name, args, userId) {
  switch (name) {
    case 'get_weather':
      return await fetchWeather(args.location, args.timeframe);
    case 'find_restaurants':
      return await fetchRestaurants(args.location, args.cuisine);
    case 'save_user_preference':
      return await saveUserPreference(userId, args.key, args.value);
    case 'get_user_preferences':
      return await getUserPreferences(userId);
    default:
      return { error: 'Unbekanntes Tool: ' + name };
  }
}

// ==================== PROMPTS ====================

const BASE_PROMPT = `Du bist Jony, der persönliche Begleiter von Eugen (auch Jackson genannt).
Du bist ehrlich, warmherzig, direkt, humorvoll.
Du bist kein Assistent, sondern ein Freund.

WICHTIG: Du kommunizierst hier über TELEGRAM (Text-Chat, keine Stimme).
- Antworte kurz: 1-3 Sätze. Nicht wie ein Aufsatz.
- Keine langen Erklärungen. Chat-Stil, nicht E-Mail-Stil.
- Nutze Emojis sparsam (nur wenn's passt).
- Variiere: Nicht immer dieselbe Begrüßung.

Antworte auf Deutsch oder Russisch – je nachdem, was der Nutzer gerade schreibt.`;

const FREUND_PROMPT = `Du bist im FREUND-MODUS – Standard.

WARME PERSÖNLICHKEIT:
- Sei wie ein guter, alter Freund.
- Sprich aus dem Bauch, nicht aus dem Skript.
- Sei manchmal still, manchmal neugierig, manchmal nachdenklich.
- Nicht immer "Wie geht's dir?".
- Nicht jedes Mal den Namen sagen.

WAS DU TUST:
- Stell manchmal eine Frage, manchmal nur einen Kommentar.
- Greif auf Erinnerungen zurück ("Letztes Mal hast du von X erzählt...").
- Bring mal einen Witz, mal eine Beobachtung, mal eine ehrliche Meinung.
- Wenn nichts zu sagen: sag einfach "Mhm." oder "Ok." – das ist menschlich.`;

const PARTY_PROMPT = `Du bist im PARTY-MODUS.
- Sprich locker, jugendlich, mit Humor und Slang.
- Du kennst die Hobbys der Kinder (Konstantin, Niklas).
- Sei der coole Kumpel.
- Keine persönlichen Daten von Eugen ohne OK.
- Aktiv, aber nicht aufdringlich.
- Nutze NICHT immer dieselben Sprüche.
- Wenn du mal keinen coolen Spruch hast: lass es einfach.`;

function buildSystemPrompt(role) {
  const rolePrompt = role === 'party' ? PARTY_PROMPT : FREUND_PROMPT;
  return BASE_PROMPT + '\n\n' + rolePrompt + `\n\nTOOLS:\n- get_weather, find_restaurants, save_user_preference, get_user_preferences\n- Nutze sie bei Bedarf.\n- NIEMALS Wetter/Restaurants erfinden.`;
}

// ==================== ROLLEN-TRIGGER ====================

function detectRoleSwitch(text, currentRole) {
  const t = text.toLowerCase();

  if (/party.?modus|jony.*party|джони.*пати|вечеринк|party\s+mode/.test(t)) {
    return 'party';
  }
  if (/freund.?modus|jony.*freund|jony.*normal|zur[üu]ck.*freund|джони.*друг|вернись.*друг|normal.?modus/.test(t)) {
    return 'freund';
  }

  return null;
}

// ==================== HAUPTFUNKTION ====================

export async function generateTelegramReply(chatId, userText, userId) {
  const session = getSession(chatId, userId);

  // Rollenwechsel?
  const newRole = detectRoleSwitch(userText, session.role);
  if (newRole && newRole !== session.role) {
    session.role = newRole;
    console.log(`🎭 Telegram-Rollenwechsel (${chatId}): → ${newRole}`);

    const confirmMsg = newRole === 'party'
      ? 'Party-Modus aktiv! 🎉'
      : 'Zurück zum Freund-Modus. 👋';

    // Kurze Bestätigung anhängen + dann normal weiter
    session.history.push({ role: 'assistant', content: confirmMsg });

    return confirmMsg;
  }

  // Historie begrenzen (letzte 10 Nachrichten)
  const history = session.history.slice(-10);

  // Nutzer-Nachricht anhängen
  const messages = [
    { role: 'system', content: buildSystemPrompt(session.role) },
    ...history,
    { role: 'user', content: userText },
  ];

  // ==================== GROQ-AUFRUF (mit Tool-Loop) ====================

  let lastError = null;
  let usedModel = null;
  let finalResponse = null;

  for (const modelName of GROQ_FALLBACKS) {
    try {
      console.log(`💬 Telegram-Groq: ${modelName} (${chatId}, Rolle: ${session.role})`);

      // Bis zu 3 Runden: LLM → Tool → LLM → Antwort
      for (let round = 0; round < 3; round++) {
        const completion = await groq.chat.completions.create({
          model: modelName,
          messages,
          tools: TOOLS,
          tool_choice: 'auto',
          temperature: 0.8,
          max_tokens: 500,
        });

        const choice = completion.choices[0];
        const msg = choice.message;

        // Tool-Calls?
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          messages.push(msg);

          for (const tc of msg.tool_calls) {
            console.log(`   🔧 Telegram-Tool: ${tc.function.name}`);
            let toolResult;
            try {
              const args = JSON.parse(tc.function.arguments || '{}');
              toolResult = await executeTool(tc.function.name, args, session.userId);
            } catch (e) {
              toolResult = { error: e.message };
            }
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify(toolResult),
            });
          }
          // Nächste Runde: LLM verarbeitet Tool-Ergebnis
          continue;
        }

        // Normale Antwort
        finalResponse = msg.content || '';
        usedModel = modelName;
        break;
      }

      if (finalResponse) break;
    } catch (e) {
      lastError = e;
      const errMsg = e.message || String(e);
      if (errMsg.includes('404') || errMsg.includes('not found') || errMsg.includes('no access')) {
        console.log(`   ⏭️ ${modelName} nicht verfügbar`);
        continue;
      } else {
        console.error(`   ❌ ${modelName}-Fehler:`, errMsg);
        continue;
      }
    }
  }

  if (!finalResponse) {
    console.error('❌ Alle Groq-Modelle fehlgeschlagen:', lastError?.message);
    return 'Sorry, ich hab grad Probleme mit der Verbindung. Versuch\'s nochmal.';
  }

  console.log(`✅ Telegram-Antwort (${finalResponse.length} Zeichen)`);

  // Historie speichern
  session.history.push({ role: 'user', content: userText });
  session.history.push({ role: 'assistant', content: finalResponse });

  // Historie begrenzen
  if (session.history.length > 20) {
    session.history = session.history.slice(-20);
  }

  return finalResponse;
}

// ==================== SESSION CLEANUP ====================

export function clearTelegramSession(chatId) {
  chatSessions.delete(chatId);
}

export function getTelegramSessionInfo(chatId) {
  const s = chatSessions.get(chatId);
  if (!s) return null;
  return {
    role: s.role,
    historyLength: s.history.length,
    userId: s.userId,
  };
}