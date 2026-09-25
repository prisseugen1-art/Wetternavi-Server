// server.js

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import http from 'http';
import { SensorEvent, SensorBus, SensorSource } from './sensors/sensor_events.js';
import { setupGeminiWebSocket } from './server/gemini_live.js';
import { initWhatsApp, getWhatsAppStatus, getWhatsAppQr, disconnectWhatsApp } from './server/whatsapp.js';

dotenv.config();

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

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

// ========== ENDPUNKTE ==========

// Health Check
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

// -------- Debug: Key löschen --------
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

// -------- Debug: Home + Presence --------
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

// -------- Debug: Verfügbare Modelle --------
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

// -------- Profil: Speichern --------
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

// -------- Profil: Laden --------
app.get('/api/profile/:userId', async (req, res) => {
  try {
    const data = await getUserData(req.params.userId);
    res.json({ user_id: req.params.userId, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------- Create Web Call (Retell Backup) --------
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

// ========== WHATSAPP ==========

// -------- Status --------
app.get('/api/whatsapp/status', (req, res) => {
  try {
    res.json(getWhatsAppStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------- QR-Code (als String) --------
app.get('/api/whatsapp/qr', (req, res) => {
  try {
    const qr = getWhatsAppQr();
    if (!qr) {
      return res.status(404).json({ error: 'Kein QR-Code verfügbar', hint: 'Session läuft bereits oder ist getrennt' });
    }
    res.json({ qr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------- Trennen --------
app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    await disconnectWhatsApp();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

  await initDb();

  // WhatsApp initialisieren (nach Server-Start)
  try {
    await initWhatsApp();
    console.log('📱 WhatsApp initialisiert');
  } catch (e) {
    console.error('❌ WhatsApp-Init-Fehler:', e.message);
  }
});