// USPS OAuth client_credentials helper.
//
// Exchanges USPS_CONSUMER_KEY + USPS_CONSUMER_SECRET for a short-lived bearer
// token from the USPS APIs OAuth2 v3 endpoint, and caches it in module memory
// across invocations within the same warm Lambda instance. Tokens last ~8h;
// we refresh when within REFRESH_BUFFER_MS of expiry to avoid 401s.
//
// One platform-level OAuth app serves all merchant stores — the Prices API is
// unmetered and doesn't touch funds, so there's no per-merchant accounting
// concern. Label printing (Phase 2) would need per-merchant EPS accounts.

const USPS_TOKEN_URL = 'https://apis.usps.com/oauth2/v3/token';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

let cached = null;

async function fetchNewToken() {
  const key = process.env.USPS_CONSUMER_KEY;
  const secret = process.env.USPS_CONSUMER_SECRET;
  if (!key || !secret) {
    throw new Error('USPS_CONSUMER_KEY / USPS_CONSUMER_SECRET not configured');
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: key,
    client_secret: secret,
  });
  const res = await fetch(USPS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`USPS token request failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  if (!data.access_token || typeof data.expires_in !== 'number') {
    throw new Error('USPS token response missing access_token / expires_in');
  }
  return {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

// Returns a valid bearer token, fetching a new one if the cache is empty or
// near expiry. `forceRefresh=true` bypasses the cache — used by callers after
// receiving a 401 (token revoked mid-flight).
async function getUspsToken({ forceRefresh = false } = {}) {
  if (
    !forceRefresh &&
    cached &&
    cached.expiresAt - Date.now() > REFRESH_BUFFER_MS
  ) {
    return cached.token;
  }
  cached = await fetchNewToken();
  return cached.token;
}

module.exports = { getUspsToken };
