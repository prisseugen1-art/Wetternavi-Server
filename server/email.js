// server/email.js

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;

let initialized = false;

// ==================== SIGNATUR nach Ton ====================

function buildSignature(profile = {}, tone = 'persönlich') {
  const name = profile.user_name || 'Eugen';
  const address = profile.user_address || '';

  let greeting;
  if (tone === 'formell') {
    greeting = 'Mit freundlichen Grüßen\n' + name;
    if (address) greeting += '\n' + address;
  } else if (tone === 'persönlich') {
    greeting = 'Viele Grüße\n' + name;
  } else {
    greeting = 'LG ' + name;
  }

  const now = new Date();
  const fullTime = now.toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const requestId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);

  return greeting + '\n\n---\nGesendet: ' + fullTime + '\nAnfrage-ID: ' + requestId;
}

// ==================== BETREFF-VARIATION ====================

function buildVariedSubject(topic) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('de-DE', {
    day: '2-digit', month: '2-digit',
  });
  const hour = now.getHours();
  const suffix = hour < 12 ? 'Morgens' : hour < 18 ? 'Tagsüber' : 'Abends';
  return topic + ' (' + dateStr + ', ' + suffix + ')';
}

// ==================== INIT ====================

export function initEmail() {
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_SECRET) {
    console.log('⚠️  APPS_SCRIPT_URL/SECRET fehlt – E-Mail wird übersprungen');
    return null;
  }
  initialized = true;
  console.log('📧 E-Mail-Service bereit (Google Apps Script + GmailApp)');
  console.log('   URL: ' + APPS_SCRIPT_URL.substring(0, 60) + '...');
  return { initialized: true };
}

// ==================== APPS SCRIPT mit Retry ====================

async function callAppsScript(payload) {
  if (!initialized) throw new Error('E-Mail-Service nicht initialisiert');

  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: APPS_SCRIPT_SECRET,
          ...payload,
        }),
        redirect: 'follow',
      });

      // 404 / 5xx → Retry
      if (response.status === 404 || response.status >= 500) {
        const text = await response.text();
        lastError = new Error('Apps Script HTTP ' + response.status + ': ' + text.substring(0, 100));

        if (attempt < maxAttempts) {
          const wait = 1500 * attempt;
          console.log('   ⏳ Apps Script ' + response.status + ', Retry in ' + wait + 'ms...');
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error('Apps Script HTTP ' + response.status + ': ' + text.substring(0, 200));
      }

      const data = await response.json();
      if (data.error) throw new Error(data.error);
      return data;
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts && (e.message?.includes('fetch') || e.message?.includes('network'))) {
        const wait = 1500 * attempt;
        console.log('   ⏳ Netzwerkfehler, Retry in ' + wait + 'ms...');
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (attempt === maxAttempts) throw e;
    }
  }

  throw lastError || new Error('Apps Script Aufruf fehlgeschlagen');
}

// ==================== ANHÄNGE HELFER ====================

// Konvertiert Server-Anhang-Format → Apps-Script-Format
function prepareAttachmentsForAppsScript(attachments = []) {
  if (!Array.isArray(attachments)) return [];

  return attachments
    .filter(a => a && a.data)
    .map(a => ({
      filename: a.filename || 'anhang',
      mimeType: a.mimeType || 'application/octet-stream',
      content: a.data, // Base64
    }));
}

// ==================== SIMPLE EMAIL ====================

export async function sendEmail(to, subject, body, profile = {}, tone = 'persönlich', attachments = []) {
  if (!to) throw new Error('Empfänger erforderlich');
  if (!subject) throw new Error('Betreff erforderlich');
  if (!body) throw new Error('Text erforderlich');

  const attachmentCount = Array.isArray(attachments) ? attachments.length : 0;
  console.log('📧 Sende E-Mail an ' + to + ': "' + subject + '" (Ton: ' + tone + ', Anhänge: ' + attachmentCount + ')');

  const finalBody = body + '\n\n' + buildSignature(profile, tone);
  const attachmentPayload = prepareAttachmentsForAppsScript(attachments);

  const result = await callAppsScript({
    to,
    subject,
    body: finalBody,
    attachments: attachmentPayload,
  });

  console.log('✅ E-Mail gesendet an ' + to + (attachmentPayload.length > 0 ? ' (mit ' + attachmentPayload.length + ' Anhängen)' : ''));
  return { success: true, to, result };
}

// ==================== CAROUSEL EMAIL ====================

export async function sendCarouselByEmail(to, carousel, profile = {}) {
  if (!to) throw new Error('Empfänger-E-Mail erforderlich');
  if (!carousel) throw new Error('Kein Karussell gefunden');

  const topic = carousel.topic;
  const slides = carousel.slides || [];
  const images = carousel.images || [];

  const lines = [];
  lines.push('Karussell: ' + topic);
  lines.push('Erstellt am: ' + new Date().toLocaleString('de-DE'));
  lines.push('');
  lines.push('=========================================');
  lines.push('SKRIPT');
  lines.push('=========================================');
  lines.push('');

  for (const s of slides) {
    lines.push('SLIDE ' + s.slide);
    lines.push('Titel: ' + (s.title || ''));
    lines.push('Text:  ' + (s.body || ''));
    lines.push('Prompt: ' + (s.image_prompt || ''));
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
      lines.push('slide_' + img.n + '.jpg (~' + Math.round(img.data.length / 1024) + ' KB)');
    }
  }

  lines.push('');
  lines.push('Viel Erfolg! 🚀');

  const body = lines.join('\n') + '\n\n' + buildSignature(profile, 'persönlich');

  // Karussell-Bilder als Anhänge
  const attachments = images.map((img) => ({
    filename: 'slide_' + img.n + '.jpg',
    mimeType: img.mime || 'image/jpeg',
    content: img.data,
  }));

  const subject = buildVariedSubject('Karussell: ' + topic);

  console.log('📧 Sende Karussell "' + topic + '" an ' + to);
  console.log('   Betreff: ' + subject);
  console.log('   ' + attachments.length + ' Bilder');

  await callAppsScript({ to, subject, body, attachments });

  console.log('✅ Karussell-E-Mail gesendet an ' + to + ' (' + attachments.length + ' Bilder)');

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