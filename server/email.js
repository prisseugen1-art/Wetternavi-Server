// server/email.js

import Mailjet from 'node-mailjet';

const MJ_APIKEY_PUBLIC = process.env.MJ_APIKEY_PUBLIC;
const MJ_APIKEY_PRIVATE = process.env.MJ_APIKEY_PRIVATE;
const FROM_EMAIL = process.env.MJ_FROM_EMAIL || 'eugenp.wetternavi@yahoo.com';

let mailjet = null;

// ==================== INIT ====================

export function initEmail() {
  if (!MJ_APIKEY_PUBLIC || !MJ_APIKEY_PRIVATE) {
    console.log('⚠️  MJ_APIKEY fehlt – E-Mail wird übersprungen');
    return null;
  }
  console.log('📧 Initialisiere E-Mail-Service (Mailjet)...');
  try {
    mailjet = Mailjet.apiConnect(MJ_APIKEY_PUBLIC, MJ_APIKEY_PRIVATE);
    console.log(`✅ E-Mail-Service bereit (${FROM_EMAIL})`);
    return mailjet;
  } catch (e) {
    console.error('❌ Mailjet-Init-Fehler:', e.message);
    mailjet = null;
    return null;
  }
}

// ==================== SIMPLE EMAIL ====================

export async function sendEmail(to, subject, body) {
  if (!mailjet) throw new Error('E-Mail-Service nicht initialisiert');
  if (!to || !subject || !body) throw new Error('to, subject, body sind erforderlich');

  console.log(`📧 Sende E-Mail an ${to}: "${subject}"`);

  const request = mailjet.post('send', { version: 'v3.1' }).request({
    Messages: [{
      From: { Email: FROM_EMAIL, Name: 'Jony (WetterNavi)' },
      To: [{ Email: to }],
      Subject: subject,
      TextPart: body,
    }],
  });

  const result = await request;
  const msg = result.body?.Messages?.[0];

  if (msg?.Status === 'error') {
    const errText = (msg.Errors || []).map(e => e.ErrorMessage).join('; ');
    throw new Error(errText || 'Mailjet-Fehler');
  }

  console.log(`✅ E-Mail gesendet an ${to}`);
  return { success: true, to };
}

// ==================== CAROUSEL EMAIL ====================

export async function sendCarouselByEmail(to, carousel) {
  if (!mailjet) throw new Error('E-Mail-Service nicht initialisiert');
  if (!to) throw new Error('Empfänger-E-Mail erforderlich');
  if (!carousel) throw new Error('Kein Karussell gefunden');

  const { topic, slides = [], images = [] } = carousel;

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
      const kb = Math.round(img.data.length / 1024);
      lines.push(`slide_${img.n}.jpg (~${kb} KB)`);
    }
  }

  lines.push('');
  lines.push('=========================================');
  lines.push('WORKFLOW');
  lines.push('=========================================');
  lines.push('1. Anhänge herunterladen');
  lines.push('2. Am Laptop bearbeiten (Canva, Photoshop, etc.)');
  lines.push('3. Auf Handy synchronisieren');
  lines.push('4. In Instagram hochladen + Musik hinzufügen');
  lines.push('5. Posten');
  lines.push('');
  lines.push('Viel Erfolg! 🚀');
  lines.push('— Jony');

  const body = lines.join('\n');

  const attachments = images.map((img) => ({
    Filename: `slide_${img.n}.jpg`,
    ContentType: img.mime || 'image/jpeg',
    Base64Content: img.data,
  }));

  console.log(`📧 Sende Karussell "${topic}" an ${to}`);
  console.log(`   ${attachments.length} Bilder`);

  const request = mailjet.post('send', { version: 'v3.1' }).request({
    Messages: [{
      From: { Email: FROM_EMAIL, Name: 'Jony (WetterNavi)' },
      To: [{ Email: to }],
      Subject: `Karussell: ${topic}`,
      TextPart: body,
      Attachments: attachments,
    }],
  });

  const result = await request;
  const msg = result.body?.Messages?.[0];

  if (msg?.Status === 'error') {
    const errText = (msg.Errors || []).map(e => e.ErrorMessage).join('; ');
    throw new Error(errText || 'Mailjet-Fehler');
  }

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
    initialized: !!mailjet,
    provider: 'mailjet',
    from: FROM_EMAIL,
    hasApiKeys: !!(MJ_APIKEY_PUBLIC && MJ_APIKEY_PRIVATE),
  };
}
