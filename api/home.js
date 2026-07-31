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

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  return res.status(200).send(html);
};
