const nodemailer = require('nodemailer');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  return res.end(JSON.stringify(body));
}

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function supabaseServerKey() {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error('Missing required environment variable: SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY)');
  }
  return key;
}

async function supabaseRequest(path, options = {}) {
  const url = `${env('SUPABASE_URL').replace(/\/$/, '')}/rest/v1/${path}`;
  const key = supabaseServerKey();
  const authHeaders = { apikey: key };

  // Legacy service_role keys are JWTs and can be passed as Bearer tokens.
  // Current sb_secret_* keys are opaque server keys and should use apikey only.
  if (!key.startsWith('sb_secret_')) {
    authHeaders.Authorization = `Bearer ${key}`;
  }

  return fetch(url, {
    ...options,
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

function smtpTransport() {
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: env('SMTP_HOST'),
    port,
    secure: port === 465,
    auth: {
      user: env('SMTP_USER'),
      pass: env('SMTP_PASSWORD'),
    },
    requireTLS: port === 587,
  });
}

async function markDelivery(id, fields) {
  try {
    await supabaseRequest(`waitlist?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(fields),
    });
  } catch (error) {
    console.error('Failed to update waitlist delivery state', error);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { ok: false, message: 'Method not allowed.' });
  }

  try {
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email : '';
    const email = rawEmail.trim().toLowerCase();

    if (!EMAIL_RE.test(email) || email.length > 254) {
      return json(res, 400, { ok: false, message: 'Please enter a valid email address.' });
    }

    const insertResponse = await supabaseRequest('waitlist', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ email, status: 'waiting', source: 'meshkor_website' }),
    });

    if (!insertResponse.ok) {
      const error = await insertResponse.json().catch(() => ({}));
      if (insertResponse.status === 409 || error.code === '23505') {
        return json(res, 200, {
          ok: true,
          duplicate: true,
          message: "You're already on the MeshKor waitlist.",
        });
      }
      console.error('Supabase insert failed', insertResponse.status, error);
      return json(res, 500, { ok: false, message: 'Could not save your registration. Please try again.' });
    }

    const [record] = await insertResponse.json();
    const transporter = smtpTransport();
    const from = process.env.SMTP_FROM || `MeshKor <${env('SMTP_USER')}>`;
    const adminEmail = process.env.WAITLIST_ADMIN_EMAIL || 'info@meshkor.com';
    const registeredAt = new Date(record.created_at || Date.now()).toISOString();

    const userMail = transporter.sendMail({
      from,
      to: email,
      subject: "You're on the MeshKor waitlist",
      text: `Hi,\n\nThanks for your interest in MeshKor.\n\nYou've successfully joined our early-access waitlist. We'll reach out when preview access becomes available.\n\nRegards,\nMeshKor Team`,
      html: `<p>Hi,</p><p>Thanks for your interest in <strong>MeshKor</strong>.</p><p>You've successfully joined our early-access waitlist. We'll reach out when preview access becomes available.</p><p>Regards,<br>MeshKor Team</p>`,
    });

    const adminMail = transporter.sendMail({
      from,
      to: adminEmail,
      replyTo: email,
      subject: 'New MeshKor waitlist registration',
      text: `A new user has shown interest in MeshKor.\n\nEmail: ${email}\nRegistered: ${registeredAt}\nSource: MeshKor Website`,
      html: `<p>A new user has shown interest in MeshKor.</p><p><strong>Email:</strong> ${email}<br><strong>Registered:</strong> ${registeredAt}<br><strong>Source:</strong> MeshKor Website</p>`,
    });

    const [userResult, adminResult] = await Promise.allSettled([userMail, adminMail]);
    const confirmationSent = userResult.status === 'fulfilled';
    const adminNotified = adminResult.status === 'fulfilled';

    if (!confirmationSent) console.error('User confirmation email failed', userResult.reason);
    if (!adminNotified) console.error('Admin notification email failed', adminResult.reason);

    await markDelivery(record.id, {
      confirmation_sent: confirmationSent,
      admin_notified: adminNotified,
      email_last_attempt_at: new Date().toISOString(),
    });

    return json(res, 200, {
      ok: true,
      duplicate: false,
      message: "You're on the list — we'll be in touch.",
    });
  } catch (error) {
    console.error('Waitlist API error', error);
    return json(res, 500, { ok: false, message: 'Something went wrong. Please try again.' });
  }
};
