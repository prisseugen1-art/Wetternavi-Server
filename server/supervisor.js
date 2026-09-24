// server/supervisor.js

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ==================== TRIGGER-ERKENNUNG ====================

function normalize(text) {
  return text
    .toLowerCase()
    // Satzzeichen zu Leerzeichen
    .replace(/[.,!?;:()"']/g, ' ')
    // Kyrillisch: Kommas etc. auch
    .replace(/[,.!?;:()"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesSilentTrigger(text) {
  const t = normalize(text);

  const patterns = [
    // ---- Deutsch: "sei (mal) still/ruhig/leise" ----
    /\bsei\s+(mal\s+|doch\s+|bitte\s+|kurz\s+)?(still|ruhig|leise|jetzt\s+still)\b/,
    /\bsei\s+(mal\s+)?jetzt\s+(still|ruhig|leise)\b/,

    // ---- Deutsch: Ruhe ----
    /\bruhe\s*(jetzt|bitte|mal)?\b/,
    /\bjetzt\s+ist\s+ruhe\b/,
    /\bsch\s*ruhe\b/,

    // ---- Deutsch: Klappe / Mund halten ----
    /\bhalt\s+(mal\s+)?(die\s+klappe|die\s+klappe\s+halten|den\s+mund|den\s+rand|still|ruhe|jetzt\s+ruhe)\b/,
    /\bklappe\s+(zu|halten?)\b/,
    /\bmund\s+halten?\b/,
    /\bschnauze\b/,
    /\bschnauze\s+halten?\b/,

    // ---- Deutsch: psst / psssst ----
    /\bps{2,}t\b/,   // passt zu psst, pssst, psssst
    /\bshh+\b/,      // shh, shhh
    /\bsch+\b/,      // sch

    // ---- Deutsch: warten / moment ----
    /\bmoment\s+(mal|bitte)?\b/,
    /\bwarte\s+(mal|kurz|bitte)?\b/,
    /\bhalt\s+(mal\s+)?(kurz\s+)?an\b/,

    // ---- Deutsch: "ich rede gerade" ----
    /\bich\s+rede\s+(gerade|jetzt)\b/,
    /\bich\s+spreche\s+(gerade|jetzt)\b/,
    /\bh[oö]r\s+auf\s+zu\s+(reden|sprechen)\b/,
    /\bsag\s+nichts\b/,
    /\bkein\s+wort\b/,
    /\bsag\s+(jetzt\s+)?(mal\s+)?(nichts|kein\s+wort)\b/,

    // ---- Deutsch: leise sein ----
    /\bleise\s+(bitte|jetzt|mal)\b/,
    /\bsei\s+bitte\s+leise\b/,
    /\bnicht\s+so\s+laut\b/,

    // ---- Deutsch: Stop / Hör auf ----
    /\bstop\s+(mal\s+)?(jetzt)?\b/,
    /\bh[oö]r\s+(jetzt\s+)?auf\b/,

    // ---- Russisch: тише, замолчи, помолчи, молчи ----
    /тише/,                // tische = leiser
    /замолчи/,             // samoltschi = sei still
    /помолчи/,             // pomoltschi = schweig
    /молчи/,               // moltschi = schweig
    /хватит/,              // chwatit = genug
    /заткнись/,            // satknis' = halt die Klappe
    /заткни/,              // satkni
    /замри/,               // samri = frier ein / halt still
    /тихо/,                // ticho = leise
    /постой/,              // postoj = warte
    /подожди/,             // podoschdi = warte
    /остановись/,          // ostanowis' = halt an
  ];

  return patterns.some(p => p.test(t));
}

function matchesWakeWord(text) {
  const t = normalize(text);

  const patterns = [
    // ---- Deutsch: "Hey Begleiter" ----
    /\bhey\s+begleiter\b/,
    /\bhey\s+gemini\b/,
    /\bhey\s+jackson\b/,
    /\bhey\s+buddy\b/,
    /\bhey\s+du\b/,

    // ---- Deutsch: "Hallo Begleiter" ----
    /\bhall?o\s+begleiter\b/,
    /\bhall?o\s+gemini\b/,
    /\bhall?o\s+jackson\b/,

    // ---- Deutsch: "Begleiter (bist du da / wach auf / hörst du)" ----
    /\bbegleiter\s+(bist\s+du\s+da|aufwachen|wach\s+auf|h[oö]rst\s+du|h[oö]r\s+zu|melde\s+dich)\b/,
    /\bgemini\s+(bist\s+du\s+da|aufwachen|h[oö]rst\s+du|melde\s+dich)\b/,
    /\bjackson\s+(bist\s+du\s+da|aufwachen|h[oö]rst\s+du|melde\s+dich)\b/,

    // ---- Deutsch: Aufwachen / Wach auf ----
    /\bwach\s+(bitte\s+)?auf\b/,
    /\baufwachen\b/,
    /\bbist\s+du\s+(noch\s+)?da\b/,
    /\bmelde\s+dich\b/,

    // ---- Deutsch: "Begleiter" alleine (Fallback, zuletzt) ----
    /\bbegleiter\b/,
    /\bjackson\b/,

    // ---- Russisch: Эй, спутник / Эй, друг ----
    /эй\s+спутник/,        // ej sputnik
    /привет\s+спутник/,    // priwet sputnik
    /эй\s+друг/,           // ej drug
    /эй\s+помощник/,       // ej pomoschtschnik
    /спутник/,             // sputnik (alleine)
    /проснись/,            // prosnis' = wach auf
    /ты\s+здесь/,          // ty sdes' = bist du da
  ];

  return patterns.some(p => p.test(t));
}

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

export async function detectMode(userId, imuState, lat, lon, lastUserText, currentMode = 'normal') {
  const hour = new Date().getHours();
  const isNight = hour >= 22 || hour < 7;

  // 1. Explizite Befehle (HÖCHSTE Priorität – auch im Silent)
  if (lastUserText) {
    // Wake-Word hat Vorrang (aus Silent raus)
    if (matchesWakeWord(lastUserText)) {
      console.log(`👂 Wake-Word erkannt in: "${lastUserText}"`);
      return 'normal';
    }
    // Silent-Trigger
    if (matchesSilentTrigger(lastUserText)) {
      console.log(`🤫 Silent-Trigger erkannt in: "${lastUserText}"`);
      return 'silent';
    }
  }

  // 2. Wenn bereits SILENT → bleib silent (bis Wake-Word)
  if (currentMode === 'silent') {
    return 'silent';
  }

  // 3. Nacht-Logik (Zeit + Bewegung + Ort)
  if (isNight) {
    if (imuState === 'walking' || imuState === 'running' || imuState === 'driving') {
      return 'normal';
    }
    if (imuState === 'stationary') {
      const atHome = await isAtHome(userId, lat, lon);
      if (atHome) return 'silent';
    }
  }

  // 4. Standard
  return 'normal';
}
