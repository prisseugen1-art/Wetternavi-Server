// server/route_store.js

const store = new Map();
const TTL_MS = 10 * 60 * 1000; // 10 Minuten

function cleanOld() {
  const now = Date.now();
  for (const [userId, data] of store.entries()) {
    if ((now - data.createdAt) > TTL_MS) store.delete(userId);
  }
}
setInterval(cleanOld, 60 * 1000);

export function setRoute(userId, route) {
  if (!userId) return null;
  const item = {
    ...route,
    createdAt: Date.now(),
  };
  store.set(userId, item);
  return item;
}

export function getRoute(userId) {
  if (!userId) return null;
  const item = store.get(userId);
  if (!item) return null;
  if ((Date.now() - item.createdAt) > TTL_MS) {
    store.delete(userId);
    return null;
  }
  return item;
}

export function clearRoute(userId) {
  if (!userId) return false;
  return store.delete(userId);
}
