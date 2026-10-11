// server/location_service.js

const OWM_KEY = process.env.OPENWEATHER_API_KEY;
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;

// ==================== STUFE 1: STADT (OpenWeatherMap) ====================

export async function reverseGeocodeCity(lat, lon) {
  if (!OWM_KEY) {
    console.error('⚠️ OPENWEATHER_API_KEY fehlt');
    return null;
  }
  try {
    const url = `https://api.openweathermap.org/geo/1.0/reverse?lat=${lat}&lon=${lon}&limit=1&appid=${OWM_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`❌ OWM Reverse HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      const entry = data[0];
      return {
        city: entry.name || null,
        state: entry.state || null,
        country: entry.country || null,
        lat: entry.lat,
        lon: entry.lon,
      };
    }
    return null;
  } catch (e) {
    console.error('❌ reverseGeocodeCity:', e.message);
    return null;
  }
}

// ==================== STUFE 2: STRASSE + HAUSNUMMER (Google Geocoding) ====================

export async function reverseGeocodeFull(lat, lon) {
  if (!GOOGLE_KEY) {
    console.error('⚠️ GOOGLE_PLACES_API_KEY fehlt');
    return null;
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&language=de&key=${GOOGLE_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`❌ Google Geocoding HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();

    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      console.error(`❌ Google Geocoding status: ${data.status} ${data.error_message || ''}`);
      return null;
    }

    // Das erste Ergebnis ist die genaueste Adresse
    const result = data.results[0];
    const components = result.address_components || [];

    let streetNumber = '';
    let route = '';
    let postalCode = '';
    let locality = '';
    let country = '';

    for (const c of components) {
      if (c.types.includes('street_number')) streetNumber = c.long_name;
      if (c.types.includes('route')) route = c.long_name;
      if (c.types.includes('postal_code')) postalCode = c.long_name;
      if (c.types.includes('locality')) locality = c.long_name;
      if (c.types.includes('country')) country = c.short_name;
    }

    const streetAddress = [route, streetNumber].filter(Boolean).join(' ');
    const fullAddress = result.formatted_address || '';

    return {
      street: streetAddress || null,
      city: locality || null,
      postal_code: postalCode || null,
      country: country || null,
      formatted: fullAddress || null,
      lat, lon,
    };
  } catch (e) {
    console.error('❌ reverseGeocodeFull:', e.message);
    return null;
  }
}

// ==================== HAVERSINE (Entfernung zwischen zwei Punkten) ====================

export function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Erdradius in Metern
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

export function formatDistance(meters) {
  if (meters < 1000) return `${meters} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}