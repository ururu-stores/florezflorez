// Recomputes shipping options after the buyer enters/changes their address
// during embedded Stripe Checkout. Wired up via Stripe's
// `permissions.update_shipping_details = "server_only"` + the client-side
// `onShippingDetailsChange` callback (see js/main.js).
//
// Flow:
//  1. Client posts { session_id, shipping_details } from the embedded checkout
//     callback.
//  2. We retrieve the session (with line_items) on the connected account.
//  3. For each line item, look up the piece in content/*.json (matched by
//     stripe_price_id) and sum its weight_oz.
//  4. Call USPS Prices /base-rates/search for USPS_GROUND_ADVANTAGE to the
//     buyer's ZIP, get a price in dollars.
//  5. If the cart subtotal >= settings.shipping.free_threshold (when set),
//     override the price to $0.
//  6. Update the Checkout Session's shipping_options via the Stripe SDK so
//     the embedded UI redraws the line.

const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');
const { getUspsToken } = require('./usps-token');

const USPS_PRICES_URL = 'https://apis.usps.com/prices/v3/base-rates/search';
// Match the version used in api/checkout.js so retrieve/update see the same
// session shape that ui_mode='embedded_page' creates.
const STRIPE_API_VERSION = '2026-04-22.dahlia';

// Default package dimensions for rate calculation. Most ururu merchants ship
// small handmade goods (jewelry, prints) in padded mailers; a 9×6×3 inch
// envelope is a safe baseline. Could become a per-merchant setting later.
const DEFAULT_DIMENSIONS_INCHES = { length: 9, width: 6, height: 3 };
const FALLBACK_PIECE_WEIGHT_OZ = 4;
const USPS_GROUND_ADVANTAGE_MAX_LBS = 70;

function loadSettings() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'content', 'settings.json'), 'utf8')
    );
  } catch {
    return {};
  }
}

// Build a { stripe_price_id -> piece } map by scanning every content/*.json
// file that has a `pieces` array. Cheap enough to do per-request: handful of
// small JSON files, no DB roundtrip.
function loadPieceIndex() {
  const dir = path.join(process.cwd(), 'content');
  const index = {};
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return index;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!parsed || !Array.isArray(parsed.pieces)) continue;
    for (const piece of parsed.pieces) {
      if (piece && piece.stripe_price_id) {
        index[piece.stripe_price_id] = piece;
      }
    }
  }
  return index;
}

function extractZip(rawZip) {
  if (!rawZip || typeof rawZip !== 'string') return null;
  const match = rawZip.match(/^(\d{5})/);
  return match ? match[1] : null;
}

async function fetchUspsRate({ originZip, destinationZip, weightLbs }) {
  const body = {
    originZIPCode: originZip,
    destinationZIPCode: destinationZip,
    weight: weightLbs,
    length: DEFAULT_DIMENSIONS_INCHES.length,
    width: DEFAULT_DIMENSIONS_INCHES.width,
    height: DEFAULT_DIMENSIONS_INCHES.height,
    mailClass: 'USPS_GROUND_ADVANTAGE',
    processingCategory: 'MACHINABLE',
    rateIndicator: 'SP',
    destinationEntryFacilityType: 'NONE',
    priceType: 'RETAIL',
  };

  async function call(token) {
    return fetch(USPS_PRICES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  let token = await getUspsToken();
  let res = await call(token);
  if (res.status === 401) {
    token = await getUspsToken({ forceRefresh: true });
    res = await call(token);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`USPS rate lookup failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  if (typeof data.totalBasePrice !== 'number') {
    throw new Error('USPS response missing totalBasePrice');
  }
  return data.totalBasePrice;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const platformSecret = process.env.PLATFORM_STRIPE_SK;
  const merchantAccount = process.env.MERCHANT_STRIPE_ACCOUNT_ID;
  if (!platformSecret || !merchantAccount) {
    res.status(503).json({ error: 'Checkout is not configured for this store' });
    return;
  }

  // Stripe's onShippingDetailsChange callback hands us
  // { checkoutSessionId, shippingDetails }; the client serializes those as
  // { checkout_session_id, shipping_details }. Accept the older snake-case
  // session_id too in case any caller still sends it.
  const checkoutSessionId =
    (req.body && (req.body.checkout_session_id || req.body.session_id)) || null;
  const shipping_details = req.body && req.body.shipping_details;
  if (!checkoutSessionId || !shipping_details || !shipping_details.address) {
    res
      .status(400)
      .json({ type: 'error', message: 'Missing checkout_session_id or shipping_details.address' });
    return;
  }

  const settings = loadSettings();
  const shipping = settings.shipping || {};
  if (shipping.method !== 'usps') {
    res.status(400).json({ type: 'error', message: 'USPS shipping not enabled in settings' });
    return;
  }
  const originZip = extractZip(shipping.origin_zip);
  if (!originZip) {
    res.status(503).json({ type: 'error', message: 'Origin ZIP not configured' });
    return;
  }

  const destinationZip = extractZip(shipping_details.address.postal_code);
  if (!destinationZip) {
    res.status(400).json({ type: 'error', message: 'Destination ZIP missing or malformed' });
    return;
  }
  if (
    shipping_details.address.country &&
    shipping_details.address.country.toUpperCase() !== 'US'
  ) {
    res.status(400).json({ type: 'error', message: 'USPS Ground Advantage is US-domestic only' });
    return;
  }

  const stripe = new Stripe(platformSecret);
  const opts = { stripeAccount: merchantAccount, apiVersion: STRIPE_API_VERSION };

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(
      checkoutSessionId,
      { expand: ['line_items'] },
      opts
    );
  } catch (err) {
    res.status(404).json({ type: 'error', message: 'Session not found', detail: err.message });
    return;
  }

  const lineItems = session.line_items?.data || [];
  if (lineItems.length === 0) {
    res.status(400).json({ type: 'error', message: 'Session has no line items' });
    return;
  }

  // Each piece carries weight as { weight_lb, weight_oz } where either may be
  // omitted/zero (e.g. a sub-pound item only fills weight_oz). We sum both
  // into total ounces, then convert to pounds for the USPS request.
  const pieceIndex = loadPieceIndex();
  let totalWeightOz = 0;
  for (const li of lineItems) {
    const priceId = li.price?.id;
    const piece = priceId ? pieceIndex[priceId] : null;
    let perPieceOz = 0;
    if (piece) {
      if (typeof piece.weight_lb === 'number' && piece.weight_lb > 0) {
        perPieceOz += piece.weight_lb * 16;
      }
      if (typeof piece.weight_oz === 'number' && piece.weight_oz > 0) {
        perPieceOz += piece.weight_oz;
      }
    }
    if (perPieceOz <= 0) perPieceOz = FALLBACK_PIECE_WEIGHT_OZ;
    totalWeightOz += perPieceOz * (li.quantity || 1);
  }
  if (totalWeightOz <= 0) totalWeightOz = FALLBACK_PIECE_WEIGHT_OZ;

  const weightLbs = totalWeightOz / 16;
  if (weightLbs > USPS_GROUND_ADVANTAGE_MAX_LBS) {
    res.status(400).json({
      type: 'error',
      message: `Cart weight ${weightLbs.toFixed(1)} lb exceeds USPS Ground Advantage limit of ${USPS_GROUND_ADVANTAGE_MAX_LBS} lb`,
    });
    return;
  }

  let amountCents;
  try {
    const dollars = await fetchUspsRate({
      originZip,
      destinationZip,
      weightLbs,
    });
    amountCents = Math.round(dollars * 100);
  } catch (err) {
    console.error('USPS rate error:', err.message);
    res
      .status(502)
      .json({ type: 'error', message: 'Could not fetch USPS rate', detail: err.message });
    return;
  }

  // Free-shipping override: subtotal compares against settings.free_threshold
  // (dollars). amount_subtotal is in cents and excludes shipping/tax.
  const subtotalCents = session.amount_subtotal || 0;
  let displayName = `USPS Ground Advantage (~${(weightLbs).toFixed(1)} lb)`;
  if (
    typeof shipping.free_threshold === 'number' &&
    shipping.free_threshold > 0 &&
    subtotalCents >= shipping.free_threshold * 100
  ) {
    amountCents = 0;
    displayName = 'Free shipping';
  }

  // Per Stripe's "Customize shipping options" docs, the update has to set
  // both shipping_options AND collected_information.shipping_details — when
  // permissions.update_shipping_details is server_only, the client doesn't
  // write the buyer's address back to the session, so we mirror it here from
  // what the callback handed us.
  //
  // We call the REST endpoint directly because the installed stripe-node v14
  // doesn't expose stripe.checkout.sessions.update (that method landed in a
  // later major release).
  try {
    const params = {
      'shipping_options[0][shipping_rate_data][display_name]': displayName,
      'shipping_options[0][shipping_rate_data][type]': 'fixed_amount',
      'shipping_options[0][shipping_rate_data][fixed_amount][amount]': String(amountCents),
      'shipping_options[0][shipping_rate_data][fixed_amount][currency]': 'usd',
    };
    if (shipping_details.name) {
      params['collected_information[shipping_details][name]'] = shipping_details.name;
    }
    const addr = shipping_details.address || {};
    const addrFields = ['line1', 'line2', 'city', 'state', 'postal_code', 'country'];
    for (const field of addrFields) {
      if (addr[field]) {
        params[`collected_information[shipping_details][address][${field}]`] = addr[field];
      }
    }
    const formBody = new URLSearchParams(params);
    const r = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${checkoutSessionId}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${platformSecret}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Stripe-Account': merchantAccount,
          'Stripe-Version': STRIPE_API_VERSION,
        },
        body: formBody.toString(),
      }
    );
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} ${text}`);
    }
  } catch (err) {
    console.error('Stripe session update error:', err.message);
    res
      .status(500)
      .json({ type: 'error', message: 'Failed to update shipping options', detail: err.message });
    return;
  }

  res.status(200).json({
    type: 'object',
    value: {
      succeeded: true,
      amount_cents: amountCents,
      weight_oz: totalWeightOz,
    },
  });
};
