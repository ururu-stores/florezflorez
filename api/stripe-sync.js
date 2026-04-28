const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify GitHub token
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const ghRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: 'token ' + token },
    });
    if (!ghRes.ok) return res.status(401).json({ error: 'Invalid GitHub token' });
  } catch (e) {
    return res.status(401).json({ error: 'Could not verify token' });
  }

  const platformSecret = process.env.PLATFORM_STRIPE_SK || process.env.STRIPE_SECRET_KEY;
  const merchantAccount = process.env.MERCHANT_STRIPE_ACCOUNT_ID;
  if (!platformSecret || !merchantAccount) {
    return res.status(503).json({ error: 'Stripe sync is not configured for this store yet.' });
  }

  const stripe = new Stripe(platformSecret);
  const opts = { stripeAccount: merchantAccount };
  const siteUrl = (process.env.SITE_URL || 'https://florezflorez.vercel.app').replace(/\/$/, '');

  const { action, product } = req.body || {};
  if (!action || !product) return res.status(400).json({ error: 'Missing action or product' });

  function parsePriceCents(display) {
    if (!display) return 0;
    return Math.round(parseFloat(String(display).replace(/[$,\s]/g, '')) * 100);
  }

  function absoluteImageUrl(path) {
    if (!path) return null;
    if (/^https?:\/\//.test(path)) return path;
    // Encode each path segment to handle spaces and special characters in filenames
    const encoded = path.split('/').map(seg => encodeURIComponent(seg)).join('/');
    return siteUrl + encoded;
  }

  try {
    const { title, description, price_display, image_path } = product;
    let { stripe_price_id, stripe_product_id } = product;

    const priceCents = parsePriceCents(price_display);
    if (!priceCents) return res.status(400).json({ error: 'Invalid or missing price' });

    const imageUrl = absoluteImageUrl(image_path);
    const productFields = {
      name: title,
      ...(description ? { description } : {}),
      images: imageUrl ? [imageUrl] : [],
    };

    async function createOnConnectedAccount() {
      const stripeProduct = await stripe.products.create(productFields, opts);
      const stripePrice = await stripe.prices.create({
        product: stripeProduct.id,
        unit_amount: priceCents,
        currency: 'usd',
      }, opts);
      return {
        stripe_product_id: stripeProduct.id,
        stripe_price_id: stripePrice.id,
      };
    }

    // ---- Create ----
    if (action === 'create') {
      return res.status(200).json(await createOnConnectedAccount());
    }

    // ---- Update ----
    if (action === 'update') {
      // Migration path: has price_id but not product_id (pre-sync data)
      if (!stripe_product_id && stripe_price_id) {
        try {
          const existingPrice = await stripe.prices.retrieve(stripe_price_id, opts);
          stripe_product_id = typeof existingPrice.product === 'string'
            ? existingPrice.product
            : existingPrice.product.id;
        } catch (e) {
          if (e.code === 'resource_missing') {
            // Price exists on a different account (legacy pre-Connect sync) —
            // recover by creating fresh on the connected account.
            return res.status(200).json(await createOnConnectedAccount());
          }
          throw e;
        }
      }

      if (!stripe_product_id) {
        return res.status(400).json({ error: 'No Stripe product ID found — sync as new instead' });
      }

      // Update product metadata. If the product itself doesn't exist on the
      // connected account (stranded from a misconfigured earlier sync), fall
      // through to create.
      try {
        await stripe.products.update(stripe_product_id, productFields, opts);
      } catch (e) {
        if (e.code === 'resource_missing') {
          return res.status(200).json(await createOnConnectedAccount());
        }
        throw e;
      }

      // Check if price changed; if so, create new price and archive old
      const existingPrice = await stripe.prices.retrieve(stripe_price_id, opts);
      if (existingPrice.unit_amount !== priceCents) {
        const newPrice = await stripe.prices.create({
          product: stripe_product_id,
          unit_amount: priceCents,
          currency: 'usd',
        }, opts);
        // Stripe refuses to archive a price that's still the product's default_price,
        // so promote the new price to default before archiving the old one.
        await stripe.products.update(stripe_product_id, { default_price: newPrice.id }, opts);
        await stripe.prices.update(stripe_price_id, { active: false }, opts);
        stripe_price_id = newPrice.id;
      }

      return res.status(200).json({ stripe_product_id, stripe_price_id });
    }

    return res.status(400).json({ error: 'Invalid action — use create or update' });

  } catch (err) {
    console.error('Stripe sync error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
