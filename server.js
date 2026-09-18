import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Startseite / Health Check
app.get('/', (req, res) => {
  res.send('Server läuft erfolgreich!');
});

// ========== HELPER ==========

/**
 * Liest die Location aus dem Request.
 * Retell sendet die Function-Argumente in req.body.args.location
 * Fallback: req.body.location (falls mal direkt gesendet)
 * Fallback: req.query.location (App-Standort)
 */
function resolveLocation(req, bodyKey = 'location') {
  let raw;
  let quelle;

  // 1. Retell-Format: req.body.args.location
  const args = req.body?.args;
  if (args && args[bodyKey]) {
    raw = args[bodyKey];
    quelle = 'ARGS (vom Agent)';
  }
  // 2. Direkt im Body
  else if (req.body?.[bodyKey]) {
    raw = req.body[bodyKey];
    quelle = 'BODY (direkt)';
  }
  // 3. Query-Parameter (App-Standort) – ignorieren wenn literal "{{location}}"
  else {
    const queryLoc = req.query.location;
    if (queryLoc && queryLoc !== '{{location}}') {
      raw = queryLoc;
      quelle = 'QUERY (App-Standort)';
    } else {
      raw = '';
      quelle = 'LEER';
    }
  }

  // Array-Handling
  if (Array.isArray(raw)) raw = raw[0] || '';
  if (typeof raw !== 'string') raw = String(raw || '');
  const result = raw.trim();

  console.log(`📍 Location-Quelle: ${quelle} → "${result}"`);
  return result;
}

/**
 * Liest das Timeframe aus dem Request.
 */
function resolveTimeframe(req, defaultVal = 'aktuell') {
  const args = req.body?.args;
  let raw = args?.timeframe || req.body?.timeframe || defaultVal;
  if (typeof raw !== 'string') raw = String(raw || defaultVal);
  return raw.trim();
}

/**
 * Liest die Cuisine aus dem Request.
 */
function resolveCuisine(req, defaultVal = 'Restaurant') {
  const args = req.body?.args;
  let raw = args?.cuisine || req.body?.cuisine || defaultVal;
  if (typeof raw !== 'string') raw = String(raw || defaultVal);
  return raw.trim();
}

/**
 * Telefonnummer ins internationale Format bringen
 */
function normalizePhone(phone) {
  if (!phone) return '';
  const cleaned = phone.replace(/[\s\-\(\)\/]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  if (cleaned.startsWith('0')) return '+49' + cleaned.slice(1);
  return cleaned;
}

// ========== ENDPUNKTE ==========

/**
 * Endpunkt 1: Erstellt einen Web Call für den Voice Agenten
 */
app.post('/api/create-web-call', async (req, res) => {
  console.log('📥 ===== NEUE ANFRAGE =====');
  console.log('📥 customerName:', req.body.customerName);
  console.log('📥 location:', req.body.location);
  console.log('📥 ========================');

  try {
    const agentId = 'agent_74a4972eb9f76b3e76c9291302';

    const response = await fetch('https://api.retellai.com/v2/create-web-call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RETELL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: agentId,
        retell_llm_dynamic_variables: {
          customer_name: req.body.customerName || 'Gast',
          location: req.body.location || '',
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Retell API Fehler:', response.status, errorText);
      return res.status(500).json({ error: 'Failed', details: errorText });
    }

    const call = await response.json();
    console.log('✅ Web Call erstellt:', call.call_id);
    res.json({
      accessToken: call.access_token,
      callId: call.call_id,
    });
  } catch (error) {
    console.error('❌ Fehler:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Endpunkt 2: Sucht Restaurants über Google Places API (NEW)
 */
app.post('/api/search-restaurant', async (req, res) => {
  try {
    const location = resolveLocation(req);
    const cuisine = resolveCuisine(req);
    const min_rating = req.body?.args?.min_rating || req.body?.min_rating;

    console.log('🔍 ===== RESTAURANT-SUCHE =====');
    console.log('🔍 cuisine:', cuisine);
    console.log('🔍 location:', location);
    console.log('🔍 =============================');

    if (!location) {
      console.log('⚠️ Kein Ort angegeben – Suche abgebrochen');
      return res.status(400).json({
        error: 'Location required',
        message: 'Bitte gib einen Ort an, damit ich Restaurants finden kann.',
      });
    }

    const query = `${cuisine} in ${location}`;
    console.log('🔍 Suche Restaurants:', query);

    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': [
          'places.displayName',
          'places.formattedAddress',
          'places.rating',
          'places.userRatingCount',
          'places.nationalPhoneNumber',
          'places.internationalPhoneNumber',
          'places.regularOpeningHours',
          'places.priceLevel',
        ].join(','),
      },
      body: JSON.stringify({
        textQuery: query,
        languageCode: 'de',
        maxResultCount: 10,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Google Places Fehler:', response.status, errorText);
      return res.status(500).json({ error: 'Google Places API error', details: errorText });
    }

    const data = await response.json();
    const places = data.places || [];

    const minRating = parseFloat(min_rating) || 4.0;
    const filtered = places
      .filter((p) => (p.rating || 0) >= minRating)
      .sort((a, b) => (b.rating || 0) - (a.rating || 0))
      .slice(0, 3);

    const results = filtered.map((p) => ({
      name: p.displayName?.text || 'Unbekannt',
      address: p.formattedAddress || '',
      rating: p.rating || 0,
      reviews: p.userRatingCount || 0,
      phone: p.internationalPhoneNumber || normalizePhone(p.nationalPhoneNumber || ''),
      openNow: p.regularOpeningHours?.openNow ?? null,
      openingHours: p.regularOpeningHours?.weekdayDescriptions || [],
      priceLevel: p.priceLevel || null,
    }));

    console.log(`✅ ${results.length} Restaurants gefunden`);
    results.forEach((r, i) => console.log(`   ${i + 1}. ${r.name} - ${r.rating}⭐`));

    res.json({
      count: results.length,
      restaurants: results,
    });
  } catch (error) {
    console.error('❌ Server-Fehler:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Endpunkt 3: Wetter für einen Ort abrufen (OneCall 3.0, bis zu 8 Tage)
 * Location-Priorität: args.location (Agent) > body.location > query.location (App-Standort)
 * Timeframe: 'aktuell' | 'heute' | 'morgen' | '8tage'
 */
app.post('/api/get-weather', async (req, res) => {
  try {
    const location = resolveLocation(req);
    const timeframe = resolveTimeframe(req);

    console.log('🌤️ ===== WETTER-ABFRAGE =====');
    console.log('🌤️ location:', location);
    console.log('🌤️ timeframe:', timeframe);
    console.log('🌤️ =============================');

    if (!location) {
      console.log('⚠️ Kein Ort angegeben – Wetter-Abfrage abgebrochen');
      return res.status(400).json({
        error: 'Location required',
        message: 'Bitte gib einen Ort an, damit ich das Wetter abrufen kann.',
      });
    }

    const apiKey = process.env.OPENWEATHER_API_KEY;
    if (!apiKey) {
      console.error('❌ OPENWEATHER_API_KEY nicht gesetzt!');
      return res.status(500).json({ error: 'OpenWeatherMap API key missing' });
    }

    // 1. Geocoding: Ort → lat/lon
    const geoUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(location)}&limit=1&appid=${apiKey}`;
    const geoRes = await fetch(geoUrl);
    const geoData = await geoRes.json();

    if (!geoData || geoData.length === 0) {
      console.log('⚠️ Ort nicht gefunden:', location);
      return res.status(404).json({
        error: 'Location not found',
        message: `Ort "${location}" nicht gefunden.`,
      });
    }

    const { lat, lon, name, country } = geoData[0];
    console.log(`🌤️ Ort: ${name}, ${country} → ${lat}, ${lon}`);

    // 2. OneCall 3.0
    const oneCallUrl = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric&lang=de&exclude=minutely,hourly`;
    const oneCallRes = await fetch(oneCallUrl);
    const oneCallData = await oneCallRes.json();

    if (!oneCallData || !oneCallData.current) {
      console.error('❌ OneCall fehlgeschlagen:', oneCallData);
      return res.status(500).json({ error: 'Weather fetch failed', details: oneCallData });
    }

    const windDir = (deg) => {
      const dirs = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
      return dirs[Math.round((deg || 0) / 45) % 8];
    };

    // 3. Aktuelles Wetter
    const current = {
      temp: Math.round(oneCallData.current.temp),
      feels_like: Math.round(oneCallData.current.feels_like),
      description: oneCallData.current.weather[0].description,
      humidity: oneCallData.current.humidity,
      wind_speed: Math.round(oneCallData.current.wind_speed * 3.6),
      wind_dir: windDir(oneCallData.current.wind_deg),
      rain_1h: oneCallData.current.rain ? oneCallData.current.rain['1h'] : 0,
    };

    // 4. Tagesdaten aus daily[] (bis zu 8 Tage)
    const daily = oneCallData.daily || [];
    const days = daily.slice(0, 8).map((day) => {
      const dt = new Date(day.dt * 1000);
      return {
        date: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`,
        weekday: dt.toLocaleDateString('de-DE', { weekday: 'long' }),
        min: Math.round(day.temp.min),
        max: Math.round(day.temp.max),
        description: day.weather[0].description,
        rain_chance: Math.round((day.pop || 0) * 100),
        wind_speed: Math.round(day.wind_speed * 3.6),
      };
    });

    const today = days[0] || null;
    const tomorrow = days[1] || null;
    const next_days = days.slice(2);
    const all_days = days;

    const result = {
      location: name,
      country,
      timeframe,
      current,
      today,
      tomorrow,
      next_days,
      all_days,
    };

    console.log(`✅ Wetter abgerufen für ${name} (${days.length} Tage)`);
    res.json(result);

  } catch (error) {
    console.error('❌ Wetter-Fehler:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Server starten
app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf http://0.0.0.0:${PORT}`);
});
