// server/email.js

// ==================== KONFIGURATION ====================

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;

let initialized = false;

// ==================== INIT ====================

export function initEmail() {
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_SECRET) {
    console.log('⚠️  APPS_SCRIPT_URL/SECRET fehlt – E-Mail wird übersprungen');
    return null;
  }
  initialized = true;
  console.log('📧 E-Mail-Service bereit (Google Apps Script + GmailApp)');
  console.log(`   URL: ${APPS_SCRIPT_URL.substring(0, 60)}...`);
  return { initialized: true };
}

// ==================== HILFSFUNKTION ====================

async function callAppsScript(payload) {
  if (!initialized) throw new Error('E-Mail-Service nicht initialisiert');

  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: APPS_SCRIPT_SECRET,
      ...payload,
    }),
    redirect: 'follow',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Apps Script HTTP ${response.status}: ${text.substring(0, 200)}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data;
}

// ==================== SIMPLE EMAIL ====================

export async function sendEmail(to, subject, body) {
  console.log(`📧 Sende E-Mail an ${to}: "${subject}"`);
  const result = await callAppsScript({ to, subject, body });
  console.log(`✅ E-Mail gesendet an ${to}`);
  return { success: true, to, result };
}

// ==================== CAROUSEL EMAIL ====================

export async function sendCarouselByEmail(to, carousel) {
  if (!to) throw new Error('Empfänger-E-Mail erforderlich');
  if (!carousel) throw new Error('Kein Karussell gefunden');

  const { topic, slides = [], images = [] } = carousel;

  // ---- Text-Body bauen ----
  const lines = [];
  lines.push(`Karussell: ${topic}`);
  lines.push(`Erstellt am: ${new Date().toLocaleString('de-DE')}`);
  lines.push('');
  lines.push('=========================================');
  lines.push('SKRIPT');
  lines.push('=========================================');
  lines.push('');

  for (const s of slides) {
    lines.push(`SLIDE ${s.slide}`);
    lines.push(`Titel: ${s.title || ''}`);
    lines.push(`Text:  ${s.body || ''}`);
    lines.push(`Prompt: ${s.image_prompt || ''}`);
    lines.push('');
  }

  lines.push('=========================================');
  lines.push('BILDER');
  lines.push('=========================================');
  lines.push('');
  if (images.length === 0) {
    lines.push('(Keine Bilder generiert)');
  } else {
    for (const img of images) {
      lines.push(`slide_${img.n}.jpg (~${Math.round(img.data.length / 1024)} KB)`);
    }
  }
  lines.push('');
  lines.push('Viel Erfolg! 🚀');
  lines.push('— Jony');

  const body = lines.join('\n');

  // ---- Anhänge ----
  const attachments = images.map((img) => ({
    filename: `slide_${img.n}.jpg`,
    mimeType: img.mime || 'image/jpeg',
    content: img.data, // Base64
  }));

  console.log(`📧 Sende Karussell "${topic}" an ${to}`);
  console.log(`   ${attachments.length} Bilder`);

  const result = await callAppsScript({
    to,
    subject: `Karussell: ${topic}`,
    body,
    attachments,
  });

  console.log(`✅ Karussell-E-Mail gesendet an ${to} (${attachments.length} Bilder)`);

  return {
    success: true,
    to,
    topic,
    imageCount: attachments.length,
  };
}

// ==================== STATUS ====================

export function getEmailStatus() {
  return {
    initialized,
    provider: 'google-apps-script',
    hasUrl: !!APPS_SCRIPT_URL,
    hasSecret: !!APPS_SCRIPT_SECRET,
  };
}
