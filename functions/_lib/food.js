/* Open Food Facts → Tally's food shape.

   OFF is free, needs no key, and covers UK supermarket barcodes well. It asks
   API users to send an identifying User-Agent, which a browser can't set —
   one reason these lookups go through a Function instead of straight from the
   page. The other is the CSP: the page only ever talks to its own origin. */

export const OFF_UA = 'Tally/1.0 (personal calorie tracker)';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/* Energy is published inconsistently: some products only carry kJ. 1 kcal =
   4.184 kJ. Fall back to macros (4/4/9) when energy is missing entirely. */
function kcalPer100(n) {
  const kcal = num(n['energy-kcal_100g']) ?? num(n['energy-kcal']);
  if (kcal != null) return kcal;
  const kj = num(n['energy-kj_100g']) ?? num(n['energy_100g']);
  if (kj != null) return kj / 4.184;
  const p = num(n.proteins_100g), c = num(n.carbohydrates_100g), f = num(n.fat_100g);
  if (p != null || c != null || f != null) return (p || 0) * 4 + (c || 0) * 4 + (f || 0) * 9;
  return null;
}

export function normaliseProduct(p, code) {
  if (!p) return null;
  const n = p.nutriments || {};
  const kcal = kcalPer100(n);
  if (kcal == null) return null;
  const servingG = num(p.serving_quantity);
  return {
    id: 'off:' + (code || p.code),
    barcode: String(code || p.code || ''),
    name: (p.product_name_en || p.product_name || p.generic_name || 'Unnamed product').trim(),
    /* product pages give a comma string, the search service an array */
    brand: String((Array.isArray(p.brands) ? p.brands[0] : (p.brands || '').split(',')[0]) || '').trim(),
    image: p.image_front_small_url || p.image_small_url || null,
    per100: {
      kcal: Math.round(kcal),
      protein: round1(num(n.proteins_100g)) ?? 0,
      carbs: round1(num(n.carbohydrates_100g)) ?? 0,
      fat: round1(num(n.fat_100g)) ?? 0,
    },
    serving: servingG ? { g: servingG, label: p.serving_size || `${servingG} g` } : null,
    unit: /ml\b/i.test(p.quantity || '') ? 'ml' : 'g',
    source: 'openfoodfacts',
  };
}

export const OFF_FIELDS = [
  'code', 'product_name', 'product_name_en', 'generic_name', 'brands', 'quantity',
  'serving_size', 'serving_quantity', 'nutriments', 'image_front_small_url', 'image_small_url',
].join(',');
