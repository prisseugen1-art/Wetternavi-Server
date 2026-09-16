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

/**
 * Endpunkt 1: Erstellt einen Web Call für den Voice Agenten
 */
app.post('/api/create-web-call', async (req, res) => {
  try {
    const agentId = 'agent_a057b329f51908e22b75bbf2e4';

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
          location: req.body.location || 'Berlin',
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(500).json({ error: 'Failed', details: errorText });
    }

    const call = await response.json();
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
    const { cuisine, location, min_rating } = req.body;

    // Suchbegriff bauen
    const query = `${cuisine || 'Restaurant'} in ${location || 'Berlin'}`;
    console.log('🔍 Suche Restaurants:', query);

    // Google Places API (NEW) aufrufen
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

    // Filtern und sortieren
    const minRating = parseFloat(min_rating) || 4.0;
    const filtered = places
      .filter((p) => (p.rating || 0) >= minRating)
      .sort((a, b) => (b.rating || 0) - (a.rating || 0))
      .slice(0, 3);

    // Formatieren für den Agenten
    const results = filtered.map((p) => ({
      name: p.displayName?.text || 'Unbekannt',
      address: p.formattedAddress || '',
      rating: p.rating || 0,
      reviews: p.userRatingCount || 0,
      phone: normalizePhone(p.nationalPhoneNumber || ''),
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
 * Hilfsfunktion: Telefonnummer ins internationale Format bringen
 * "030 32303532" → "+493032303532"
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