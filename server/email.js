// server/email.js

import nodemailer from 'nodemailer';

const YAHOO_USER = process.env.YAHOO_EMAIL;
const YAHOO_APP_PASSWORD = process.env.YAHOO_APP_PASSWORD;

let transporter = null;
let lastVerifyError = null;

// ==================== INIT ====================

export function initEmail() {
  if (!YAHOO_USER || !YAHOO_APP_PASSWORD) {
    console.log('⚠️  YAHOO_EMAIL oder YAHOO_APP_PASSWORD fehlt – E-Mail wird übersprungen');
    return null;
  }

  console.log(`📧 Initialisiere E-Mail-Service (${YAHOO_USER})...`);

  // Port 587 mit STARTTLS – funktioniert zuverlässiger von Cloud-Servern (Railway/AWS)
  transporter = nodemailer.createTransport({
    host: 'smtp.mail.yahoo.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
      user: YAHOO_USER,
      pass: YAHOO_APP_PASSWORD,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    tls: {
      rejectUnauthorized: false,
    },
  });

  // Verbindung testen (asynchron, damit Server-Start nicht blockiert)
  transporter.verify((error, success) => {
    if (error) {
      lastVerifyError = error.message;
      console.error('❌ E-Mail-Verbindung fehlgeschlagen:', error.message);
      console.error('   Code:', error.code);
      console.error('   → Prüfe: App-Passwort korrekt? Port 587 blockiert?');
      transporter = null;
    } else {
      lastVerifyError = null;
      console.log(`✅ E-Mail-Service bereit (${YAHOO_USER})`);
    }
  });

  return transporter;
}

// ==================== SIMPLE EMAIL ====================

export async function sendEmail(to, subject, body) {
  if (!transporter) {
    throw new Error('E-Mail-Service nicht initialisiert' + (lastVerifyError ? ': ' + lastVerifyError : ''));
  }
  if (!to || !subject || !body) throw new Error('to, subject, body sind erforderlich');

  console.log(`📧 Sende E-Mail an ${to}: "${subject}"`);
  const startTime = Date.now();

  let info;
  try {
    info = await transporter.sendMail({
      from: `"Jony (WetterNavi)" <${YAHOO_USER}>`,
      to,
      subject,
      text: body,
    });
  } catch (err) {
    console.error(`❌ E-Mail-Fehler nach ${Date.now() - startTime}ms:`, err.message);
    console.error(`   Code:`, err.code);
    console.error(`   Response:`, err.response);
    throw err;
  }

  console.log(`✅ E-Mail gesendet in ${Date.now() - startTime}ms: ${info.messageId}`);
  return { success: true, messageId: info.messageId, to };
}

// ==================== CAROUSEL EMAIL ====================

export async function sendCarouselByEmail(to, carousel) {
  if (!transporter) {
    throw new Error('E-Mail-Service nicht initialisiert' + (lastVerifyError ? ': ' + lastVerifyError : ''));
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
      lines.push(`slide_${img.n}.jpg (${img.mime}, ~${kb} KB)`);
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

  // ---- Anhänge bauen ----
  const attachments = images.map((img) => ({
    filename: `slide_${img.n}.jpg`,
    content: Buffer.from(img.data, 'base64'),
    contentType: img.mime || 'image/jpeg',
  }));

  const totalKB = Math.round(attachments.reduce((s, a) => s + a.content.length, 0) / 1024);

  console.log(`📧 Sende Karussell "${topic}" an ${to}`);
  console.log(`   ${attachments.length} Bilder, ~${totalKB} KB Gesamtgröße`);
  console.log(`   Verbinde mit SMTP (Port 587, STARTTLS)...`);

  const startTime = Date.now();

  let info;
  try {
    info = await transporter.sendMail({
      from: `"Jony (WetterNavi)" <${YAHOO_USER}>`,
      to,
      subject: `Karussell: ${topic}`,
      text: body,
      attachments,
    });
  } catch (err) {
    console.error(`❌ SMTP-Fehler nach ${Date.now() - startTime}ms:`, err.message);
    console.error(`   Code:`, err.code);
    console.error(`   Command:`, err.command);
    console.error(`   Response:`, err.response);
    throw err;
  }

  console.log(`✅ Karussell-E-Mail gesendet in ${Date.now() - startTime}ms`);
  console.log(`   Message-ID: ${info.messageId}`);
  console.log(`   Anhänge: ${attachments.length}`);

  return {
    success: true,
    messageId: info.messageId,
    to,
    topic,
    imageCount: attachments.length,
  };
}

// ==================== STATUS ====================

export function getEmailStatus() {
  return {
    initialized: !!transporter,
    user: YAHOO_USER || null,
    lastVerifyError: lastVerifyError || null,
    smtp: {
      host: 'smtp.mail.yahoo.com',
      port: 587,
      secure: false,
      requireTLS: true,
    },
  };
}
