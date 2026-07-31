function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  return res.end(JSON.stringify(body));
}

function supabaseServerKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { ok: false, message: 'Method not allowed.' });
  }

  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = supabaseServerKey();

  const environment = {
    supabaseUrlConfigured: Boolean(url),
    supabaseServerKeyConfigured: Boolean(key),
    smtpHostConfigured: Boolean(process.env.SMTP_HOST),
    smtpPortConfigured: Boolean(process.env.SMTP_PORT),
    smtpUserConfigured: Boolean(process.env.SMTP_USER),
    smtpPasswordConfigured: Boolean(process.env.SMTP_PASSWORD),
  };

  if (!url || !key) {
    return json(res, 500, {
      ok: false,
      environment,
      supabase: { reachable: false, reason: 'Missing Supabase environment variable(s).' },
    });
  }

  try {
    const headers = { apikey: key };
    if (!key.startsWith('sb_secret_')) {
      headers.Authorization = `Bearer ${key}`;
    }

    const response = await fetch(`${url}/rest/v1/waitlist?select=id&limit=1`, {
      method: 'GET',
      headers,
    });

    const body = await response.text();
    let parsed = null;
    try { parsed = body ? JSON.parse(body) : null; } catch (_) { parsed = body; }

    if (!response.ok) {
      return json(res, 502, {
        ok: false,
        environment,
        supabase: {
          reachable: true,
          authorized: false,
          status: response.status,
          error: parsed,
        },
      });
    }

    return json(res, 200, {
      ok: true,
      environment,
      supabase: {
        reachable: true,
        authorized: true,
        status: response.status,
        tableAccessible: true,
      },
    });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      environment,
      supabase: {
        reachable: false,
        error: error.message,
      },
    });
  }
};
