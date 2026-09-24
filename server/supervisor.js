// server/supervisor.js

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ==================== HOME-DETECTION ====================

export async function logPresence(userId, imuState, lat, lon) {
  if (!userId || !lat || !lon) return;

  try {
    await pool.query(`
      INSERT INTO user_presence (user_id, lat, lon, imu_state)
      VALUES ($1, $2, $3, $4)
    `, [userId, lat, lon, imuState]);

    const hour = new Date().getHours();
    const isNight = hour >= 22 || hour < 7;
    if (isNight && imuState === 'stationary') {
      await updateHomeIfNeeded(userId);
    }

    await pool.query(`
      DELETE FROM user_presence
      WHERE user_id = $1 AND timestamp < NOW() - INTERVAL '30 days'
    `, [userId]);
  } catch (e) {
    console.error('❌ Presence-Log Fehler:', e.message);
  }
}

async function updateHomeIfNeeded(userId) {
  try {
    const result = await pool.query(`
      SELECT
        ROUND(lat::numeric, 3) as rlat,
        ROUND(lon::numeric, 3) as rlon,
        COUNT(DISTINCT DATE(timestamp)) as nights
      FROM user_presence
      WHERE user_id = $1
        AND imu_state = 'stationary'
        AND (EXTRACT(HOUR FROM timestamp) >= 22 OR EXTRACT(HOUR FROM timestamp) < 7)
      GROUP BY rlat, rlon
      ORDER BY nights DESC
      LIMIT 1
    `, [userId]);

    if (result.rows.length === 0) return;

    const { rlat, rlon, nights } = result.rows[0];

    if (nights < 3) return;

    await pool.query(`
      INSERT INTO user_home (user_id, home_lat, home_lon, confidence)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id) DO UPDATE
      SET home_lat = $2, home_lon = $3, confidence = $4, updated_at = NOW()
    `, [userId, parseFloat(rlat), parseFloat(rlon), nights]);

    console.log(`🏠 Home erkannt für ${userId.substring(0, 8)}... : ${rlat}, ${rlon} (${nights} Nächte)`);
  } catch (e) {
    console.error('❌ Home-Update Fehler:', e.message);
  }
}

async function isAtHome(userId, lat, lon) {
  if (!lat || !lon) return false;

  try {
    const result = await pool.query(
      'SELECT home_lat, home_lon FROM user_home WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) return false;

    const { home_lat, home_lon } = result.rows[0];
    const distance = haversine(lat, lon, home_lat, home_lon);
    return distance < 200;
  } catch (e) {
    return false;
  }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) *
            Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ==================== MODUS-ENTSCHEIDUNG ====================

export async function detectMode(userId, imuState, lat, lon, lastUserText) {
  const hour = new Date().getHours();
  const isNight = hour >= 22 || hour < 7;

  // 1. Explizite Befehle
  if (lastUserText) {
    if (/moment|warte|sei still|rede gerade|ruhe/i.test(lastUserText)) {
      return 'silent';
    }
    if (/hey begleiter|hey gemini|begleiter\b/i.test(lastUserText)) {
      return 'normal';
    }
  }

  // 2. Nacht-Logik
  if (isNight) {
    if (imuState === 'walking' || imuState === 'running' || imuState === 'driving') {
      return 'normal';
    }

    if (imuState === 'stationary') {
      const atHome = await isAtHome(userId, lat, lon);
      if (atHome) return 'silent';
    }
  }

  // 3. Standard
  return 'normal';
}
