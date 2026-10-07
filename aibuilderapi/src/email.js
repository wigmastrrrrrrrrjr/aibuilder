// Email delivery.
// Try Resend first (fast, generous), fall back to EmailJS.
import { getVar } from './env.js';

const RESEND_BASE = 'https://api.resend.com/emails';

export async function sendEmail({ to, subject, text, html }) {
  const resendKey = getVar('RESEND_API_KEY');
  const from = getVar('RESEND_FROM') || 'aibuilder <noreply@aibuilder.dev>';

  if (resendKey) {
    try {
      const r = await fetch(RESEND_BASE, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to,
          subject: subject || 'Your aibuilder verification code',
          text: text || html?.replace(/<[^>]+>/g, '') || '',
          html,
        }),
      });
      if (r.ok) return true;
      const err = await r.text().catch(() => '');
      console.error('[email] Resend error', r.status, err);
    } catch (e) {
      console.error('[email] Resend send failed:', e.message);
    }
  }

  // Fallback to EmailJS
  const publicKey = getVar('EMAILJS_PUBLIC_KEY');
  const privateKey = getVar('EMAILJS_PRIVATE_KEY');
  const serviceId = getVar('EMAILJS_SERVICE_ID');
  const templateId = getVar('EMAILJS_TEMPLATE_ID');
  if (!publicKey || !serviceId || !templateId) {
    console.error('[email] No email provider configured (Resend + EmailJS) — skipping send');
    return false;
  }
  const body = {
    service_id: serviceId,
    template_id: templateId,
    template_params: {
      to_email: to,
      name: 'aibuilder',
      time: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
      message: text,
      code: (text || '').replace(/[^0-9]/g, ''),
    },
    user_id: publicKey,
  };
  if (privateKey) body.accessToken = privateKey;
  try {
    const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
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