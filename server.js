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

// ========== HELPER: Location aus Query/Body sauber auslesen ==========
function resolveLocation(req, bodyKey = 'location') {
  // Priorität: body.location (falls Agent explizit genannt) > query.location (App-Standort)
  const bodyLoc = req.body && req.body[bodyKey];
  const queryLoc = req.query.location;
  
  let raw;
  if (bodyLoc && typeof bodyLoc === 'string' && bodyLoc.trim() !== '') {
    raw = bodyLoc;
    console.log('📍 Location-Quelle: BODY (vom Agent)');
  } else {
    raw = queryLoc;
    console.log('📍 Location-Quelle: QUERY (App-Standort)');
  }
  
  // Array-Handling (falls Parameter doppelt ankommt)
  if (Array.isArray(raw)) raw = raw[0] || '';
  if (typeof raw !== 'string') raw = String(raw || '');
  return raw.trim();
}

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
    const cuisine = req.body.cuisine || 'Restaurant';
    const min_rating = req.body.min_rating;

    console.log('🔍 ===== RESTAURANT-SUCHE =====');
    console.log('🔍 cuisine (aus Body):', cuisine);
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
 * Endpunkt 3: Wetter für einen Ort abrufen
 * Location-Priorität: body.location (Nutzer nennt Stadt) > query.location (App-Standort)
 * Timeframe: 'aktuell' | 'heute' | 'morgen' | '3tage'
 */
app.post('/api/get-weather', async (req, res) => {
  try {
    const location = resolveLocation(req);
    const timeframe = req.body.timeframe || 'aktuell';

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

    // 2. Aktuelles Wetter
    const currentUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric&lang=de`;
    const currentRes = await fetch(currentUrl);
    const currentData = await currentRes.json();

    if (!currentData || !currentData.main) {
      console.error('❌ Aktuelles Wetter fehlgeschlagen:', currentData);
      return res.status(500).json({ error: 'Weather fetch failed' });
    }

    // 3. Forecast (5 Tage / 3 Stunden)
    const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric&lang=de`;
    const forecastRes = await fetch(forecastUrl);
    const forecastData = await forecastRes.json();

    // 4. Daten aggregieren
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

    const windDir = (deg) => {
      const dirs = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
      return dirs[Math.round(deg / 45) % 8];
    };

    const current = {
      temp: Math.round(currentData.main.temp),
      feels_like: Math.round(currentData.main.feels_like),
      description: currentData.weather[0].description,
      humidity: currentData.main.humidity,
      wind_speed: Math.round(currentData.wind.speed * 3.6),
      wind_dir: windDir(currentData.wind.deg || 0),
    };

    const byDay = {};
    if (forecastData && forecastData.list) {
      for (const entry of forecastData.list) {
        const dt = new Date(entry.dt * 1000);
        const dayKey = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        if (!byDay[dayKey]) byDay[dayKey] = [];
        byDay[dayKey].push(entry);
      }
    }

    const dayKeyToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const dayKeyTomorrow = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

    const aggregate = (entries) => {
      if (!entries || entries.length === 0) return null;
      const temps = entries.map((e) => e.main.temp);
      const min = Math.round(Math.min(...temps));
      const max = Math.round(Math.max(...temps));
      const descCount = {};
      let maxPop = 0;
      for (const e of entries) {
        const d = e.weather[0].description;
        descCount[d] = (descCount[d] || 0) + 1;
        if (e.pop > maxPop) maxPop = e.pop;
      }
      const description = Object.entries(descCount).sort((a, b) => b[1] - a[1])[0][0];
      return {
        min,
        max,
        description,
        rain_chance: Math.round(maxPop * 100),
      };
    };

    const todayData = aggregate(byDay[dayKeyToday]);
    const tomorrowData = aggregate(byDay[dayKeyTomorrow]);

    const nextDays = Object.keys(byDay)
      .filter((k) => k !== dayKeyToday && k !== dayKeyTomorrow)
      .sort()
      .slice(0, 3)
      .map((k) => {
        const agg = aggregate(byDay[k]);
        const dt = new Date(k);
        return {
          date: k,
          weekday: dt.toLocaleDateString('de-DE', { weekday: 'long' }),
          ...agg,
        };
      });

    const result = {
      location: name,
      country,
      timeframe,
      current,
      today: todayData,
      tomorrow: tomorrowData,
      next_days: nextDays,
    };

    console.log('✅ Wetter abgerufen für', name);
    res.json(result);

  } catch (error) {
    console.error('❌ Wetter-Fehler:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * Hilfsfunktion: Telefonnummer ins internationale Format bringen
 */
function normalizePhone(phone) {
  if (!phone) return '';
  const cleaned = phone.replace(/[\s\-\(\)\/]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  if (cleaned.startsWith('0')) return '+49' + cleaned.slice(1);
  return cleaned;
}

// Server starten
app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf http://0.0.0.0:${PORT}`);
});
