const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const origin = req.headers.origin || req.headers.referer?.replace(/\/[^/]*$/, '') || `https://${req.headers.host}`;

  let line_items;

  if (req.method === 'POST') {
    // Cart checkout: multiple items
    const { items } = req.body || {};
    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'Missing or empty items array' });
      return;
    }
    line_items = items.map(item => ({
      price: item.price_id,
      quantity: item.quantity || 1,
    }));
  } else {
    // Legacy single-item checkout (GET)
    const priceId = req.query.price_id;
    if (!priceId) {
      res.status(400).json({ error: 'Missing price_id' });
      return;
    }
    line_items = [{ price: priceId, quantity: 1 }];
  }

  try {
    // Look up prices to calculate order total for pixel tracking
    const prices = await Promise.all(
      line_items.map(li => stripe.prices.retrieve(li.price))
    );
    const totalCents = prices.reduce((sum, price, i) => {
      return sum + (price.unit_amount * (line_items[i].quantity || 1));
    }, 0);
    const total = (totalCents / 100).toFixed(2);

    const sessionParams = {
      mode: 'payment',
      line_items,
      shipping_address_collection: {
        allowed_countries: ['US'],
      },
      shipping_options: [
        { shipping_rate: 'shr_1TLE6gGZz3PbqlU6QUzZfFdG' },
      ],
      success_url: `${origin}/?checkout=success&total=${total}`,
      cancel_url: `${origin}/?checkout=cancel`,
    };

    // Auto-apply free shipping coupon on orders over $200
    if (totalCents > 20000) {
      sessionParams.discounts = [{ coupon: 'yfDilCGY' }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    if (req.method === 'POST') {
      res.status(200).json({ url: session.url });
    } else {
      res.redirect(303, session.url);
    }
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({
      error: 'Failed to create checkout session',
      detail: err.message,
      type: err.type || null
    });
  }
};
