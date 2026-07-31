const fs = require('fs');
const path = require('path');

module.exports = function handler(req, res) {
  const indexPath = path.resolve(__dirname, '..', 'index.html');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${protocol}://${host}`;

  let html = fs.readFileSync(indexPath, 'utf8');
  html = html.replace(
    'data-endpoint="PASTE_YOUR_FORM_ENDPOINT_HERE"',
    `data-endpoint="${origin}/api/waitlist"`
  );

  // Make the existing form surface the backend's real response instead of a
  // generic success/error message. This is injected at request time so the
  // static main-page source remains untouched on the feature branch.
  html = html.replace(
    ".then(function(r){ if(r.ok){ done(); } else { msg.className='wl-msg err'; msg.textContent='// something went wrong — try again'; } })",
    ".then(function(r){ return r.json().catch(function(){ return {}; }).then(function(data){ if(r.ok){ form.reset(); msg.className='wl-msg ok'; msg.textContent='// ' + (data.message || \"you're on the list — we'll be in touch.\"); } else { msg.className='wl-msg err'; msg.textContent='// ' + (data.message || 'something went wrong — try again'); } }); })"
  );

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  return res.status(200).send(html);
};
