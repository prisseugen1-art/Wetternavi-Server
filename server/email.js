// server/email.js

import nodemailer from 'nodemailer';

const YAHOO_USER = process.env.YAHOO_EMAIL;
const YAHOO_APP_PASSWORD = process.env.YAHOO_APP_PASSWORD;

let transporter = null;

export function initEmail() {
  if (!YAHOO_USER || !YAHOO_APP_PASSWORD) {
    console.log('⚠️  YAHOO_EMAIL oder YAHOO_APP_PASSWORD fehlt – E-Mail wird übersprungen');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: 'smtp.mail.yahoo.com',
    port: 465,
    secure: true,
    auth: {
      user: YAHOO_USER,
      pass: YAHOO_APP_PASSWORD,
    },
  });

  console.log(`✅ E-Mail-Service bereit (${YAHOO_USER})`);
  return transporter;
}

/**
 * Sendet eine einfache Text-E-Mail.
 */
export async function sendEmail(to, subject, body) {
  if (!transporter) throw new Error('E-Mail-Service nicht initialisiert');
  if (!to || !subject || !body) throw new Error('to, subject, body sind erforderlich');

  console.log(`📧 Sende E-Mail an ${to}: "${subject}"`);

  const info = await transporter.sendMail({
    from: `"Jony (WetterNavi)" <${YAHOO_USER}>`,
    to,
    subject,
    text: body,
  });

  console.log(`✅ E-Mail gesendet: ${info.messageId}`);
  return { success: true, messageId: info.messageId, to };
}

/**
 * Sendet ein komplettes Karussell (Bilder + Skript) per E-Mail.
 *
 * @param {string} to - Empfänger-E-Mail
 * @param {Object} carousel - { topic, slides, images }
 */
export async function sendCarouselByEmail(to, carousel) {
  if (!transporter) throw new Error('E-Mail-Service nicht initialisiert');
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
      lines.push(`slide_${img.n}.jpg (${img.mime})`);
    }
  }

  const body = lines.join('\n');

  // ---- Anhänge bauen ----
  const attachments = images.map((img) => ({
    filename: `slide_${img.n}.jpg`,
    content: Buffer.from(img.data, 'base64'),
    contentType: img.mime,
  }));

  console.log(`📧 Sende Karussell "${topic}" an ${to} (${attachments.length} Bilder)`);

  const info = await transporter.sendMail({
    from: `"Jony (WetterNavi)" <${YAHOO_USER}>`,
    to,
    subject: `Karussell: ${topic}`,
    text: body,
    attachments,
  });

  console.log(`✅ Karussell-E-Mail gesendet: ${info.messageId}`);
  return {
    success: true,
    messageId: info.messageId,
    to,
    topic,
    imageCount: attachments.length,
  };
}

export function getEmailStatus() {
  return {
    initialized: !!transporter,
    user: YAHOO_USER || null,
  };
}
