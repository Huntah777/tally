/* ============================================================
   Tally receipts — turn OCR'd receipt text into food lines.
   ------------------------------------------------------------
   Free by design: the photo is read on the device by Tesseract (see
   index.html), and this file does the rest with plain rules:

     1. split the text into lines, keep the ones that look like a priced item
     2. drop totals, payment, VAT, loyalty and promo lines
     3. expand the abbreviations UK supermarkets love ("SS MLK" → semi
        skimmed milk) so a food search has a chance
     4. match against what this user has already confirmed before — every
        confirmed match is remembered as an alias, so the second Tesco shop
        is mostly automatic

   Plain JS so it runs in the page and in Node tests.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyReceipt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Lines that are never food: totals, payment, loyalty, and the fees a
     delivery app or restaurant adds. ("deal"/"offer" aren't here: "Meal
     Deal" is a real item, and promo savings are negative so they're skipped
     anyway.) */
  const SKIP = new RegExp([
    'sub ?total', 'total', 'balance', 'to pay', 'amount due', 'change', 'cash', 'card', 'visa', 'mastercard',
    'amex', 'contactless', 'debit', 'credit', 'tender', 'vat', 'tax', 'saving', 'you saved', 'discount',
    'clubcard', 'nectar', 'points', 'loyalty', 'coupon', 'voucher', 'refund', 'auth', 'merchant', 'terminal',
    'aid:', 'pan seq', 'tel', 'www', 'http', 'thank', 'receipt', 'store', 'cashier', 'operator', 'till',
    'multibuy', 'promo', 'carrier bag', 'bag for life', 'bags?', 'deposit', 'service charge',
    'tip', 'tips', 'gratuity', 'items? sold', 'no\\.? of items', 'qty', 'price', 'reg no', 'vat no', 'transaction',
    // delivery apps & restaurants
    'delivery', 'service fee', 'service', 'small order', 'rider', 'courier', 'driver', 'packaging', 'paid',
    'apple pay', 'google pay', 'paypal', 'order total', 'order no', 'order number', 'covers?', 'guests?',
    'table', 'served by', 'server', 'plus subscription', 'deliveroo plus', 'uber one', 'credit applied',
  ].map((s) => `\\b(?:${s})(?!\\w)`).join('|'), 'i');

  /* Anything that says "this is a delivery order or a restaurant bill". */
  const TAKEAWAY_HINT = /deliveroo|uber\s?eats|just\s?eat|delivery fee|service fee|small order|\brider\b|courier|table\s*(?:no\.?|#)?\s*\d|\bcovers?\b|served by|\bserver\b|gratuity|service charge|restaurant|take\s?away|dine in|eat in|order\s*(?:no|#|number)|\bkitchen\b|\bmeal\b/i;
  const detectKind = (text) => (TAKEAWAY_HINT.test(String(text || '')) ? 'takeaway' : 'grocery');

  /* Add-on lines under an item in app receipts: "+ Large fries", "• Extra
     cheese (+£1.00)", "Drink: Diet Coke", "- No pickles". */
  const MOD_LINE = /^\s*(?:\+|•|·|\*|-\s|–\s|with\b|add\b|extra\b|[A-Za-z ]{2,24}:\s)/i;
  const SIZE_ONLY = /^(?:(?:choose\s+(?:your\s+)?)?size:?\s*)?(small|regular|medium|large|xl|extra large|\d{1,2}\s*(?:"|inch|in))$/i;
  const PRICE_ONLY = /^\s*\(?\+?£?\s?\d{1,4}[.,]\d{2}\)?\s*$/;

  /* Store-brand prefixes and range names that only add noise to a search. */
  const NOISE = /\b(tesco|tsco|tes|sainsbury'?s?|sbys?|js|asda|morrisons?|mrsns|m&s|marks|aldi|lidl|co-?op|waitrose|wtrs|iceland|ocado|finest|everyday value|smart price|stockwell|hearty food|essential|taste the difference|ttd|by sainsbury'?s|extra special|the best|specially selected|deluxe|nisa|spar|booths|budgens|loose|each)\b/gi;

  /* Common receipt abbreviations → words. Order matters only in that
     multi-letter keys are matched as whole tokens. */
  const ABBR = {
    ss: 'semi skimmed', skmd: 'skimmed', wh: 'whole', whl: 'whole', mlk: 'milk', mk: 'milk',
    chkn: 'chicken', chk: 'chicken', ckn: 'chicken', brst: 'breast', brsts: 'breasts', fil: 'fillet', flt: 'fillet', fllts: 'fillets',
    thgh: 'thigh', thghs: 'thighs', bf: 'beef', mnce: 'mince', mnc: 'mince', prk: 'pork', saus: 'sausages', sgs: 'sausages',
    bcn: 'bacon', ham: 'ham', slmn: 'salmon', tna: 'tuna', cod: 'cod', prwn: 'prawns', prwns: 'prawns',
    brd: 'bread', wmeal: 'wholemeal', whlml: 'wholemeal', wml: 'wholemeal', grnry: 'granary', rlls: 'rolls', bgls: 'bagels', wrps: 'wraps',
    yog: 'yoghurt', yogh: 'yoghurt', ygt: 'yoghurt', yght: 'yoghurt', grk: 'greek', grek: 'greek', nat: 'natural',
    chs: 'cheese', chse: 'cheese', ched: 'cheddar', chdr: 'cheddar', mozz: 'mozzarella', mzrla: 'mozzarella', btr: 'butter', bttr: 'butter',
    eggs: 'eggs', egg: 'eggs', frs: 'free range', fr: 'free range', lge: 'large', lrg: 'large', med: 'medium', sml: 'small',
    bns: 'beans', bkd: 'baked', tom: 'tomato', toms: 'tomatoes', tmt: 'tomato', pot: 'potato', pots: 'potatoes', pto: 'potato',
    crsps: 'crisps', crsp: 'crisps', choc: 'chocolate', chc: 'chocolate', bisc: 'biscuits', bscts: 'biscuits', cke: 'cake',
    org: 'organic', frz: 'frozen', frzn: 'frozen', veg: 'vegetables', vg: 'vegetable', mxd: 'mixed', mx: 'mix',
    strwb: 'strawberries', strawb: 'strawberries', rasp: 'raspberries', blueb: 'blueberries', bluebs: 'blueberries',
    ban: 'bananas', bnna: 'bananas', bnns: 'bananas', apl: 'apples', apls: 'apples', orng: 'oranges', grps: 'grapes', avoc: 'avocado', avcd: 'avocado',
    brcli: 'broccoli', brocc: 'broccoli', crrts: 'carrots', crt: 'carrots', onn: 'onions', onns: 'onions', mshrm: 'mushrooms', mush: 'mushrooms', spnch: 'spinach', ltc: 'lettuce', cucmbr: 'cucumber', ppr: 'pepper', pprs: 'peppers',
    oj: 'orange juice', jce: 'juice', pb: 'peanut butter', pnt: 'peanut', jm: 'jam', hny: 'honey',
    ff: 'fat free', lf: 'low fat', rf: 'reduced fat', lsug: 'low sugar', ns: 'no added sugar', nas: 'no added sugar',
    pst: 'pasta', spag: 'spaghetti', rce: 'rice', bsmti: 'basmati', ndl: 'noodles', ndls: 'noodles', oats: 'oats', ots: 'oats', crnflks: 'cornflakes', cerl: 'cereal', grnla: 'granola',
    hmus: 'houmous', hmms: 'houmous', hum: 'houmous', ssg: 'sausage', piz: 'pizza', pza: 'pizza', mrg: 'margherita', sndw: 'sandwich', sndwch: 'sandwich', sw: 'sandwich',
    drk: 'drink', sprklng: 'sparkling', wtr: 'water', cola: 'cola', dt: 'diet', zr: 'zero', cff: 'coffee', cof: 'coffee', ltte: 'latte', cpcno: 'cappuccino',
    sce: 'sauce', ktchp: 'ketchup', mayo: 'mayonnaise', oil: 'oil', olv: 'olive', ev: 'extra virgin', evoo: 'extra virgin olive oil',
    ckd: 'cooked', rst: 'roast', smkd: 'smoked', unsmkd: 'unsmoked', strky: 'streaky', bk: 'back', prot: 'protein', pwdr: 'powder', bar: 'bar', brs: 'bars',
  };

  const PRICE_AT_END = /(-?£?\s?\d{1,4}[.,]\d{2})\s*(?:[A-Z*#]{1,2})?\s*$/;
  const letterCount = (s) => (String(s).match(/[A-Za-z]/g) || []).length;
  const priceOf = (m) => Number(m[1].replace(/[£\s]/g, '').replace(',', '.'));

  function cleanName(s, { bareQty = false } = {}) {
    let out = String(s)
      .replace(PRICE_AT_END, '')
      .replace(/\(\s*\+?\s*£?\s?\d+[.,]\d{2}\s*\)/g, '')  /* "(+£0.80)" */
      .replace(/^\s*\d+\s*[x@*×]\s*/i, '')             /* "2 x " / "2 @ " / "1×" */
      .replace(/\s+[x×]\s?\d+\s*$/i, '')                /* "… x2" */
      .replace(/\s+\d+\s*@\s*£?\d+[.,]\d{2}.*$/i, '');   /* "… 2 @ £1.50" */
    if (bareQty) out = out.replace(/^\s*\d{1,2}\s+(?=[A-Za-z])/, ''); /* restaurant "2 Margherita" */
    return out.replace(/[^A-Za-z0-9&%'". \-/]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }
  const cleanMod = (s) => cleanName(String(s)
    .replace(/^\s*(?:\+|•|·|\*|-|–)\s*/, '')
    .replace(/^(?:with|add|extra)\s+/i, '')
    .replace(/^[A-Za-z ]{2,24}:\s*/, ''));

  /* Text → [{ raw, name, price, qty, mod? }]. `kind` is 'grocery' or
     'takeaway' (delivery apps and restaurant bills); detected if omitted. */
  function parseReceiptText(text, kind = detectKind(text)) {
    const takeaway = kind === 'takeaway';
    const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const items = [];
    let last = null;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      /* App screenshots often put the price on the line below the name. */
      if (!PRICE_AT_END.test(line) && PRICE_ONLY.test(lines[i + 1] || '') && letterCount(line) >= 3 && !SKIP.test(line) && !(takeaway && last && MOD_LINE.test(line))) {
        line = `${line} ${lines[i + 1].replace(/[()+]/g, '')}`;
        i++;
      }

      if (takeaway && last && MOD_LINE.test(line) && !SKIP.test(line)) {
        const t = cleanMod(line);
        if (!t || /^(no|without|hold|less|remove)\b/i.test(t) || letterCount(t) < 3) continue;
        /* Sizes and meal-deal choices refine the item above rather than
           becoming items of their own: "Big Mac Meal" + "Drink: Diet Coke"
           is a meal with a diet drink, not an extra Coke. */
        if (SIZE_ONLY.test(t) || /\bmeal\b/i.test(last.name)) { last.name = `${last.name} ${t}`; continue; }
        const pm = PRICE_AT_END.exec(line);
        items.push({ raw: line, name: t, price: pm ? priceOf(pm) : 0, qty: last.qty, mod: true });
        continue;
      }

      const pm = PRICE_AT_END.exec(line);
      if (!pm) continue;
      const price = priceOf(pm);
      if (!(price > 0) || price > 500) continue;                /* negatives are discounts */
      if (SKIP.test(line)) continue;
      /* "1x 9 Chicken McNuggets": the 1 is the quantity, the 9 belongs to
         the name — only treat a bare leading number as quantity when there
         is no explicit "1x". */
      const explicitQty = /^\s*\d+\s*[x@*×]\s*/i.test(line);
      const name = cleanName(line, { bareQty: takeaway && !explicitQty });
      if (letterCount(name) < 3) {
        /* A bare "2 @ £1.50  3.00" line belongs to the item above it. */
        const qm = /^(\d+)\s*[x@]/i.exec(line);
        if (last && qm) last.qty = Number(qm[1]);
        continue;
      }
      const qm = /^\s*(\d+)\s*[x@*×]\s*/i.exec(line)
        || /\s[x×]\s?(\d+)\s+£?\d/i.exec(line)
        || (takeaway && /^\s*(\d{1,2})\s+(?=[A-Za-z])/.exec(line));
      last = { raw: line, name, price, qty: qm ? Math.max(1, Number(qm[1])) : 1 };
      items.push(last);
    }
    return items;
  }

  /* Pack size from the line, e.g. "2L", "500G", "6PK", "4X125G". */
  function packSize(name) {
    const s = String(name).toLowerCase();
    let m = /(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(g|ml)\b/.exec(s);
    if (m) return { amount: Number(m[1]) * Number(m[2]), unit: m[3] };
    m = /(\d+(?:\.\d+)?)\s*(kg|g|l|ltr|ml|cl)\b/.exec(s);
    if (m) {
      const v = Number(m[1]);
      const u = m[2];
      if (u === 'kg') return { amount: v * 1000, unit: 'g' };
      if (u === 'l' || u === 'ltr') return { amount: v * 1000, unit: 'ml' };
      if (u === 'cl') return { amount: v * 10, unit: 'ml' };
      return { amount: v, unit: u };
    }
    m = /(\d+)\s*(pk|pack)\b/.exec(s);
    if (m) return { count: Number(m[1]) };
    return null;
  }

  /* Abbreviated receipt name → something a food search understands. */
  function expand(name) {
    const base = String(name).replace(NOISE, ' ')
      .replace(/\b\d+(?:\.\d+)?\s*(kg|g|l|ltr|ml|cl|pk|pack)\b/gi, ' ')
      .replace(/\b\d+\s*x\b/gi, ' ');
    const words = base.toLowerCase().split(/[^a-z&']+/).filter(Boolean)
      .map((w) => ABBR[w] || w)
      .filter((w) => w.length > 1 || w === '&');
    return [...new Set(words.join(' ').split(' '))].join(' ').trim();
  }

  /* Stable key for remembering what a line meant. Drops store prefixes,
     sizes and punctuation so "TESCO SS MILK 2L" and "TESCO SS MILK 4PT" meet. */
  const aliasKey = (name) => String(name).toUpperCase().replace(NOISE, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(KG|G|L|LTR|ML|CL|PK|PACK|PT)\b/g, ' ')
    .replace(/[^A-Z]/g, '');

  const tokens = (s) => new Set(String(s).toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2));
  function similarity(a, b) {
    const A = tokens(a), B = tokens(b);
    if (!A.size || !B.size) return 0;
    let hit = 0;
    for (const w of A) if (B.has(w)) hit++;
    return hit / Math.min(A.size, B.size) * (hit / Math.max(A.size, B.size)) ** 0.25;
  }

  /* Best match from the user's own foods. Aliases (confirmed before) win
     outright; otherwise a fuzzy word overlap has to be convincing. */
  function matchLocal(item, foods, aliases) {
    const key = aliasKey(item.name);
    if (key && aliases && aliases[key]) {
      const f = foods.find((x) => x.id === aliases[key].foodId);
      if (f) return { food: f, grams: aliases[key].grams, how: 'remembered', score: 1 };
    }
    const query = expand(item.name);
    let best = null;
    for (const f of foods) {
      const sc = similarity(query, `${f.name} ${f.brand || ''}`);
      if (sc >= 0.6 && (!best || sc > best.score)) best = { food: f, how: 'similar', score: sc };
    }
    return best;
  }

  return { parseReceiptText, detectKind, expand, aliasKey, packSize, matchLocal, similarity, cleanName };
});
