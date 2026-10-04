// server/carousel_store.js

// Pro User wird das letzte Karussell gespeichert:
// { userId: { topic, slides, images: [{n, data, mime}], createdAt } }

const stores = new Map();

const MAX_AGE_MS = 60 * 60 * 1000; // 1 Stunde

export function setScript(userId, topic, slides) {
  if (!userId) return;
  stores.set(userId, {
    topic,
    slides,
    images: [],
    createdAt: Date.now(),
  });
  console.log(`📦 Karussell im Speicher: ${userId.substring(0, 8)}... (${topic})`);
}

export function addImage(userId, slideNumber, base64Data, mimeType) {
  if (!userId) return;
  const s = stores.get(userId);
  if (!s) return;
  s.images.push({ n: slideNumber, data: base64Data, mime: mimeType || 'image/jpeg' });
  console.log(`🖼️ Bild Slide ${slideNumber} im Speicher (${base64Data.length} Zeichen)`);
}

export function getCarousel(userId) {
  if (!userId) return null;
  const s = stores.get(userId);
  if (!s) return null;
  if (Date.now() - s.createdAt > MAX_AGE_MS) {
    stores.delete(userId);
    return null;
  }
  return s;
}

export function clearCarousel(userId) {
  if (!userId) return;
  stores.delete(userId);
}

// Cleanup-Timer: alle 15 Min abgelaufene Einträge löschen
setInterval(() => {
  const now = Date.now();
  for (const [userId, s] of stores.entries()) {
    if (now - s.createdAt > MAX_AGE_MS) {
      stores.delete(userId);
    }
  }
}, 15 * 60 * 1000);