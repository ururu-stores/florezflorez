const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const priceId = req.query.price_id;

  if (!priceId) {
    res.status(400).json({ error: 'Missing price_id' });
    return;
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${req.headers.origin}/?checkout=success`,
      cancel_url: `${req.headers.origin}/?checkout=cancel`,
    });

    res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({
      error: 'Failed to create checkout session',
      detail: err.message,
      type: err.type || null
    });
  }
};
