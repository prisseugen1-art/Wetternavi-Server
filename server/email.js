// server/email.js

import { Resend } from 'resend';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Jony <onboarding@resend.dev>';

let resend = null;

// ==================== INIT ====================

export function initEmail() {
  if (!RESEND_API_KEY) {
    console.log('⚠️  RESEND_API_KEY fehlt – E-Mail wird übersprungen');
    return null;
  }

  console.log(`📧 Initialisiere E-Mail-Service (Resend)...`);

  try {
    resend = new Resend(RESEND_API_KEY);
    console.log(`✅ E-Mail-Service bereit`);
    console.log(`   Absender: ${FROM_EMAIL}`);
    console.log(`   Provider: Resend (HTTPS API)`);
    return resend;
  } catch (e) {
    console.error('❌ Resend-Init-Fehler:', e.message);
    resend = null;
    return null;
  }
}

// ==================== SIMPLE EMAIL (freie Texte) ====================

export async function sendEmail(to, subject, body) {
  if (!resend) {
    throw new Error('E-Mail-Service nicht initialisiert (RESEND_API_KEY fehlt?)');
  }
  if (!to || !subject || !body) {
    throw new Error('to, subject, body sind erforderlich');
  }

  console.log(`📧 Sende E-Mail an ${to}: "${subject}"`);
  const startTime = Date.now();

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject,
    text: body,
  });

  if (error) {
    console.error(`❌ Resend-Fehler nach ${Date.now() - startTime}ms:`, error);
    throw new Error(error.message || 'Resend-Fehler');
  }

  console.log(`✅ E-Mail gesendet in ${Date.now() - startTime}ms (ID: ${data.id})`);
  return { success: true, messageId: data.id, to };
}

// ==================== CAROUSEL EMAIL ====================

export async function sendCarouselByEmail(to, carousel) {
  if (!resend) {
    throw new Error('E-Mail-Service nicht initialisiert (RESEND_API_KEY fehlt?)');
  }
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

  // ---- Anhänge vorbereiten ----
  // Resend erwartet content als Base64-String
  const attachments = images.map((img) => ({
    filename: `slide_${img.n}.jpg`,
    content: img.data,
  }));

  const totalKB = Math.round(
    attachments.reduce((s, a) => s + a.content.length, 0) / 1024
  );

  console.log(`📧 Sende Karussell "${topic}" an ${to}`);
  console.log(`   ${attachments.length} Bilder, ~${totalKB} KB Base64`);
  console.log(`   Über Resend HTTPS-API...`);

  const startTime = Date.now();

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `Karussell: ${topic}`,
    text: body,
    attachments,
  });

  if (error) {
    console.error(`❌ Resend-Fehler nach ${Date.now() - startTime}ms:`, error);
    throw new Error(error.message || 'Resend-Fehler');
  }

  console.log(`✅ Karussell-E-Mail gesendet in ${Date.now() - startTime}ms`);
  console.log(`   Message-ID: ${data.id}`);
  console.log(`   Anhänge: ${attachments.length}`);

  return {
    success: true,
    messageId: data.id,
    to,
    topic,
    imageCount: attachments.length,
  };
}

// ==================== STATUS ====================

export function getEmailStatus() {
  return {
    initialized: !!resend,
    provider: 'resend',
    from: FROM_EMAIL,
    hasApiKey: !!RESEND_API_KEY,
  };
}
