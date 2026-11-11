/* GET /api/food/barcode?code=5000159484695
   → { food }            product found with usable nutrition
   → { food: null }      unknown barcode, or a product with no energy value

   Signed-in users only, like /api/state. Responses are edge-cached for a day: product
   nutrition almost never changes, and a re-scan should be instant. */
import { json, withUser } from '../../_lib/auth.js';
import { OFF_UA, OFF_FIELDS, normaliseProduct } from '../../_lib/food.js';

export const onRequestGet = withUser(async ({ request }) => {
  const code = (new URL(request.url).searchParams.get('code') || '').replace(/\D/g, '');
  if (code.length < 6 || code.length > 14) return json({ error: 'Invalid barcode' }, 400);

  const url = `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS}`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': OFF_UA, Accept: 'application/json' },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
    if (r.status === 404) return json({ food: null });
    if (!r.ok) return json({ error: `Lookup failed (${r.status})` }, 502);
    const body = await r.json();
    return json({ food: body?.status === 1 ? normaliseProduct(body.product, code) : null });
  } catch (err) {
    console.error('barcode lookup failed', err);
    return json({ error: 'Lookup failed' }, 502);
  }
});
