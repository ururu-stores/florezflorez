const fs = require('fs');
const path = require('path');

function readStoreName() {
  try {
    const p = path.join(process.cwd(), 'content', 'settings.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data.site_title || '';
  } catch (e) {
    return '';
  }
}

module.exports = function handler(req, res) {
  const { GITHUB_REPO, SITE_URL } = process.env;
  if (!GITHUB_REPO || !SITE_URL) {
    return res.status(500).json({ error: 'Missing GITHUB_REPO or SITE_URL env var' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    repo: GITHUB_REPO,
    siteUrl: SITE_URL.replace(/\/$/, ''),
    storeName: readStoreName(),
  });
};
