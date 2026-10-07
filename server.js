// server.js

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import http from 'http';
import { SensorEvent, SensorBus, SensorSource } from './sensors/sensor_events.js';
import { setupGeminiWebSocket, broadcastToClients } from './server/gemini_live.js';
import { initTelegram, setTelegramWebhook, getTelegramWebhookCallback, getTelegramWebhookPath, getTelegramStatus, getTelegramWebhookInfo, sendTelegramMessage } from './server/telegram.js';
import { handleChatMessage, getChatHistory, initChatTable, getDraft, clearDraft } from './server/chat.js';
import { initEmail, getEmailStatus, sendEmail } from './server/email.js';

dotenv.config();

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ========== ANHANG-SPEICHER (RAM, 5 Min TTL) ==========
const attachmentStore = new Map();
const ATTACHMENT_TTL_MS = 5 * 60 * 1000;

function cleanOldAttachments() {
  const now = Date.now();
  let cleaned = 0;
  for (const [userId, list] of attachmentStore.entries()) {
    const fresh = list.filter(a => (now - a.createdAt) < ATTACHMENT_TTL_MS);
    if (fresh.length === 0) {
      attachmentStore.delete(userId);
    } else if (fresh.length !== list.length) {
      attachmentStore.set(userId, fresh);
    }
    cleaned += (list.length - fresh.length);
  }
  if (cleaned > 0) {
    console.log(`🧹 ${cleaned} abgelaufene Anhänge gelöscht`);
  }
}

setInterval(cleanOldAttachments, 60 * 1000);

function addAttachment(userId, filename, mimeType, base64Data) {
  if (!userId) throw new Error('user_id required');
  const list = attachmentStore.get(userId) || [];
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    filename: filename || 'anhang',
    mimeType: mimeType || 'application/octet-stream',
    data: base64Data,
    size: Math.round(base64Data.length * 0.75),
    createdAt: Date.now(),
  };
  list.push(item);
  attachmentStore.set(userId, list);
  console.log(`📎 Anhang hinzugefügt für ${userId.substring(0,8)}...: ${filename} (${Math.round(item.size/1024)} KB)`);
  return item;
}

function getAttachments(userId) {
  if (!userId) return [];
  const list = attachmentStore.get(userId) || [];
  const now = Date.now();
  return list.filter(a => (now - a.createdAt) < ATTACHMENT_TTL_MS);
}

function clearAttachments(userId) {
  if (!userId) return 0;
  const count = (attachmentStore.get(userId) || []).length;
  attachmentStore.delete(userId);
  console.log(`🧹 ${count} Anhänge gelöscht für ${userId.substring(0,8)}...`);
  return count;
}

// ========== DATENBANK ==========
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_data (
        user_id TEXT PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_presence (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        lat DOUBLE PRECISION,
        lon DOUBLE PRECISION,
        imu_state TEXT,
        timestamp TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_presence_user_time
      ON user_presence (user_id, timestamp DESC)
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_home (
        user_id TEXT PRIMARY KEY,
        home_lat DOUBLE PRECISION,
        home_lon DOUBLE PRECISION,
        confidence INT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id SERIAL PRIMARY KEY,
        user_id TEXT,
        source TEXT NOT NULL,
        model TEXT,
        input_tokens INT DEFAULT 0,
        output_tokens INT DEFAULT 0,
        total_tokens INT DEFAULT 0,
        tool_calls INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_token_usage_user_time
      ON token_usage (user_id, created_at DESC)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_token_usage_source_time
      ON token_usage (source, created_at DESC)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id SERIAL PRIMARY KEY,
        user_id TEXT,
        source TEXT NOT NULL,
        model TEXT,
        input_tokens INT DEFAULT 0,
        output_tokens INT DEFAULT 0,
        total_tokens INT DEFAULT 0,
        tool_calls INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_token_usage_user_time
      ON token_usage (user_id, created_at DESC)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS telegram_user_map (
        chat_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        display_name TEXT,
        is_kids BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        last_seen TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_telegram_map_user
      ON telegram_user_map (user_id)
    `);


    console.log('✅ Datenbank-Tabellen bereit');
  } catch (error) {
    console.error('❌ DB-Init-Fehler:', error);
  }
}

async function getUserData(userId) {
  if (!userId) return {};
  try {
    const result = await pool.query(
      'SELECT data FROM user_data WHERE user_id = $1',
      [userId]
    );
    return result.rows[0]?.data || {};
  } catch (error) {
    console.error('❌ Lade-Fehler:', error);
    return {};
  }
}

async function saveUserPref(userId, key, value) {
  try {
    await pool.query(`
      INSERT INTO user_data (user_id, data)
      VALUES ($1, jsonb_build_object($2::text, $3::text))
      ON CONFLICT (user_id) DO UPDATE
      SET data = user_data.data || jsonb_build_object($2::text, $3::text),
          updated_at = NOW()
    `, [userId, key, value]);
    return true;
  } catch (error) {
    console.error('❌ Speicher-Fehler:', error);
    return false;
  }
}

// ========== HELPER ==========
function resolveLocation(req, bodyKey = 'location') {
  let raw, quelle;
  const args = req.body?.args;
  if (args && args[bodyKey]) { raw = args[bodyKey]; quelle = 'ARGS'; }
  else if (req.body?.[bodyKey]) { raw = req.body[bodyKey]; quelle = 'BODY'; }
  else {
    const q = req.query.location;
    if (q && q !== '{{location}}') { raw = q; quelle = 'QUERY'; }
    else { raw = ''; quelle = 'LEER'; }
  }
  if (Array.isArray(raw)) raw = raw[0] || '';
  if (typeof raw !== 'string') raw = String(raw || '');
  const result = raw.trim();
  console.log(`📍 Location-Quelle: ${quelle} → "${result}"`);
  return result;
}

function resolveTimeframe(req, defaultVal = 'aktuell') {
  const args = req.body?.args;
  let raw = args?.timeframe || req.body?.timeframe || defaultVal;
  if (typeof raw !== 'string') raw = String(raw || defaultVal);
  return raw.trim();
}

function resolveCuisine(req, defaultVal = 'Restaurant') {
  const args = req.body?.args;
  let raw = args?.cuisine || req.body?.cuisine || defaultVal;
  if (typeof raw !== 'string') raw = String(raw || defaultVal);
  return raw.trim();
}

function normalizePhone(phone) {
  if (!phone) return '';
  const cleaned = phone.replace(/[\s\-\(\)\/]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  if (cleaned.startsWith('0')) return '+49' + cleaned.slice(1);
  return cleaned;
}

// ========== KONTAKT-HILFSFUNKTIONEN ==========

function normalizeContactName(name) {
  if (!name) return '';
  return String(name).toLowerCase().trim().replace(/\s+/g, '_');
}

function findContactInData(userData, searchName) {
  const normalized = normalizeContactName(searchName);

  const directKey = 'contact_' + normalized;
  if (userData[directKey + '_email'] || userData[directKey + '_telegram']) {
    return buildContactFromData(userData, normalized);
  }

  for (const key of Object.keys(userData)) {
    if (!key.startsWith('contact_') || !key.endsWith('_aliases')) continue;
    const aliases = String(userData[key] || '').toLowerCase();
    const aliasList = aliases.split(',').map(s => s.trim());
    if (aliasList.includes(normalized) || aliasList.includes(searchName.toLowerCase())) {
      const contactName = key.replace('contact_', '').replace('_aliases', '');
      return buildContactFromData(userData, contactName);
    }
  }

  const relationSearch = searchName.toLowerCase()
    .replace(/^(meine|mein|meiner)\s+/, '')
    .trim();
  for (const key of Object.keys(userData)) {
    if (!key.startsWith('contact_') || !key.endsWith('_relation')) continue;
    const relation = String(userData[key] || '').toLowerCase();
    if (relation === relationSearch) {
      const contactName = key.replace('contact_', '').replace('_relation', '');
      return buildContactFromData(userData, contactName);
    }
  }

  return null;
}

function buildContactFromData(userData, contactName) {
  const prefix = 'contact_' + contactName + '_';
  return {
    name: contactName,
    email: userData[prefix + 'email'] || null,
    telegram: userData[prefix + 'telegram'] || null,
    phone: userData[prefix + 'phone'] || null,
    aliases: userData[prefix + 'aliases'] || null,
    relation: userData[prefix + 'relation'] || null,
    birthday: userData[prefix + 'birthday'] || null,
    tone: userData[prefix + 'tone'] || null,
    notes: userData[prefix + 'notes'] || null,
    learned: userData[prefix + 'learned'] || null,
  };
}

function findGroupInData(userData, searchName) {
  const normalized = normalizeContactName(searchName);
  const directKey = 'group_' + normalized + '_members';
  if (userData[directKey]) {
    return buildGroupFromData(userData, normalized);
  }
  return null;
}

function buildGroupFromData(userData, groupName) {
  const prefix = 'group_' + groupName + '_';
  const membersRaw = userData[prefix + 'members'] || '';
  const members = membersRaw.split(',').map(s => s.trim()).filter(Boolean);
  return {
    name: groupName,
    members: members,
    notes: userData[prefix + 'notes'] || null,
    learned: userData[prefix + 'learned'] || null,
  };
}

// ========== ENDPUNKTE ==========

app.get('/', (req, res) => res.send('Server läuft erfolgreich!'));

// -------- Debug --------
app.get('/api/debug/user/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const result = await pool.query(
      'SELECT data, updated_at FROM user_data WHERE user_id = $1',
      [userId]
    );
    if (result.rows.length === 0) {
      return res.json({ user_id: userId, data: {}, message: 'Keine Daten' });
    }
    res.json({
      user_id: userId,
      data: result.rows[0].data,
      updated_at: result.rows[0].updated_at,
    });
  } catch (error) {
    console.error('❌ Debug-Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/all', async (req, res) => {
  try {
    const result = await pool.query('SELECT user_id, data, updated_at FROM user_data');
    res.json({ count: result.rows.length, users: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/debug/delete-key', async (req, res) => {
  try {
    const { user_id, key } = req.body;
    if (!user_id || !key) {
      return res.status(400).json({ error: 'user_id and key required' });
    }
    await pool.query(`
      UPDATE user_data
      SET data = data - $2::text,
          updated_at = NOW()
      WHERE user_id = $1
    `, [user_id, key]);
    console.log(`🗑️ Key "${key}" gelöscht für ${user_id}`);
    res.json({ success: true, deleted_key: key });
  } catch (error) {
    console.error('❌ Delete-Key Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/home/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const home = await pool.query(
      'SELECT * FROM user_home WHERE user_id = $1',
      [userId]
    );
    const presence = await pool.query(
      'SELECT * FROM user_presence WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 20',
      [userId]
    );
    res.json({
      user_id: userId,
      home: home.rows[0] || null,
      recent_presence: presence.rows,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/models', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No GEMINI_API_KEY' });
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const r = await fetch(url);
    const data = await r.json();
    if (!data.models) return res.json(data);
    const imageModels = data.models
      .filter(m =>
        m.name.includes('image') ||
        m.name.includes('imagen') ||
        (m.supportedGenerationMethods || []).includes('generateContent')
      )
      .map(m => ({
        name: m.name.replace('models/', ''),
        methods: m.supportedGenerationMethods || [],
      }));
    res.json({
      total: data.models.length,
      image_and_content_models: imageModels,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------- Profil --------
app.post('/api/profile/save', async (req, res) => {
  try {
    const { user_id, name, nickname, age, hometown } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const entries = {};
    if (name) entries.name = name;
    if (nickname) entries.nickname = nickname;
    if (age) entries.age = String(age);
    if (hometown) entries.hometown = hometown;

    if (Object.keys(entries).length === 0) {
      return res.status(400).json({ error: 'No fields to save' });
    }

    await pool.query(`
      INSERT INTO user_data (user_id, data)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (user_id) DO UPDATE
      SET data = user_data.data || $2::jsonb,
          updated_at = NOW()
    `, [user_id, JSON.stringify(entries)]);

    console.log('💾 Profil gespeichert für', user_id, ':', entries);
    res.json({ success: true, saved: entries });
  } catch (error) {
    console.error('❌ Profil-Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/profile/:userId', async (req, res) => {
  try {
    const data = await getUserData(req.params.userId);
    res.json({ user_id: req.params.userId, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== ANHANG-API ==========

app.post('/api/attachments/add', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { user_id, filename, mimeType, data } = args;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id required' });
    }
    if (!data) {
      return res.status(400).json({ error: 'data (Base64) required' });
    }

    const estimatedSize = Math.round(data.length * 0.75);
    if (estimatedSize > 20 * 1024 * 1024) {
      return res.status(413).json({
        error: 'Datei zu groß (max 20 MB pro Anhang)',
        size: estimatedSize,
      });
    }

    const item = addAttachment(user_id, filename, mimeType, data);
    const current = getAttachments(user_id);

    res.json({
      success: true,
      attachment: {
        id: item.id,
        filename: item.filename,
        mimeType: item.mimeType,
        size: item.size,
      },
      total: current.length,
    });
  } catch (error) {
    console.error('❌ attachment-add Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/attachments/list/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const list = getAttachments(userId);
    res.json({
      count: list.length,
      attachments: list.map(a => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        ageSeconds: Math.round((Date.now() - a.createdAt) / 1000),
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/attachments/remove', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { user_id, id } = args;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id required' });
    }

    const list = attachmentStore.get(user_id) || [];
    const filtered = id ? list.filter(a => a.id !== id) : [];
    attachmentStore.set(user_id, filtered);

    console.log(`🗑️ Anhang entfernt: ${id || 'alle'} (${list.length - filtered.length} Stück)`);
    res.json({ success: true, removed: list.length - filtered.length });
  } catch (error) {
    console.error('❌ attachment-remove Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/attachments/clear', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { user_id } = args;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const count = clearAttachments(user_id);
    res.json({ success: true, removed: count });
  } catch (error) {
    console.error('❌ attachment-clear Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== DRAFT-API ==========

app.post('/api/draft/save', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { user_id, to, subject, body, tone } = args;

    if (!user_id || !to || !subject || !body) {
      return res.status(400).json({ error: 'user_id, to, subject, body required' });
    }

    const { setDraft } = await import('./server/chat.js');
    const draft = setDraft(user_id, { to, subject, body, tone: tone || 'persönlich' });

    broadcastToClients({
      type: 'draft_shown',
      draft: {
        id: draft.id,
        to: draft.to,
        subject: draft.subject,
        body: draft.body,
        tone: draft.tone,
        attachments: getAttachments(user_id).map(a => ({
          id: a.id,
          filename: a.filename,
          size: a.size,
        })),
      },
    });

    res.json({ success: true, draft_id: draft.id });
  } catch (error) {
    console.error('❌ draft-save Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/draft/send', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { user_id } = args;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id required' });
    }

    const draft = getDraft(user_id);
    if (!draft) {
      return res.status(404).json({ error: 'Kein Entwurf gefunden (abgelaufen?)' });
    }

    const profileData = await getUserData(user_id);
    const profile = { ...profileData, user_id };
    const attachments = getAttachments(user_id);

    console.log(`📧 Draft-Bestätigung: an ${draft.to} (Ton: ${draft.tone}, Anhänge: ${attachments.length})`);

    const recipients = String(draft.to).split(',').map(e => e.trim()).filter(Boolean);
    const results = [];
    const errors = [];

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      try {
        await sendEmail(recipient, draft.subject, draft.body, profile, draft.tone, attachments);
        results.push({ to: recipient, status: 'ok' });
      } catch (e) {
        console.error(`❌ Fehler bei ${recipient}:`, e.message);
        errors.push({ to: recipient, error: e.message });
      }
      if (i < recipients.length - 1) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

    clearDraft(user_id);
    clearAttachments(user_id);

        broadcastToClients({
      type: 'draft_sent',
      sent: results.length,
      failed: errors.length,
    });

    // ✅ Jony-Feedback im Chat — Text + Persistenz
    let confirmText;
    if (errors.length === 0) {
      confirmText = `✅ E-Mail an ${recipients.join(', ')} ist raus.`;
    } else if (results.length === 0) {
      confirmText = `❌ Versand fehlgeschlagen. Grund: ${errors[0]?.error || 'unbekannt'}`;
    } else {
      confirmText = `⚠️ ${results.length} gesendet, ${errors.length} fehlgeschlagen.`;
    }

    try {
      await pool.query(`
        INSERT INTO chat_history (user_id, role, content)
        VALUES ($1, 'assistant', $2)
      `, [user_id, confirmText]);
    } catch (e) {
      console.error('⚠️ Chat-History-Fehler (draft/send):', e.message);
    }

    // Live an alle verbundenen Clients broadcasten
    broadcastToClients({
      type: 'transcript',
      role: 'assistant',
      text: confirmText,
    });

    console.log(`📢 Jony-Feedback: "${confirmText}"`);

    res.json({
      success: errors.length === 0,
      sent: results.length,
      failed: errors.length,
      results,
      errors,
      attachmentCount: attachments.length,
      message: confirmText,
    });
  } catch (error) {
    console.error('❌ draft-send Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/draft/cancel', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { user_id } = args;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const had = clearDraft(user_id);
    clearAttachments(user_id);

    broadcastToClients({ type: 'draft_cancelled' });

    console.log(`❌ Draft abgebrochen für ${user_id.substring(0,8)}...`);
    res.json({ success: true, had_draft: had });
  } catch (error) {
    console.error('❌ draft-cancel Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/draft/get/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const draft = getDraft(userId);
    const attachments = getAttachments(userId);

    if (!draft) {
      return res.json({ has_draft: false, attachments: [] });
    }

    res.json({
      has_draft: true,
      draft: {
        id: draft.id,
        to: draft.to,
        subject: draft.subject,
        body: draft.body,
        tone: draft.tone,
        ageSeconds: Math.round((Date.now() - draft.createdAt) / 1000),
      },
      attachments: attachments.map(a => ({
        id: a.id,
        filename: a.filename,
        size: a.size,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== DRAFT-UPDATE ==========

app.post('/api/draft/update', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { user_id, to, subject, body, tone } = args;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id required' });
    }

    const { getDraft, setDraft } = await import('./server/chat.js');
    const existing = getDraft(user_id);

    if (!existing) {
      return res.status(404).json({ error: 'Kein Entwurf gefunden (abgelaufen?)' });
    }

    // Nur Felder überschreiben, die mitgeschickt wurden
    const updated = setDraft(user_id, {
      to: to !== undefined ? to : existing.to,
      subject: subject !== undefined ? subject : existing.subject,
      body: body !== undefined ? body : existing.body,
      tone: tone !== undefined ? tone : existing.tone,
    });

    console.log(`✏️ Draft aktualisiert für ${user_id.substring(0,8)}...`);
    res.json({
      success: true,
      draft: {
        id: updated.id,
        to: updated.to,
        subject: updated.subject,
        body: updated.body,
        tone: updated.tone,
      },
    });
  } catch (error) {
    console.error('❌ draft-update Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== TELEGRAM CAROUSEL SEND ==========

app.post('/api/telegram/send-carousel', async (req, res) => {
  try {
    const { chat_id, topic, slides, images } = req.body || {};

    if (!chat_id || !topic) {
      return res.status(400).json({ error: 'chat_id and topic required' });
    }

    const { sendTelegramCarousel } = await import('./server/telegram.js');
    const result = await sendTelegramCarousel(chat_id, topic, slides || [], images || []);

    console.log(`✅ Karussell an Telegram gesendet: ${result.imagesSent} Bilder`);
    res.json(result);
  } catch (error) {
    console.error('❌ telegram-send-carousel Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== TELEGRAM-SEND ==========

app.post('/api/telegram/send', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { chat_id, text } = args;

    if (!chat_id || !text) {
      return res.status(400).json({ error: 'chat_id and text required' });
    }

    const result = await sendTelegramMessage(chat_id, text);

    console.log(`📨 Telegram gesendet an ${chat_id}`);
    res.json({ success: true, to: chat_id });
  } catch (error) {
    console.error('❌ telegram-send Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== KONTAKT-API ==========

app.post('/api/contacts/find', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { user_id, name } = args;

    if (!user_id || !name) {
      return res.status(400).json({ error: 'user_id and name required' });
    }

    const userData = await getUserData(user_id);
    const contact = findContactInData(userData, name);

    if (contact) {
      console.log(`🔍 Kontakt gefunden: "${name}" → ${contact.name}`);
      return res.json({ found: true, contact });
    }

    console.log(`🔍 Kontakt NICHT gefunden: "${name}"`);
    return res.json({ found: false, name });
  } catch (error) {
    console.error('❌ find-contact Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/contacts/save', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { user_id, name, email, telegram, phone, aliases, relation, birthday, tone, notes } = args;

    if (!user_id || !name) {
      return res.status(400).json({ error: 'user_id and name required' });
    }

    const normalized = normalizeContactName(name);
    const prefix = 'contact_' + normalized + '_';

    const updates = {};
    if (email) updates[prefix + 'email'] = String(email).trim();
    if (telegram) updates[prefix + 'telegram'] = String(telegram).trim();
    if (phone) updates[prefix + 'phone'] = String(phone).trim();
    if (aliases) updates[prefix + 'aliases'] = String(aliases).trim();
    if (relation) updates[prefix + 'relation'] = String(relation).trim();
    if (birthday) updates[prefix + 'birthday'] = String(birthday).trim();
    if (tone) updates[prefix + 'tone'] = String(tone).trim();
    if (notes) updates[prefix + 'notes'] = String(notes).trim();
    updates[prefix + 'learned'] = new Date().toISOString();

    if (Object.keys(updates).length <= 1) {
      return res.status(400).json({ error: 'Keine Felder zum Speichern' });
    }

    await pool.query(`
      INSERT INTO user_data (user_id, data)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (user_id) DO UPDATE
      SET data = user_data.data || $2::jsonb,
          updated_at = NOW()
    `, [user_id, JSON.stringify(updates)]);

    console.log(`💾 Kontakt gespeichert: "${name}"`);
    res.json({ success: true, name: normalized, saved_fields: Object.keys(updates) });
  } catch (error) {
    console.error('❌ save-contact Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/contacts/forget', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { user_id, name } = args;

    if (!user_id || !name) {
      return res.status(400).json({ error: 'user_id and name required' });
    }

    const normalized = normalizeContactName(name);
    const prefix = 'contact_' + normalized + '_';

    await pool.query(`
      UPDATE user_data
      SET data = data - ARRAY(
        SELECT jsonb_object_keys(data)
        WHERE jsonb_object_keys(data) LIKE $2
      ),
      updated_at = NOW()
      WHERE user_id = $1
    `, [user_id, prefix + '%']);

    console.log(`🗑️ Kontakt gelöscht: "${name}"`);
    res.json({ success: true, forgotten: normalized });
  } catch (error) {
    console.error('❌ forget-contact Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/contacts/list/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const userData = await getUserData(userId);

    const names = new Set();
    for (const key of Object.keys(userData)) {
      if (!key.startsWith('contact_')) continue;
      const match = key.match(/^contact_(.+?)_(email|telegram|phone|aliases|relation|birthday|tone|notes|learned)$/);
      if (match) names.add(match[1]);
    }

    const contacts = [];
    for (const name of names) {
      const contact = buildContactFromData(userData, name);
      if (contact.email || contact.telegram || contact.phone) {
        contacts.push(contact);
      }
    }

    contacts.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ count: contacts.length, contacts });
  } catch (error) {
    console.error('❌ list-contacts Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/contacts/resolve', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { user_id, names } = args;

    if (!user_id || !names || !Array.isArray(names)) {
      return res.status(400).json({ error: 'user_id and names[] required' });
    }

    const userData = await getUserData(user_id);
    const resolved = [];
    const missing = [];
    const seenContacts = new Set();

    for (const item of names) {
      const group = findGroupInData(userData, item);
      if (group && group.members.length > 0) {
        console.log(`👥 Gruppe "${item}" → ${group.members.length} Mitglieder`);
        for (const memberName of group.members) {
          const member = findContactInData(userData, memberName);
          if (member && !seenContacts.has(member.name)) {
            seenContacts.add(member.name);
            resolved.push({ ...member, via_group: group.name });
          } else if (!member) {
            missing.push(memberName + ' (in Gruppe ' + group.name + ')');
          }
        }
        continue;
      }

      const contact = findContactInData(userData, item);
      if (contact) {
        if (!seenContacts.has(contact.name)) {
          seenContacts.add(contact.name);
          resolved.push(contact);
        }
      } else {
        missing.push(item);
      }
    }

    console.log(`🔍 Resolve: ${resolved.length} gefunden, ${missing.length} fehlen`);

    res.json({
      resolved,
      missing,
      complete: missing.length === 0,
    });
  } catch (error) {
    console.error('❌ resolve Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== GRUPPEN-API ==========

app.post('/api/groups/save', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { user_id, name, members, notes } = args;

    if (!user_id || !name) {
      return res.status(400).json({ error: 'user_id and name required' });
    }
    if (!members) {
      return res.status(400).json({ error: 'members required' });
    }

    let membersList;
    if (Array.isArray(members)) {
      membersList = members.map(m => String(m).trim()).filter(Boolean);
    } else {
      membersList = String(members).split(',').map(m => m.trim()).filter(Boolean);
    }

    if (membersList.length === 0) {
      return res.status(400).json({ error: 'members list ist leer' });
    }

    const normalized = normalizeContactName(name);
    const prefix = 'group_' + normalized + '_';

    const updates = {};
    updates[prefix + 'members'] = membersList.join(',');
    if (notes) updates[prefix + 'notes'] = String(notes).trim();
    updates[prefix + 'learned'] = new Date().toISOString();

    await pool.query(`
      INSERT INTO user_data (user_id, data)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (user_id) DO UPDATE
      SET data = user_data.data || $2::jsonb,
          updated_at = NOW()
    `, [user_id, JSON.stringify(updates)]);

    console.log(`👥 Gruppe gespeichert: "${name}" → [${membersList.join(', ')}]`);
    res.json({ success: true, name: normalized, members: membersList });
  } catch (error) {
    console.error('❌ save-group Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/groups/find', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { user_id, name } = args;

    if (!user_id || !name) {
      return res.status(400).json({ error: 'user_id and name required' });
    }

    const userData = await getUserData(user_id);
    const group = findGroupInData(userData, name);

    if (group) {
      console.log(`👥 Gruppe gefunden: "${name}"`);
      return res.json({ found: true, group });
    }

    console.log(`👥 Gruppe NICHT gefunden: "${name}"`);
    return res.json({ found: false, name });
  } catch (error) {
    console.error('❌ find-group Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/groups/forget', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { user_id, name } = args;

    if (!user_id || !name) {
      return res.status(400).json({ error: 'user_id and name required' });
    }

    const normalized = normalizeContactName(name);
    const prefix = 'group_' + normalized + '_';

    await pool.query(`
      UPDATE user_data
      SET data = data - ARRAY(
        SELECT jsonb_object_keys(data)
        WHERE jsonb_object_keys(data) LIKE $2
      ),
      updated_at = NOW()
      WHERE user_id = $1
    `, [user_id, prefix + '%']);

    console.log(`🗑️ Gruppe gelöscht: "${name}"`);
    res.json({ success: true, forgotten: normalized });
  } catch (error) {
    console.error('❌ forget-group Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/groups/list/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const userData = await getUserData(userId);

    const names = new Set();
    for (const key of Object.keys(userData)) {
      if (!key.startsWith('group_')) continue;
      const match = key.match(/^group_(.+?)_(members|notes|learned)$/);
      if (match) names.add(match[1]);
    }

    const groups = [];
    for (const name of names) {
      const group = buildGroupFromData(userData, name);
      if (group.members.length > 0) {
        groups.push(group);
      }
    }

    groups.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ count: groups.length, groups });
  } catch (error) {
    console.error('❌ list-groups Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== NUTZER-PROFIL ==========

app.post('/api/user-profile/save', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { user_id, name, address, birthdate, phone, default_email, default_tone } = args;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id required' });
    }

    const updates = {};
    if (name) updates['user_name'] = String(name).trim();
    if (address) updates['user_address'] = String(address).trim();
    if (birthdate) updates['user_birthdate'] = String(birthdate).trim();
    if (phone) updates['user_phone'] = String(phone).trim();
    if (default_email) updates['user_email_default'] = String(default_email).trim();
    if (default_tone) updates['user_tone_default'] = String(default_tone).trim();

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Keine Felder' });
    }

    await pool.query(`
      INSERT INTO user_data (user_id, data)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (user_id) DO UPDATE
      SET data = user_data.data || $2::jsonb,
          updated_at = NOW()
    `, [user_id, JSON.stringify(updates)]);

    console.log(`💾 Nutzer-Profil gespeichert:`, Object.keys(updates));
    res.json({ success: true, saved: updates });
  } catch (error) {
    console.error('❌ user-profile Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

// -------- Retell Backup --------
app.post('/api/create-web-call', async (req, res) => {
  try {
    const userId = req.body.user_id;
    const agentId = 'agent_74a4972eb9f76b3e76c9291302';
    const userData = userId ? await getUserData(userId) : {};
    console.log('📦 Geladene User-Daten:', JSON.stringify(userData));

    const response = await fetch('https://api.retellai.com/v2/create-web-call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RETELL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: agentId,
        retell_llm_dynamic_variables: {
          user_id: userId || '',
          customer_name: userData.name || req.body.customerName || 'Gast',
          location: req.body.location || '',
        },
      }),
    });

    if (!response.ok) {
      const t = await response.text();
      return res.status(500).json({ error: 'Failed', details: t });
    }
    const call = await response.json();
    res.json({ accessToken: call.access_token, callId: call.call_id });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// -------- Save Preference --------
app.post('/api/save-preference', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const userId = args.user_id;
    const key = args.key;
    const value = args.value;

    console.log('💾 ===== PRÄFERENZ SPEICHERN =====');
    console.log('💾 user_id:', userId);
    console.log('💾 key:', key);
    console.log('💾 value:', value);

    if (!userId || !key || value === undefined) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const valueStr = String(value).trim();
    if (valueStr === 'User Name' || valueStr === 'undefined' || valueStr === '') {
      console.log('⚠️ Ungültiger Wert – verworfen');
      return res.json({ success: false, message: 'Invalid value' });
    }

    const ok = await saveUserPref(userId, key, valueStr);
    if (ok) {
      console.log('✅ Gespeichert:', key, '=', valueStr);
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'Save failed' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------- Delete User Data --------
app.post('/api/delete-user-data', async (req, res) => {
  try {
    const userId = req.body?.user_id || req.body?.args?.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id required' });
    await pool.query('DELETE FROM user_data WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM user_presence WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM user_home WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM chat_history WHERE user_id = $1', [userId]);
    clearAttachments(userId);
    clearDraft(userId);
    console.log('🗑️ Daten gelöscht für', userId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------- Wetter --------
app.post('/api/get-weather', async (req, res) => {
  try {
    const location = resolveLocation(req);
    const timeframe = resolveTimeframe(req);
    if (!location) return res.status(400).json({ error: 'Location required' });

    const apiKey = process.env.OPENWEATHER_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OWM key missing' });

    const geoUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(location)}&limit=1&appid=${apiKey}`;
    const geoData = await (await fetch(geoUrl)).json();
    if (!geoData?.length) return res.status(404).json({ error: 'Location not found' });

    const { lat, lon, name, country } = geoData[0];
    const oneCallUrl = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric&lang=de&exclude=minutely,hourly`;
    const oneCallData = await (await fetch(oneCallUrl)).json();
    if (!oneCallData?.current) return res.status(500).json({ error: 'Weather fetch failed' });

    const windDir = (deg) => ['N','NO','O','SO','S','SW','W','NW'][Math.round((deg || 0) / 45) % 8];
    const current = {
      temp: Math.round(oneCallData.current.temp),
      feels_like: Math.round(oneCallData.current.feels_like),
      description: oneCallData.current.weather[0].description,
      humidity: oneCallData.current.humidity,
      wind_speed: Math.round(oneCallData.current.wind_speed * 3.6),
      wind_dir: windDir(oneCallData.current.wind_deg),
    };

    const days = (oneCallData.daily || []).slice(0, 8).map(day => {
      const dt = new Date(day.dt * 1000);
      return {
        date: dt.toISOString().slice(0, 10),
        weekday: dt.toLocaleDateString('de-DE', { weekday: 'long' }),
        min: Math.round(day.temp.min),
        max: Math.round(day.temp.max),
        description: day.weather[0].description,
        rain_chance: Math.round((day.pop || 0) * 100),
      };
    });

    res.json({
      location: name, country, timeframe, current,
      today: days[0], tomorrow: days[1], next_days: days.slice(2), all_days: days,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------- Restaurants --------
app.post('/api/search-restaurant', async (req, res) => {
  try {
    const location = resolveLocation(req);
    const cuisine = resolveCuisine(req);
    if (!location) return res.status(400).json({ error: 'Location required' });

    const query = `${cuisine} in ${location}`;
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.nationalPhoneNumber,places.internationalPhoneNumber,places.regularOpeningHours,places.priceLevel',
      },
      body: JSON.stringify({ textQuery: query, languageCode: 'de', maxResultCount: 10 }),
    });

    if (!response.ok) return res.status(500).json({ error: 'Places API error' });
    const data = await response.json();
    const filtered = (data.places || [])
      .filter(p => (p.rating || 0) >= 4.0)
      .sort((a, b) => (b.rating || 0) - (a.rating || 0))
      .slice(0, 3);

    const results = filtered.map(p => ({
      name: p.displayName?.text || 'Unbekannt',
      address: p.formattedAddress || '',
      rating: p.rating || 0,
      reviews: p.userRatingCount || 0,
      phone: p.internationalPhoneNumber || normalizePhone(p.nationalPhoneNumber || ''),
      openNow: p.regularOpeningHours?.openNow ?? null,
    }));

    res.json({ count: results.length, restaurants: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== CHAT-MODUS ==========

app.post('/api/chat', async (req, res) => {
  try {
    const { user_id, message, role, mode, lat, lon, city } = req.body;
    if (!user_id || !message) {
      return res.status(400).json({ error: 'user_id und message required' });
    }

    const currentLocation = (lat && lon)
      ? { lat: parseFloat(lat), lon: parseFloat(lon), city: city || null }
      : (city ? { city } : null);

    const attachments = getAttachments(user_id);

    const result = await handleChatMessage(
      user_id,
      message,
      role || 'freund',
      mode || 'jony',
      currentLocation,
      attachments
    );
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('❌ Chat-Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/chat/history/:userId', async (req, res) => {
  try {
    const history = await getChatHistory(req.params.userId);
    res.json({ user_id: req.params.userId, history });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== EMAIL ==========

app.get('/api/email/status', (req, res) => {
  try {
    res.json(getEmailStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send-email', async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const { to, subject, body, tone, profile } = args;

    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'to, subject, body required' });
    }

    const recipients = String(to)
      .split(',')
      .map(e => e.trim())
      .filter(Boolean);

    if (recipients.length === 0) {
      return res.status(400).json({ error: 'keine gültigen Empfänger' });
    }

    const finalTone = tone || 'persönlich';

    let finalAttachments = [];
    if (args.attachments && Array.isArray(args.attachments) && args.attachments.length > 0) {
      finalAttachments = args.attachments;
    } else if (profile?.user_id) {
      finalAttachments = getAttachments(profile.user_id);
    }

    console.log(`📧 Sende an ${recipients.length} Empfänger: ${recipients.join(', ')} (Ton: ${finalTone}, Anhänge: ${finalAttachments.length})`);

    const results = [];
    const errors = [];

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      try {
        await sendEmail(recipient, subject, body, profile || {}, finalTone, finalAttachments);
        results.push({ to: recipient, status: 'ok' });
      } catch (e) {
        console.error(`❌ Fehler bei ${recipient}:`, e.message);
        errors.push({ to: recipient, error: e.message });
      }

      if (i < recipients.length - 1) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

    if (results.length > 0 && profile?.user_id) {
      clearAttachments(profile.user_id);
      clearDraft(profile.user_id);
    }

    // ⬇️ App informieren — Karte verschwinden lassen
    if (results.length > 0) {
      broadcastToClients({
        type: 'draft_sent',
        sent: results.length,
        failed: errors.length,
      });
    }

    res.json({
      success: errors.length === 0,
      sent: results.length,
      failed: errors.length,
      results,
      errors,
      attachmentCount: finalAttachments.length,
    });
  } catch (error) {
    console.error('❌ send-email Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== TELEGRAM ==========

app.get('/api/telegram/status', (req, res) => {
  try {
    res.json(getTelegramStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/telegram/webhook-info', async (req, res) => {
  try {
    const info = await getTelegramWebhookInfo();
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ========== TOKEN-TRACKING ==========

// Zusammenfassung pro User
app.get('/api/token-usage/summary/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const days = parseInt(req.query.days) || 30;

    const result = await pool.query(`
      SELECT
        source,
        model,
        COUNT(*)::int AS requests,
        SUM(input_tokens)::int AS input_total,
        SUM(output_tokens)::int AS output_total,
        SUM(total_tokens)::int AS total,
        SUM(tool_calls)::int AS tools
      FROM token_usage
      WHERE user_id = $1
        AND created_at > NOW() - INTERVAL '${days} days'
      GROUP BY source, model
      ORDER BY total DESC
    `, [userId]);

    const grand = await pool.query(`
      SELECT
        COUNT(*)::int AS requests,
        COALESCE(SUM(total_tokens), 0)::int AS tokens
      FROM token_usage
      WHERE user_id = $1
        AND created_at > NOW() - INTERVAL '${days} days'
    `, [userId]);

    res.json({
      user_id: userId,
      days,
      total_requests: grand.rows[0].requests,
      total_tokens: grand.rows[0].tokens,
      by_source: result.rows,
    });
  } catch (error) {
    console.error('❌ token-usage summary:', error);
    res.status(500).json({ error: error.message });
  }
});

// Rohdaten (letzte N)
app.get('/api/token-usage/raw/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);

    const result = await pool.query(`
      SELECT id, source, model, input_tokens, output_tokens,
             total_tokens, tool_calls, created_at
      FROM token_usage
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [userId, limit]);

    res.json({ user_id: userId, count: result.rows.length, entries: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Tagesverlauf
app.get('/api/token-usage/daily/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const days = parseInt(req.query.days) || 30;

    const result = await pool.query(`
      SELECT
        DATE(created_at) AS day,
        COUNT(*)::int AS requests,
        SUM(input_tokens)::int AS input_total,
        SUM(output_tokens)::int AS output_total,
        SUM(total_tokens)::int AS total
      FROM token_usage
      WHERE user_id = $1
        AND created_at > NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at)
      ORDER BY day DESC
    `, [userId]);

    res.json({ user_id: userId, days, daily: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Gesamt (alle User)
app.get('/api/token-usage/all', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const result = await pool.query(`
      SELECT
        user_id,
        source,
        COUNT(*)::int AS requests,
        SUM(total_tokens)::int AS tokens
      FROM token_usage
      WHERE created_at > NOW() - INTERVAL '${days} days'
      GROUP BY user_id, source
      ORDER BY tokens DESC
    `);
    res.json({ days, users: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ========== TOKEN-TRACKING ==========

app.get('/api/token-usage/summary/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const days = parseInt(req.query.days) || 30;
    const result = await pool.query(`
      SELECT source, model, COUNT(*)::int AS requests,
        SUM(input_tokens)::int AS input_total,
        SUM(output_tokens)::int AS output_total,
        SUM(total_tokens)::int AS total,
        SUM(tool_calls)::int AS tools
      FROM token_usage
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '${days} days'
      GROUP BY source, model
      ORDER BY total DESC
    `, [userId]);
    const grand = await pool.query(`
      SELECT COUNT(*)::int AS requests, COALESCE(SUM(total_tokens), 0)::int AS tokens
      FROM token_usage
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '${days} days'
    `, [userId]);
    res.json({
      user_id: userId, days,
      total_requests: grand.rows[0].requests,
      total_tokens: grand.rows[0].tokens,
      by_source: result.rows,
    });
  } catch (error) {
    console.error('❌ token-usage summary:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/token-usage/raw/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const result = await pool.query(`
      SELECT id, source, model, input_tokens, output_tokens, total_tokens, tool_calls, created_at
      FROM token_usage WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2
    `, [userId, limit]);
    res.json({ user_id: userId, count: result.rows.length, entries: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/token-usage/daily/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const days = parseInt(req.query.days) || 30;
    const result = await pool.query(`
      SELECT DATE(created_at) AS day, COUNT(*)::int AS requests,
        SUM(input_tokens)::int AS input_total,
        SUM(output_tokens)::int AS output_total,
        SUM(total_tokens)::int AS total
      FROM token_usage
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at) ORDER BY day DESC
    `, [userId]);
    res.json({ user_id: userId, days, daily: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/token-usage/all', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const result = await pool.query(`
      SELECT user_id, source, COUNT(*)::int AS requests, SUM(total_tokens)::int AS tokens
      FROM token_usage
      WHERE created_at > NOW() - INTERVAL '${days} days'
      GROUP BY user_id, source ORDER BY tokens DESC
    `);
    res.json({ days, users: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ========== TELEGRAM USER-MAP ==========

// UUID v4 Generator (ohne extra Dependency)
function genUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// Owner-Einstellungen aus ENV
const TELEGRAM_OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID || '8448058381';
const TELEGRAM_OWNER_USER_ID = process.env.TELEGRAM_OWNER_USER_ID || '0e9d40d8-af3c-4e78-9654-0cb4f3077e19';
const TELEGRAM_KIDS_CHAT_ID = process.env.TELEGRAM_KIDS_CHAT_ID || '';

// Chat-ID → user_id nachschlagen oder neu anlegen
app.post('/api/telegram/lookup-user', async (req, res) => {
  try {
    const { chat_id, from_name } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'chat_id required' });

    const chatIdStr = String(chat_id);

    // 1. Prüfen ob schon gemappt
    const existing = await pool.query(
      'SELECT user_id, is_kids FROM telegram_user_map WHERE chat_id = $1',
      [chatIdStr]
    );

    if (existing.rows.length > 0) {
      // last_seen aktualisieren
      await pool.query(
        'UPDATE telegram_user_map SET last_seen = NOW() WHERE chat_id = $1',
        [chatIdStr]
      );
      const row = existing.rows[0];
      console.log(`🔍 Telegram-Lookup: ${chatIdStr} → ${row.user_id.substring(0,8)}... (bekannt, kids: ${row.is_kids})`);
      return res.json({ user_id: row.user_id, is_kids: row.is_kids, is_new: false });
    }

    // 2. Neuer User → user_id bestimmen
    let newUserId;
    let isKids = false;

    // Owner-Sonderfall
    if (chatIdStr === TELEGRAM_OWNER_CHAT_ID) {
      newUserId = TELEGRAM_OWNER_USER_ID;
    } else if (TELEGRAM_KIDS_CHAT_ID && chatIdStr === TELEGRAM_KIDS_CHAT_ID) {
      newUserId = genUUID();
      isKids = true;
    } else {
      newUserId = genUUID();
    }

    // 3. In Map eintragen
    await pool.query(`
      INSERT INTO telegram_user_map (chat_id, user_id, display_name, is_kids)
      VALUES ($1, $2, $3, $4)
    `, [chatIdStr, newUserId, from_name || 'Unbekannt', isKids]);

    // 4. user_data-Eintrag anlegen (falls neu)
    if (newUserId !== TELEGRAM_OWNER_USER_ID) {
      await pool.query(`
        INSERT INTO user_data (user_id, data)
        VALUES ($1, $2::jsonb)
        ON CONFLICT (user_id) DO NOTHING
      `, [newUserId, JSON.stringify({
        telegram_chat_id: chatIdStr,
        name: from_name || 'Unbekannt',
      })]);
    }

    console.log(`🔍 Telegram-Lookup: ${chatIdStr} → ${newUserId.substring(0,8)}... (NEU, kids: ${isKids})`);
    res.json({ user_id: newUserId, is_kids: isKids, is_new: true });
  } catch (error) {
    console.error('❌ telegram-lookup-user:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug: Alle Mappings sehen
app.get('/api/telegram/map', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT chat_id, user_id, display_name, is_kids, created_at, last_seen
      FROM telegram_user_map ORDER BY last_seen DESC
    `);
    res.json({ count: result.rows.length, mappings: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug: Einzelnes Mapping löschen (falls was schief läuft)
app.post('/api/telegram/unmap', async (req, res) => {
  try {
    const { chat_id } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'chat_id required' });
    const r = await pool.query('DELETE FROM telegram_user_map WHERE chat_id = $1', [String(chat_id)]);
    console.log(`🗑️ Telegram-Unmap: ${chat_id} (${r.rowCount} Zeile)`);
    res.json({ success: true, removed: r.rowCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ========== BACKUP ==========

app.get('/api/backup/export', async (req, res) => {
  try {
    console.log('💾 Backup-Export gestartet...');

    const userData = await pool.query('SELECT user_id, data, updated_at FROM user_data');
    const presence = await pool.query('SELECT * FROM user_presence');
    const home = await pool.query('SELECT * FROM user_home');
    const chats = await pool.query('SELECT * FROM chat_history');
    const tokens = await pool.query('SELECT * FROM token_usage');
    const telegramMap = await pool.query('SELECT * FROM telegram_user_map');

    const backup = {
      version: 1,
      created_at: new Date().toISOString(),
      counts: {
        user_data: userData.rows.length,
        presence: presence.rows.length,
        home: home.rows.length,
        chat_history: chats.rows.length,
        token_usage: tokens.rows.length,
        telegram_map: telegramMap.rows.length,
      },
      tables: {
        user_data: userData.rows,
        user_presence: presence.rows,
        user_home: home.rows,
        chat_history: chats.rows,
        token_usage: tokens.rows,
        telegram_user_map: telegramMap.rows,
      },
    };

    const json = JSON.stringify(backup, null, 2);
    const filename = `wetternavi-backup-${new Date().toISOString().split('T')[0]}.json`;

    console.log(`✅ Backup fertig: ${Math.round(json.length / 1024)} KB`);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(json);
  } catch (error) {
    console.error('❌ Backup-Export-Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

// Info ohne Download (nur Übersicht)
app.get('/api/backup/info', async (req, res) => {
  try {
    const userData = await pool.query('SELECT COUNT(*)::int AS c FROM user_data');
    const chats = await pool.query('SELECT COUNT(*)::int AS c FROM chat_history');
    const tokens = await pool.query('SELECT COUNT(*)::int AS c FROM token_usage');
    const map = await pool.query('SELECT COUNT(*)::int AS c FROM telegram_user_map');
    res.json({
      user_data: userData.rows[0].c,
      chat_history: chats.rows[0].c,
      token_usage: tokens.rows[0].c,
      telegram_map: map.rows[0].c,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Restore — nur nutzen wenn nötig!
app.post('/api/backup/import', async (req, res) => {
  try {
    const backup = req.body;
    if (!backup || !backup.tables || backup.version !== 1) {
      return res.status(400).json({ error: 'Ungültiges Backup-Format' });
    }

    console.log('📥 Backup-Import gestartet...');
    const stats = {};

    // user_data
    if (backup.tables.user_data) {
      let count = 0;
      for (const row of backup.tables.user_data) {
        await pool.query(`
          INSERT INTO user_data (user_id, data, updated_at)
          VALUES ($1, $2::jsonb, $3)
          ON CONFLICT (user_id) DO UPDATE
          SET data = $2::jsonb, updated_at = $3
        `, [row.user_id, JSON.stringify(row.data), row.updated_at || new Date()]);
        count++;
      }
      stats.user_data = count;
    }

    // telegram_user_map
    if (backup.tables.telegram_user_map) {
      let count = 0;
      for (const row of backup.tables.telegram_user_map) {
        await pool.query(`
          INSERT INTO telegram_user_map (chat_id, user_id, display_name, is_kids, created_at, last_seen)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (chat_id) DO NOTHING
        `, [row.chat_id, row.user_id, row.display_name, row.is_kids, row.created_at, row.last_seen]);
        count++;
      }
      stats.telegram_user_map = count;
    }

    // home
    if (backup.tables.user_home) {
      let count = 0;
      for (const row of backup.tables.user_home) {
        await pool.query(`
          INSERT INTO user_home (user_id, home_lat, home_lon, confidence, updated_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (user_id) DO UPDATE
          SET home_lat = $2, home_lon = $3, confidence = $4, updated_at = $5
        `, [row.user_id, row.home_lat, row.home_lon, row.confidence, row.updated_at]);
        count++;
      }
      stats.user_home = count;
    }

    console.log('✅ Backup-Import fertig:', stats);
    res.json({ success: true, restored: stats });
  } catch (error) {
    console.error('❌ Backup-Import-Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== SENSOR-BUS ==========
const sensorBus = new SensorBus();
sensorBus.onEvent((e) => console.log('📡 SENSOR-EVENT:', JSON.stringify(e.toJSON())));

// ========== SERVER START ==========
const server = http.createServer(app);
setupGeminiWebSocket(server);

server.listen(PORT, async () => {
  console.log(`🚀 Server läuft auf http://0.0.0.0:${PORT}`);
  console.log(`🔌 WebSocket: ws://0.0.0.0:${PORT}/ws/gemini-live`);
  console.log(`🌐 Public Domain: ${process.env.RAILWAY_PUBLIC_DOMAIN || '(nicht gesetzt)'}`);

  await initDb();

  try {
    await initChatTable();
  } catch (e) {
    console.error('❌ Chat-Init-Fehler:', e.message);
  }

  try {
    const tgBot = await initTelegram();
    if (tgBot) {
      const webhookPath = getTelegramWebhookPath();
      const webhookCallback = getTelegramWebhookCallback();

      if (webhookPath && webhookCallback) {
        app.post(webhookPath, webhookCallback);
        console.log(`📱 Telegram-Webhook-Route registriert: ${webhookPath}`);
      } else {
        console.error('❌ Telegram-Webhook-Callback nicht verfügbar!');
      }

      const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
      if (domain) {
        await setTelegramWebhook(domain);
      } else {
        console.error('❌ RAILWAY_PUBLIC_DOMAIN fehlt – kann Webhook nicht setzen!');
      }

      console.log('📱 Telegram initialisiert');
    }
  } catch (e) {
    console.error('❌ Telegram-Init-Fehler:', e.message);
  }

  try {
    initEmail();
  } catch (e) {
    console.error('❌ E-Mail-Init-Fehler:', e.message);
  }
});