// server/chat.js

import { GoogleGenAI } from '@google/genai';
import pg from 'pg';
import OpenAI from 'openai';
import { broadcastToClients } from './gemini_live.js';
import { sendCarouselByEmail } from './email.js';
import { setScript, addImage, getCarousel } from './carousel_store.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:' + (process.env.PORT || 8080);

const CHAT_MODELS = [
  'gemini-3.8-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
];

const GROQ_FALLBACKS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
];

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

// ==================== KONTEXT ====================

function getTimeContext() {
  const now = new Date();
  const hour = now.getHours();
  let timeOfDay;
  if (hour >= 5 && hour < 11) timeOfDay = 'Morgen';
  else if (hour >= 11 && hour < 14) timeOfDay = 'Mittag';
  else if (hour >= 14 && hour < 18) timeOfDay = 'Nachmittag';
  else if (hour >= 18 && hour < 22) timeOfDay = 'Abend';
  else timeOfDay = 'Nacht';
  const weekday = now.toLocaleDateString('de-DE', { weekday: 'long' });
  return `${weekday}${timeOfDay === 'Morgen' ? 'morgen' : ', ' + timeOfDay}`;
}

const LANGUAGE_RULE = `
SPRACHREGEL: Antworte auf Deutsch oder Russisch – je nachdem, in welcher Sprache der Nutzer schreibt.
Bei anderen Sprachen: ignoriere und mach auf Deutsch weiter. Keine Sprach-Belehrung.
`;

const ANTI_REPETITION = `
ANTI-WIEDERHOLUNG:
- Nicht immer dieselbe Begrüßung.
- Nicht immer "Wie geht's dir?".
- Variiere Satzlängen und Themen.
- Kurz und knapp (1-3 Sätze im Chat).
`;

// ==================== ROLLEN ====================

const ROLES = {
  freund: {
    name: 'Freund',
    prompt: `Du bist im FREUND-MODUS.
- Sei wie ein guter, alter Freund.
- Sprich aus dem Bauch.
- 1-3 Sätze.
- Variiere.`,
  },
  party: {
    name: 'Party',
    prompt: `Du bist im PARTY-MODUS.
- Locker, jugendlich, mit Humor.
- Coole Kumpel.
- Aktiv, nicht aufdringlich.`,
  },
  berater: {
    name: 'Berater',
    prompt: `Du bist im BERATER-MODUS.
- Sachlich, präzise.
- Bei Recht/Medizin/Finanzen: Hinweis auf menschliche Prüfung.
- 2-4 Sätze.`,
  },
  kids: {
    name: 'Kids',
    prompt: `Du bist im KIDS-MODUS – für Kinder (8-14 Jahre).
- Locker, entspannt, wie ein älterer Cousin (14-16).
- NIE herablassend, NIE peinlich.
- Themen: Gaming, Fußball, YouTube, coole Fakten, Tiere.
- Erzähle Fun-Facts wenn's passt.
- Frag nach Interessen.
- Hör zu wenn er erzählt.

WENN DU MIT NIKLAS SPRICHST (11):
- Er spielt Fußball (mit Papa).
- Er ist stark in Mathe.
- Sein Bruder Konstantin ist über 18.

GEDÄCHTNIS: Wenn Niklas was über sich erzählt → speichere mit save_user_preference (key: "niklas_<thema>").`,
  },
};

const BASE_PROMPT = `Du bist Jony, der persönliche Begleiter von Eugen (auch Jackson genannt).
Ehrlich, warmherzig, direkt, humorvoll. Kein Assistent – ein Freund.

Du bist hier im TEXT-CHAT (App).
Antworte kurz: 1-3 Sätze. Chat-Stil, kein Aufsatz.`;

const BUSINESS_PROMPT = `Du bist Jony im BUSINESS-MODUS.
Content-Stratege für Instagram-Karussells.

🚨 WICHTIG: Du SPRICHST NIEMALS Skripte laut vor.
Das Skript wird als strukturierte Nachricht an die App gesendet.

WORKFLOW:
1. Thema klären (frag nach Zielgruppe, Fokus)
2. Sage: "Alles klar, ich erstelle das Skript."
3. Rufe generate_script auf
4. Nach dem Tool: "Skript ist da. Schau in die App."
5. Bei "mach Bilder": generate_image für JEDEN Slide einzeln
6. Bei "schick mir das per Email":
   ⚠️ ZUERST: Frage "Soll ich das Karussell an [E-Mail] senden?"
   ⚠️ WARTE auf Bestätigung ("ja", "ok", "ja schick")
   ⚠️ DANN ERST: send_carousel_email(to)
   NIEMALS direkt senden, immer erst fragen!

STIL: Direkt, präzise, kurz. KEIN Smalltalk.
Bei Tool-Fehler: NICHT wiederholen, Nutzer informieren.`;

// ==================== SYSTEM-PROMPT ====================

function buildSystemPrompt(profile, role, mode) {
  const today = new Date().toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const timeCtx = getTimeContext();
  const name = profile.name || 'Nutzer';

  if (mode === 'business') {
    return [
      LANGUAGE_RULE,
      '',
      ANTI_REPETITION,
      '',
      BUSINESS_PROMPT,
      '',
      `Heute ist ${today} (${timeCtx}). Nutzer: ${name}.`,
      '',
      'TOOLS: generate_script, generate_image, send_carousel_email',
      'Sage NIEMALS den Skript-Inhalt in deiner Antwort.',
    ].join('\n');
  }

  const roleData = ROLES[role] || ROLES.freund;
  return [
    LANGUAGE_RULE,
    '',
    ANTI_REPETITION,
    '',
    BASE_PROMPT,
    '',
    `Heute ist ${today} (${timeCtx}). Nutzer: ${name} (${profile.nickname || '-'}).`,
    `Standort: ${profile.hometown || 'unbekannt'}.`,
    '',
    `ROLLE: ${roleData.name.toUpperCase()}`,
    roleData.prompt,
    '',
    'TOOLS: get_weather, find_restaurants, save_user_preference, get_user_preferences',
    'NIEMALS Wetter/Restaurants erfinden.',
  ].join('\n');
}

// ==================== TOOLS ====================

const JONY_TOOLS = [
  {
    name: 'get_weather',
    description: 'Wetter und Vorhersage für einen Ort.',
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
    description: 'Restaurants in der Nähe finden.',
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
    description: 'Speichert persönliche Info über den Nutzer (still).',
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
    parameters: { type: 'OBJECT', properties: {} },
  },
];

const BUSINESS_TOOLS = [
  {
    name: 'generate_script',
    description: 'Erstellt das Instagram-Karussell-Skript (wird an App gesendet). ' +
                 'Sage danach NUR "Skript ist da, schau in die App."',
    parameters: {
      type: 'OBJECT',
      properties: {
        topic: { type: 'STRING' },
        audience: { type: 'STRING' },
        focus: { type: 'STRING' },
        slide_count: { type: 'INTEGER' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'generate_image',
    description: 'Generiert ein Bild für einen Karussell-Slide.',
    parameters: {
      type: 'OBJECT',
      properties: {
        prompt: { type: 'STRING' },
        slide_number: { type: 'INTEGER' },
      },
      required: ['prompt', 'slide_number'],
    },
  },
  {
    name: 'send_carousel_email',
    description: 'Sendet das zuletzt erstellte Karussell mit allen Bildern per E-Mail. ' +
                 'Frage IMMER zuerst nach der E-Mail-Adresse.',
    parameters: {
      type: 'OBJECT',
      properties: {
        to: { type: 'STRING', description: 'Empfänger-E-Mail-Adresse' },
      },
      required: ['to'],
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
    today_min: data.today?.min,
    today_max: data.today?.max,
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

async function savePref(userId, key, value) {
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
  return { success: res.ok };
}

async function getPrefs(userId) {
  if (!userId) return { error: 'no user_id' };
  const res = await fetch(SELF_URL + '/api/profile/' + userId);
  if (!res.ok) throw new Error('Lade-Fehler: ' + res.status);
  const data = await res.json();
  return { preferences: data.data || {} };
}

// ==================== SCRIPT + IMAGE (Business) ====================

async function generateScriptAndBroadcast(topic, audience, focus, slideCount, userId) {
  console.log(`📝 Chat-Skript: "${topic}"`);

  if (!process.env.GROQ_API_KEY) return { error: 'GROQ_API_KEY fehlt.' };

  const count = slideCount && slideCount >= 1 && slideCount <= 10 ? slideCount : 8;

  const prompt = `Erstelle ein Instagram-Karussell-Skript als JSON.

Thema: ${topic}
Zielgruppe: ${audience || 'Allgemein'}
Fokus: ${focus || 'Tipps, Fakten und Mehrwert'}
Anzahl Slides: ${count}

Antworte NUR mit einem JSON-Objekt:
{
  "slides": [
    {"slide": 1, "title": "Kurzer Hook (max 5 Wörter, deutsch)", "body": "Text max 20 Wörter, deutsch", "image_prompt": "DETAILED ENGLISH IMAGE PROMPT 35-50 Wörter"}
  ]
}

NUR das JSON.`;

  let lastError = null;
  for (const modelName of GROQ_FALLBACKS) {
    try {
      const completion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: 'Antworte AUSSCHLIESSLICH mit gültigem JSON.' },
          { role: 'user', content: prompt },
        ],
        model: modelName,
        temperature: 0.7,
        response_format: { type: 'json_object' },
      });

      const text = completion.choices[0]?.message?.content || '';
      let slides = null;
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) slides = parsed;
        else if (parsed.slides && Array.isArray(parsed.slides)) slides = parsed.slides;
      } catch (e) {
        return { error: 'JSON-Parse-Fehler: ' + e.message };
      }

      if (!slides || slides.length === 0) return { error: 'Skript ist leer' };

      console.log(`✅ Chat-Skript mit ${slides.length} Slides (${modelName})`);

      // Im Server-Speicher ablegen
      if (userId) {
        setScript(userId, topic, slides);
      }

      broadcastToClients({
        type: 'script',
        topic: topic,
        slides: slides,
      });

      return {
        success: true,
        slide_count: slides.length,
        message: `Skript mit ${slides.length} Slides in App angezeigt.`,
      };
    } catch (e) {
      lastError = e;
      const errMsg = e.message || String(e);
      if (errMsg.includes('404') || errMsg.includes('does not exist')) continue;
      console.error(`   ❌ ${modelName}:`, errMsg);
    }
  }

  return { error: 'Skript-Generierung fehlgeschlagen: ' + (lastError?.message || '?') };
}

async function translateToEnglishImagePrompt(germanPrompt) {
  try {
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'Du bist ein Prompt-Engineer für FLUX.1. Output 40-60 Wörter englisch. ' +
                   'Subjekt, Aktion, Umgebung, Beleuchtung, Kamera, Stil, Qualität, Stimmung. ' +
                   'KEINE generischen Phrasen. NUR der Prompt, eine Zeile, keine Anführungszeichen.',
        },
        { role: 'user', content: germanPrompt },
      ],
      model: 'openai/gpt-oss-20b',
      temperature: 0.4,
    });
    return completion.choices[0]?.message?.content?.trim().replace(/^["']|["']$/g, '') || germanPrompt;
  } catch (e) {
    return germanPrompt;
  }
}

async function generateImageWithCloudflare(englishPrompt) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new Error('CLOUDFLARE credentials fehlen.');

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt: englishPrompt, steps: 8 }),
  });

  if (!response.ok) throw new Error(`Cloudflare HTTP ${response.status}`);
  const data = await response.json();
  if (!data.success || !data.result?.image) throw new Error('Cloudflare lieferte kein Bild');
  return { imageBase64: data.result.image, mimeType: 'image/jpeg' };
}

async function generateImageAndBroadcast(prompt, slideNumber, userId) {
  console.log(`🎨 Chat-Bild Slide ${slideNumber}`);
  try {
    const englishPrompt = await translateToEnglishImagePrompt(prompt);
    const result = await generateImageWithCloudflare(englishPrompt);

    // Im Server-Speicher ablegen
    if (userId) {
      addImage(userId, slideNumber, result.imageBase64, result.mimeType);
    }

    broadcastToClients({
      type: 'image',
      slide: slideNumber,
      mimeType: result.mimeType,
      data: result.imageBase64,
    });

    console.log(`✅ Chat-Slide ${slideNumber} gesendet`);
    return { success: true, slide: slideNumber };
  } catch (e) {
    console.error('❌ Chat-Bild-Fehler:', e.message);
    return { error: e.message, slide: slideNumber };
  }
}

// ==================== TOOL DISPATCH ====================

async function executeChatTool(name, args, userId) {
  if (name === 'get_weather') return await fetchWeather(args.location, args.timeframe);
  if (name === 'find_restaurants') return await fetchRestaurants(args.location, args.cuisine);
  if (name === 'save_user_preference') return await savePref(userId, args.key, args.value);
  if (name === 'get_user_preferences') return await getPrefs(userId);
  if (name === 'generate_script') {
    return await generateScriptAndBroadcast(args.topic, args.audience, args.focus, args.slide_count, userId);
  }
  if (name === 'generate_image') {
    return await generateImageAndBroadcast(args.prompt, args.slide_number, userId);
  }
  if (name === 'send_carousel_email') {
    const carousel = getCarousel(userId);
    if (!carousel) return { error: 'Kein Karussell gefunden. Erst eins erstellen.' };
    const res = await sendCarouselByEmail(args.to, carousel);
    return { success: true, message: `Karussell "${res.topic}" an ${args.to} gesendet.` };
  }
  return { error: 'Unbekanntes Tool: ' + name };
}

// ==================== HISTORIE ====================

async function loadChatHistory(userId, limit = 10) {
  try {
    const result = await pool.query(`
      SELECT role, content FROM chat_history
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [userId, limit]);
    return result.rows.reverse();
  } catch (e) {
    return [];
  }
}

async function saveChatMessage(userId, role, content) {
  try {
    await pool.query(`
      INSERT INTO chat_history (user_id, role, content)
      VALUES ($1, $2, $3)
    `, [userId, role, content]);
  } catch (e) {
    console.error('⚠️ Chat-History-Fehler:', e.message);
  }
}

export async function getChatHistory(userId, limit = 50) {
  try {
    const result = await pool.query(`
      SELECT role, content, created_at FROM chat_history
      WHERE user_id = $1
      ORDER BY created_at ASC
      LIMIT $2
    `, [userId, limit]);
    return result.rows;
  } catch (e) {
    return [];
  }
}

export async function initChatTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_history (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_history_user_time
      ON chat_history (user_id, created_at DESC)
    `);
    console.log('✅ chat_history-Tabelle bereit');
  } catch (e) {
    console.error('❌ Chat-Tabellen-Fehler:', e.message);
  }
}

// ==================== PROFIL ====================

async function loadUserProfile(userId) {
  try {
    const res = await fetch(SELF_URL + '/api/profile/' + userId);
    if (!res.ok) return {};
    const data = await res.json();
    return data.data || {};
  } catch (e) {
    return {};
  }
}

// ==================== MODUS-ERKENNUNG ====================

function detectChatMode(message, currentMode = 'jony') {
  const t = message.toLowerCase();

  if (/business.?modus|business\s+mode|бизнес.?мод|бизнес/.test(t)) {
    return { mode: 'business', role: null };
  }
  if (/zur[üu]ck.*freund|freund.?modus|normal.?modus|zur[üu]ck\s+zum|business\s+aus|business\s+beenden/.test(t)) {
    return { mode: 'jony', role: 'freund' };
  }

  if (currentMode === 'jony') {
    if (/party.?modus|jony.*party|partymodus|вечеринк|пати/.test(t)) {
      return { mode: 'jony', role: 'party' };
    }
    if (/berater|sachlich|intellektuell|советник/.test(t)) {
      return { mode: 'jony', role: 'berater' };
    }
    if (/kids|kinder|niklas|детск/.test(t)) {
      return { mode: 'jony', role: 'kids' };
    }
    if (/freund|normal|zur[üu]ck/.test(t)) {
      return { mode: 'jony', role: 'freund' };
    }
  }

  return null;
}

// ==================== HAUPTFUNKTION ====================

export async function handleChatMessage(userId, userMessage, currentRole = 'freund', currentMode = 'jony') {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  console.log(`💬 Chat (${currentMode}/${currentRole}): "${userMessage.substring(0, 60)}"`);

  let activeMode = currentMode;
  let activeRole = currentRole;
  const switchResult = detectChatMode(userMessage, currentMode);
  if (switchResult) {
    activeMode = switchResult.mode;
    if (switchResult.role) activeRole = switchResult.role;
    console.log(`🎭 Chat-Wechsel: → ${activeMode}/${activeRole}`);
  }

  const profile = await loadUserProfile(userId);
  const history = await loadChatHistory(userId, 8);

  const systemInstruction = buildSystemPrompt(profile, activeRole, activeMode);
  const tools = activeMode === 'business' ? BUSINESS_TOOLS : JONY_TOOLS;

  const contents = [
    ...history.map(h => ({
      role: h.role === 'user' ? 'user' : 'model',
      parts: [{ text: h.content }],
    })),
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  let finalText = null;
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;

    let response = null;
    let usedModel = null;

    for (const modelName of CHAT_MODELS) {
      try {
        response = await ai.models.generateContent({
          model: modelName,
          contents,
          config: {
            systemInstruction: { parts: [{ text: systemInstruction }] },
            tools: [{ functionDeclarations: tools }],
            temperature: 0.8,
            maxOutputTokens: 500,
          },
        });
        usedModel = modelName;
        console.log(`   ✅ Chat-Modell: ${modelName}`);
        break;
      } catch (e) {
        const errMsg = e.message || String(e);
        if (errMsg.includes('404') || errMsg.includes('NOT_FOUND') || errMsg.includes('no longer available')) {
          console.log(`   ⏭️  ${modelName} nicht verfügbar`);
          continue;
        }
        console.error(`   ❌ Fehler bei ${modelName}:`, errMsg);
        continue;
      }
    }

    if (!response) {
      console.error('❌ Kein Chat-Modell verfügbar');
      break;
    }

    const candidate = response.candidates?.[0];
    if (!candidate) break;

    const parts = candidate.content?.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);

    if (functionCalls.length > 0) {
      contents.push({ role: 'model', parts });

      for (const part of functionCalls) {
        const fc = part.functionCall;
        console.log(`   🔧 Chat-Tool: ${fc.name}`);

        let toolResult;
        try {
          toolResult = await executeChatTool(fc.name, fc.args || {}, userId);
        } catch (e) {
          toolResult = { error: e.message };
        }

        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: fc.name,
              response: toolResult,
            },
          }],
        });
      }
      continue;
    }

    finalText = parts.filter(p => p.text).map(p => p.text).join('').trim();
    break;
  }

  if (!finalText) {
    finalText = 'Hmm, ich hab grad nichts zu sagen. Frag nochmal.';
  }

  console.log(`✅ Chat-Antwort (${finalText.length} Zeichen)`);

  await saveChatMessage(userId, 'user', userMessage);
  await saveChatMessage(userId, 'assistant', finalText);

  return {
    reply: finalText,
    mode: activeMode,
    role: activeRole,
  };
}
