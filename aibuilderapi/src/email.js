// Email delivery via EmailJS REST API (free tier: 200 emails/month).
// Sign up at https://www.emailjs.com — connect a Gmail sender, create a
// template with a {{code}} variable, then set these env vars:
//   EMAILJS_PUBLIC_KEY   — Account → API Keys → Public Key
//   EMAILJS_SERVICE_ID   — Email Services → your Gmail service ID
//   EMAILJS_TEMPLATE_ID  — Email Templates → template ID (must contain {{code}})

import { getVar } from './env.js';

const BASE = 'https://api.emailjs.com/api/v1.0/email/send';

export async function sendEmail({ to, subject, text, html }) {
  const publicKey = getVar('EMAILJS_PUBLIC_KEY');
  const serviceId = getVar('EMAILJS_SERVICE_ID');
  const templateId = getVar('EMAILJS_TEMPLATE_ID');

  if (!publicKey || !serviceId || !templateId) {
    console.error('[email] EmailJS not configured — skipping send');
    return false;
  }

  const body = {
    service_id: serviceId,
    template_id: templateId,
    template_params: {
      to_email: to,
      subject,
      message: text,
      code: text.replace(/[^0-9]/g, ''), // extract just the code
    },
    user_id: publicKey,
  };

  try {
    const r = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[email] EmailJS error', r.status, t);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[email] send failed:', e.message);
    return false;
  }
}
