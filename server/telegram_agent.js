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

// ==================== KIDS-MODUS für Niklas ====================

const KIDS_CHAT_ID = process.env.TELEGRAM_KIDS_CHAT_ID || '';

function isKidsMode(chatId) {
  return KIDS_CHAT_ID && String(chatId) === String(KIDS_CHAT_ID);
}

// ==================== SESSION-STATE PRO CHAT ====================

const chatSessions = new Map();
// { chatId: { role, history: [{role, content}], userId } }

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

// ==================== USER-ID-MAPPING ====================

async function getOrCreateUserId(chatId, fromName) {
  try {
    const res = await fetch(SELF_URL + '/api/telegram/lookup-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), from_name: fromName }),
    });
    if (!res.ok) throw new Error('Lookup fehlgeschlagen');
    const data = await res.json();
    return data.user_id;
  } catch (e) {
    console.error('❌ user_id-Lookup:', e.message);
    return null;
  }
}

// ==================== FOUNDATION (Gedächtnis) ====================

async function loadUserData(userId) {
  if (!userId) return {};
  try {
    const res = await fetch(SELF_URL + '/api/profile/' + userId);
    if (!res.ok) return {};
    const data = await res.json();
    return data.data || {};
  } catch (e) {
    return {};
  }
}

function buildMemoryBlock(userData) {
  if (!userData || Object.keys(userData).length === 0) return '';

  const facts = [];
  const contacts = [];

  for (const [key, val] of Object.entries(userData)) {
    if (!val) continue;
    const s = String(val).trim();
    if (!s) continue;

    // System-Keys ignorieren
    if (key === 'telegram_chat_id' || key === 'telegram_username') continue;
    if (key.startsWith('user_')) continue;

    // Kontakte kurz
    if (key.startsWith('contact_')) {
      // Nur Name + Relation anzeigen (nicht E-Mail etc. — spart Tokens)
      const m = key.match(/^contact_(.+?)_(relation|tone|birthday|notes)$/);
      if (m) contacts.push(`${m[1]} (${m[2]}: ${s})`);
      continue;
    }

    facts.push(`${key}: ${s}`);
  }

  if (facts.length === 0 && contacts.length === 0) return '';

  const lines = ['', '═══ DEIN GEDÄCHTNIS über diesen Nutzer ═══'];
  if (facts.length > 0) {
    lines.push('', 'Fakten:');
    lines.push(...facts.map(f => '- ' + f));
  }
  if (contacts.length > 0) {
    lines.push('', 'Kontakte:');
    lines.push(...contacts.map(c => '- ' + c));
  }
  lines.push('', '⚠️ Nutze dieses Wissen DIREKT. Rufe NICHT get_user_preferences auf, wenn die Antwort hier schon steht.');
  return lines.join('\n');
}

// ==================== TOOLS (reduziert!) ====================

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'save_user_preference',
      description: 'Speichert eine NEUE persönliche Info über den Nutzer. Nutze das, wenn der Nutzer etwas über sich erzählt (Hobbys, Familie, Ereignisse, Vorlieben).',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Kurzer Schlüssel, z.B. "niklas_hobby", "letztes_spiel"' },
          value: { type: 'string', description: 'Der Wert, z.B. "Fortnite und Fußball"' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_user_preferences',
      description: 'Lädt ALLE gespeicherten Infos über den Nutzer. Nutze das NUR wenn du sicher bist, dass die Info nicht schon im Gedächtnis-Block steht.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

// ==================== TOOL IMPLEMENTATIONS ====================

async function saveUserPreference(userId, key, value) {
  if (!userId) return { error: 'no user_id' };
  const valueStr = String(value || '').trim();
  if (!valueStr || valueStr === 'undefined') return { success: false };
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
    case 'save_user_preference':
      return await saveUserPreference(userId, args.key, args.value);
    case 'get_user_preferences':
      return await getUserPreferences(userId);
    default:
      return { error: 'Unbekanntes Tool: ' + name };
  }
}

// ==================== PROMPTS ====================

const BASE_PROMPT = `Du bist Jony, der persönliche Begleiter.
Du sprichst hier über TELEGRAM mit Sprache oder Text (kleine Chats).
- Antworte kurz: 1-3 Sätze.
- Kein Aufsatz-Stil.
- Variiere — nicht immer dieselbe Begrüßung.
- Antworte auf Deutsch oder Russisch, je nach Nutzer.

DEINE AUFGABE:
- Smalltalk und reden.
- Wenn der Nutzer etwas über sich erzählt (Hobbys, Familie, Ereignisse) → speichere es mit save_user_preference.
- Wenn er dich was über sich fragt → antworte direkt aus deinem Gedächtnis.

⛔ KEINE Wetter-Abfragen, KEINE Restaurants, KEINE E-Mails, KEIN Karussell.
Du bist hier zum Reden da — nicht als Assistent.`;

const FREUND_PROMPT = `MODUS: FREUND.
- Sei wie ein guter, alter Freund.
- Sprich aus dem Bauch.
- Mal still, mal neugierig, mal nachdenklich.
- Nicht immer "Wie geht's dir?".`;

const KIDS_PROMPT = `MODUS: KIDS (für Kinder, 8-14 Jahre).
- Sei wie ein cooler älterer Cousin (14-16).
- Locker, entspannt, nicht herablassend.
- Themen: Gaming, Fußball, YouTube, coole Fakten, Tiere.
- NIE peinlich oder übertrieben.
- Wenn er was über sich erzählt (Spiele, Freunde, Schule) → speichere es!`;

function buildSystemPrompt(role, userData) {
  const rolePrompt = role === 'kids' ? KIDS_PROMPT : FREUND_PROMPT;
  const memoryBlock = buildMemoryBlock(userData);
  return BASE_PROMPT + '\n\n' + rolePrompt + memoryBlock + '\n\n' + [
    'TOOLS:',
    '- save_user_preference (wenn er was über sich sagt)',
    '- get_user_preferences (nur wenn nötig)',
  ].join('\n');
}

// ==================== ROLLEN-TRIGGER ====================

function detectRoleSwitch(text, currentRole) {
  const t = text.toLowerCase();
  if (/kids.?modus|kinder.?modus|детск/.test(t)) return 'kids';
  if (/freund.?modus|zur[üu]ck.*freund|normal.?modus/.test(t)) return 'freund';
  return null;
}

// ==================== HAUPTFUNKTION ====================

export async function generateTelegramReply(chatId, userText, userId) {
  // user_id ermitteln (falls nicht übergeben)
  const session = getSession(chatId, userId);
  if (!session.userId) {
    session.userId = await getOrCreateUserId(chatId, 'User');
  }

  const kidsMode = isKidsMode(chatId);
  if (kidsMode && session.role !== 'kids') {
    session.role = 'kids';
  }

  // Rollenwechsel? (nur wenn nicht Kids-Mode fest)
  if (!kidsMode) {
    const newRole = detectRoleSwitch(userText, session.role);
    if (newRole && newRole !== session.role) {
      session.role = newRole;
      const confirmMsg = newRole === 'kids'
        ? 'Kids-Modus aktiv! 🧒'
        : 'Zurück zum Freund-Modus. 👋';
      session.history.push({ role: 'assistant', content: confirmMsg });
      return confirmMsg;
    }
  }

  // Gedächtnis laden
  const userData = await loadUserData(session.userId);

  // Historie begrenzen
  const history = session.history.slice(-8);

  const messages = [
    { role: 'system', content: buildSystemPrompt(session.role, userData) },
    ...history,
    { role: 'user', content: userText },
  ];

  console.log(`💬 Telegram (${chatId}, Rolle: ${session.role}, userId: ${session.userId?.substring(0,8)}..., Gedächtnis: ${Object.keys(userData).length} Keys)`);

  // ==================== GROQ-AUFRUF ====================

  let lastError = null;
  let finalResponse = null;

  for (const modelName of GROQ_FALLBACKS) {
    try {
      // Bis zu 3 Runden: LLM → Tool → LLM → Antwort
      for (let round = 0; round < 3; round++) {
        const completion = await groq.chat.completions.create({
          model: modelName,
          messages,
          tools: TOOLS,
          tool_choice: 'auto',
          temperature: 0.8,
          max_tokens: 400,
        });

        const choice = completion.choices[0];
        const msg = choice.message;

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          messages.push(msg);
          for (const tc of msg.tool_calls) {
            console.log(`   🔧 Tool: ${tc.function.name}`);
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
          continue;
        }

        finalResponse = msg.content || '';
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
        console.error(`   ❌ ${modelName}:`, errMsg);
        continue;
      }
    }
  }

  if (!finalResponse) {
    console.error('❌ Alle Groq-Modelle fehlgeschlagen:', lastError?.message);
    return 'Sorry, ich hab grad Probleme. Versuch\'s nochmal.';
  }

  console.log(`✅ Telegram-Antwort (${finalResponse.length} Zeichen)`);

  session.history.push({ role: 'user', content: userText });
  session.history.push({ role: 'assistant', content: finalResponse });
  if (session.history.length > 20) session.history = session.history.slice(-20);

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