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

  // Legacy service_role keys are JWTs. New sb_secret_* keys are opaque and
  // must not be treated as JWT bearer tokens.
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function findSignup(email) {
  const response = await supabaseRequest(
    `waitlist?select=id,email,created_at,confirmation_sent,admin_notified&email=eq.${encodeURIComponent(email)}&limit=1`,
    { method: 'GET' }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    console.error('Supabase lookup failed', response.status, error);
    throw new Error('Could not read waitlist registration.');
  }

  const records = await response.json();
  return records[0] || null;
}

async function markDelivery(id, fields) {
  try {
    const response = await supabaseRequest(`waitlist?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(fields),
    });
    if (!response.ok) {
      console.error('Failed to update waitlist delivery state', response.status);
    }
  } catch (error) {
    console.error('Failed to update waitlist delivery state', error);
  }
}

async function deliverEmails(record, email) {
  const needsUserEmail = !record.confirmation_sent;
  const needsAdminEmail = !record.admin_notified;

  if (!needsUserEmail && !needsAdminEmail) {
    return { confirmationSent: true, adminNotified: true, attempted: false };
  }

  const transporter = smtpTransport();
  const from = process.env.SMTP_FROM || `MeshKor <${env('SMTP_USER')}>`;
  const adminEmail = process.env.WAITLIST_ADMIN_EMAIL || 'info@meshkor.com';
  const registeredAt = new Date(record.created_at || Date.now()).toISOString();
  const safeEmail = escapeHtml(email);

  let confirmationSent = Boolean(record.confirmation_sent);
  let adminNotified = Boolean(record.admin_notified);

  if (needsUserEmail) {
    try {
      await transporter.sendMail({
        from,
        to: email,
        subject: "You're on the MeshKor waitlist",
        text: `Hi,\n\nThanks for your interest in MeshKor.\n\nYou've successfully joined our early-access waitlist. We'll reach out when preview access becomes available.\n\nRegards,\nMeshKor Team`,
        html: `<p>Hi,</p><p>Thanks for your interest in <strong>MeshKor</strong>.</p><p>You've successfully joined our early-access waitlist. We'll reach out when preview access becomes available.</p><p>Regards,<br>MeshKor Team</p>`,
      });
      confirmationSent = true;
    } catch (error) {
      console.error('User confirmation email failed', error);
    }
  }

  if (needsAdminEmail) {
    try {
      await transporter.sendMail({
        from,
        to: adminEmail,
        replyTo: email,
        subject: 'New MeshKor waitlist registration',
        text: `A new user has shown interest in MeshKor.\n\nEmail: ${email}\nRegistered: ${registeredAt}\nSource: MeshKor Website`,
        html: `<p>A new user has shown interest in MeshKor.</p><p><strong>Email:</strong> ${safeEmail}<br><strong>Registered:</strong> ${registeredAt}<br><strong>Source:</strong> MeshKor Website</p>`,
      });
      adminNotified = true;
    } catch (error) {
      console.error('Admin notification email failed', error);
    }
  }

  await markDelivery(record.id, {
    confirmation_sent: confirmationSent,
    admin_notified: adminNotified,
    email_last_attempt_at: new Date().toISOString(),
  });

  return { confirmationSent, adminNotified, attempted: true };
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

    let duplicate = false;
    let record = null;

    const insertResponse = await supabaseRequest('waitlist', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ email, status: 'waiting', source: 'meshkor_website' }),
    });

    if (insertResponse.ok) {
      [record] = await insertResponse.json();
    } else {
      const error = await insertResponse.json().catch(() => ({}));
      if (insertResponse.status === 409 || error.code === '23505') {
        duplicate = true;
        record = await findSignup(email);
        if (!record) {
          return json(res, 500, { ok: false, message: 'Registration exists but could not be loaded. Please try again.' });
        }
      } else {
        console.error('Supabase insert failed', insertResponse.status, error);
        return json(res, 500, { ok: false, message: 'Could not save your registration. Please try again.' });
      }
    }

    const delivery = await deliverEmails(record, email);

    if (!delivery.confirmationSent || !delivery.adminNotified) {
      return json(res, 502, {
        ok: false,
        saved: true,
        duplicate,
        confirmationSent: delivery.confirmationSent,
        adminNotified: delivery.adminNotified,
        message: 'Your registration was saved, but one or more emails could not be sent. Please check the SMTP settings in Vercel.',
      });
    }

    return json(res, 200, {
      ok: true,
      duplicate,
      confirmationSent: true,
      adminNotified: true,
      message: duplicate
        ? "You're already on the MeshKor waitlist. Email delivery is confirmed."
        : "You're on the MeshKor waitlist — check your inbox for confirmation.",
    });
  } catch (error) {
    console.error('Waitlist API error', error);
    return json(res, 500, { ok: false, message: 'Something went wrong. Please check the Vercel function logs.' });
  }
};
