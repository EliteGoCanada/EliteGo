// EliteGo: creates a Stripe Checkout page for a ride.
// The price is recalculated here on the server, so it can't be changed in the browser.
// The card is only HELD (authorised). You capture (charge) it in Stripe once you confirm the ride.
//
// Netlify environment variables needed:
//   STRIPE_SECRET_KEY  - from Stripe > Developers > API keys (starts with sk_test_ or sk_live_)
//   GOOGLE_SERVER_KEY  - a Google key with only the Routes API enabled (no website restriction)

import Stripe from 'stripe';
import pricing from '../../public/pricing.json';

const HOURS = [3, 4, 5, 6, 8, 10, 12];

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fareFor(cls, km, min) {
  const p = pricing.vehicles[cls];
  const near = Math.min(km, pricing.longKmAfter);
  const far = Math.max(km - pricing.longKmAfter, 0);
  const f = p.base + near * p.perKm + far * p.perKm * pricing.longKmDiscount + min * p.perMin;
  return Math.max(p.min, Math.round(f / 5) * 5);
}

async function routeKmMin(from, to, googleKey) {
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': googleKey,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
    },
    body: JSON.stringify({ origin: { address: from }, destination: { address: to }, travelMode: 'DRIVE', regionCode: 'ca' }),
  });
  if (!res.ok) throw new Error('Routes API ' + res.status + ': ' + (await res.text()));
  const data = await res.json();
  const r = data.routes && data.routes[0];
  if (!r || !r.distanceMeters) throw new Error('No route found');
  return { km: r.distanceMeters / 1000, min: parseFloat(r.duration || '0') / 60 };
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  // Tolerate stray spaces/quotes pasted around the keys in the Netlify UI
  const clean = (v) => String(v ?? '').trim().replace(/^['"]+|['"]+$/g, '').trim();
  const stripeKey = clean(process.env.STRIPE_SECRET_KEY);
  const googleKey = clean(process.env.GOOGLE_SERVER_KEY);
  if (!stripeKey || !googleKey) {
    console.error('Checkout not configured: missing ' + [!stripeKey && 'STRIPE_SECRET_KEY', !googleKey && 'GOOGLE_SERVER_KEY'].filter(Boolean).join(' and '));
    return json(503, { error: 'Online payment is not set up yet.' });
  }
  if (!/^(sk|rk)_(test|live)_/.test(stripeKey)) {
    console.error('STRIPE_SECRET_KEY does not look like a Stripe secret key (expected it to start with sk_test_ or sk_live_; it starts with "' + stripeKey.slice(0, 4) + '").');
    return json(503, { error: 'Online payment is not set up correctly yet.' });
  }

  let b;
  try { b = await req.json(); } catch { return json(400, { error: 'Something went wrong with the booking details.' }); }

  const s = (v, n = 300) => String(v ?? '').trim().slice(0, n);
  const d = {
    type: b.type === 'hourly' ? 'hourly' : 'oneway',
    pickup: s(b.pickup), dropoff: s(b.dropoff), hours: parseInt(b.hours, 10),
    date: s(b.date, 10), time: s(b.time, 5), vehicle: s(b.vehicle, 40), passengers: s(b.passengers, 2),
    flight: s(b.flight, 20), name: s(b.name, 100), phone: s(b.phone, 30), email: s(b.email, 120), notes: s(b.notes, 450),
  };

  const p = pricing.vehicles[d.vehicle];
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
  if (!p) return json(400, { error: 'Please choose a vehicle.' });
  if (!d.pickup || !d.name || !d.phone) return json(400, { error: 'Some booking details are missing.' });
  if (!/^\S+@\S+\.\S+$/.test(d.email)) return json(400, { error: 'That email address looks incomplete.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || d.date < today) return json(400, { error: 'Choose a pickup date from today onward.' });
  if (!/^\d{2}:\d{2}$/.test(d.time)) return json(400, { error: 'Choose a pickup time.' });

  let amount, summary, km = null, mins = null;
  if (d.type === 'hourly') {
    if (!HOURS.includes(d.hours)) return json(400, { error: 'Choose a valid duration.' });
    amount = p.hourly * d.hours;
    summary = `${d.hours} hours with chauffeur, starting at ${d.pickup}`;
  } else {
    if (!d.dropoff) return json(400, { error: 'Enter a drop-off address.' });
    try {
      ({ km, min: mins } = await routeKmMin(d.pickup, d.dropoff, googleKey));
    } catch (e) {
      console.error('Route pricing failed: ' + (e && e.message));
      return json(422, { error: "We couldn't price that route automatically." });
    }
    amount = fareFor(d.vehicle, km, mins);
    summary = `${d.pickup} → ${d.dropoff} · ${km.toFixed(1)} km`;
  }

  const meta = {
    trip_type: d.type === 'hourly' ? 'By the hour' : 'One way',
    pickup: d.pickup.slice(0, 490), dropoff: d.dropoff.slice(0, 490),
    hours: d.type === 'hourly' ? String(d.hours) : '',
    date: d.date, time: d.time, vehicle: d.vehicle, passengers: d.passengers,
    flight: d.flight, name: d.name, phone: d.phone, notes: d.notes,
    distance_km: km ? km.toFixed(1) : '', duration_min: mins ? String(Math.round(mins)) : '',
  };

  const stripe = new Stripe(stripeKey);
  const site = process.env.URL || new URL(req.url).origin;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: d.email,
      customer_creation: 'always',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'cad',
          unit_amount: Math.round(amount * 100),
          product_data: {
            name: `EliteGo ${d.vehicle} · ${d.date} at ${d.time}`,
            description: (summary + '. All-inclusive: tax and gratuity included.').slice(0, 500),
          },
        },
      }],
      payment_intent_data: {
        capture_method: 'manual',          // hold now, charge when you confirm
        setup_future_usage: 'off_session', // saves the card in case the hold expires (7 days)
        description: `EliteGo ride ${d.date} ${d.time} · ${d.name}`,
        metadata: meta,
      },
      metadata: meta,
      success_url: `${site}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/#book`,
    });
    return json(200, { url: session.url, amount });
  } catch (e) {
    // Stripe masks keys in its own messages, so this is safe to log
    console.error('Stripe checkout failed: ' + [e && e.type, e && e.code, e && e.param, e && e.message].filter(Boolean).join(' | '));
    const why = e && e.type === 'StripeAuthenticationError' ? ' (payment settings need attention)' : '';
    return json(502, { error: 'The payment page could not be opened' + why + '.' });
  }
};

export const config = { path: '/api/checkout' };
