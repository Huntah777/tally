/* GET /api/food/search?q=greek+yoghurt
   → { foods: [...] }   up to 20 products that carry an energy value

   Signed-in users only, like /api/state. Uses Open Food Facts' search
   service (search.openfoodfacts.org) — the legacy /cgi/search.pl and
   /api/v2/search endpoints are rate-limited to the point of returning 503s.
   UK products are asked for first; the whole database is the fallback when
   that comes back thin. */
import { json, withUser } from '../../_lib/auth.js';
import { OFF_UA, OFF_FIELDS, normaliseProduct } from '../../_lib/food.js';

const MAX_Q = 80;

async function search(q, ukOnly) {
  const query = ukOnly ? `${q} countries_tags:"en:united-kingdom"` : q;
  const params = new URLSearchParams({ q: query, page_size: '30', langs: 'en', fields: OFF_FIELDS });
  const r = await fetch(`https://search.openfoodfacts.org/search?${params}`, {
    headers: { 'User-Agent': OFF_UA, Accept: 'application/json' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`OFF search ${r.status}`);
  const body = await r.json();
  return (body.hits || []).map((p) => normaliseProduct(p, p.code)).filter(Boolean);
}

export const onRequestGet = withUser(async ({ request }) => {
  /* Quotes and colons would be read as query syntax by the search service. */
  const q = (new URL(request.url).searchParams.get('q') || '').replace(/["():]/g, ' ').trim().slice(0, MAX_Q);
  if (q.length < 2) return json({ foods: [] });

  try {
    let foods = await search(q, true);
    if (foods.length < 5) {
      const seen = new Set(foods.map((f) => f.id));
      for (const f of await search(q, false)) if (!seen.has(f.id)) foods.push(f);
    }
    return json({ foods: foods.slice(0, 20) });
  } catch (err) {
    console.error('food search failed', err);
    return json({ error: 'Search failed' }, 502);
  }
});
