/* ============================================================
   Tally importers — bring history in from other apps.
   ------------------------------------------------------------
   Runs entirely in the browser (and in Node for tests). Nothing is
   uploaded anywhere except the user's own Tally account afterwards.

   Recognised automatically:
     • MyFitnessPal   — the export ZIP (Settings → Export Data) or its CSVs:
                        Nutrition-Summary-*.csv, Measurement-Summary-*.csv
     • Lose It!       — food-logs / weights CSVs from the export ZIP
     • Cronometer     — servings.csv, dailysummary.csv, biometrics.csv
     • Apple Health   — export.zip or export.xml (body mass + dietary energy)
     • Anything else  — any CSV with a date column and calories and/or weight
                        (Fitbit, Samsung Health, Google Fit, Libra, Happy
                        Scale, spreadsheets…). Columns are guessed from the
                        header and can be corrected in the preview.

   Output is always { entries: [...], weights: [...], notes: [...] } with
   deterministic ids, so importing the same file twice updates rather than
   duplicates.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyImport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── CSV (RFC 4180: quotes, escaped quotes, newlines in fields) ── */
  function parseCsv(text) {
    text = String(text).replace(/^﻿/, '');
    const delim = sniffDelimiter(text);
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return { headers: [], rows: [] };
    const headers = rows[0].map((h) => h.trim());
    return {
      headers,
      rows: rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))),
    };
  }
  function sniffDelimiter(text) {
    const first = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : 500);
    const counts = { ',': 0, ';': 0, '\t': 0 };
    for (const c of first) if (c in counts) counts[c]++;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
  }

  /* ── ZIP (stored + deflate) via the browser's DecompressionStream ── */
  async function readZip(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = [];
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), cmtLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + cmtLen;
      if (name.endsWith('/')) continue;
      const lNameLen = dv.getUint16(local + 26, true), lExtraLen = dv.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      const data = u8.subarray(start, start + csize);
      files.push({
        name,
        async text() {
          if (method === 0) return dec.decode(data);
          if (method !== 8) throw new Error(`Unsupported compression in ${name}`);
          const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
          return new Response(stream).text();
        },
      });
    }
    return files;
  }

  /* ── values ── */
  const num = (v) => {
    if (v == null) return null;
    const s = String(v).replace(/[^\d.,-]/g, '');
    if (!s) return null;
    /* "1,234.5" → 1234.5 ; "1234,5" (EU decimal) → 1234.5 */
    const n = /,\d{1,2}$/.test(s) && !s.includes('.') ? Number(s.replace(',', '.')) : Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  /* Date strings come in every shape. Ambiguous d/m vs m/d is decided once
     per file from the data itself (any first part > 12 ⇒ day-first). */
  function dateOrderFor(values) {
    let dayFirst = 0, monthFirst = 0;
    for (const v of values) {
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(String(v).trim());
      if (!m) continue;
      if (+m[1] > 12) dayFirst++;
      if (+m[2] > 12) monthFirst++;
    }
    if (dayFirst && !monthFirst) return 'dmy';
    if (monthFirst && !dayFirst) return 'mdy';
    return null; /* undecidable — caller picks a default */
  }
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const p2 = (n) => String(n).padStart(2, '0');
  function parseDate(v, order = 'dmy') {
    const s = String(v || '').trim();
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
    if (m) return `${m[1]}-${p2(m[2])}-${p2(m[3])}`;
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s);
    if (m) {
      let [, a, b, y] = m;
      if (y.length === 2) y = '20' + y;
      const [d, mo] = order === 'mdy' ? [b, a] : [a, b];
      if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
      return `${y}-${p2(mo)}-${p2(d)}`;
    }
    m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/.exec(s);           /* 31 Jan 2024 */
    if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${p2(MONTHS[m[2].toLowerCase()])}-${p2(m[1])}`;
    m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s);         /* Jan 31, 2024 */
    if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${p2(MONTHS[m[1].toLowerCase()])}-${p2(m[2])}`;
    return null;
  }

  const LB = 2.2046226218;
  const weightToKg = (v, unit) => {
    if (v == null) return null;
    const u = String(unit || 'kg').toLowerCase();
    if (u.startsWith('lb') || u === 'pounds') return v / LB;
    if (u.startsWith('st')) return (v * 14) / LB;
    return v;
  };
  /* Values in a weight column with no unit given: plausible human weights in
     kg sit ~40–200, in lb ~90–450. Mostly-over-150 strongly suggests lb. */
  function guessWeightUnit(values, fallback = 'kg') {
    const vs = values.filter((v) => v > 0);
    if (!vs.length) return fallback;
    const sorted = [...vs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > 150) return 'lb';
    if (median < 30) return 'st';
    return fallback === 'st' ? 'kg' : fallback;
  }

  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const mealOf = (s) => {
    const m = String(s || '').toLowerCase();
    if (m.includes('break')) return 'breakfast';
    if (m.includes('lunch')) return 'lunch';
    if (m.includes('dinner') || m.includes('supper') || m.includes('tea')) return 'dinner';
    return 'snacks';
  };
  const r1 = (n) => Math.round((n || 0) * 10) / 10;

  /* ── header matching ── */
  const findCol = (headers, ...patterns) => {
    for (const re of patterns) {
      const h = headers.find((x) => re.test(x));
      if (h) return h;
    }
    return null;
  };
  const COLS = {
    date: [/^date$/i, /^day$/i, /date/i, /^time/i],
    meal: [/^meal$/i, /^type$/i, /^group$/i, /meal/i],
    name: [/^food name$/i, /^name$/i, /description/i, /^food/i, /item/i],
    kcal: [/^calories$/i, /^energy \(kcal\)$/i, /calories/i, /kcal/i, /energy/i],
    protein: [/^protein/i, /protein/i],
    carbs: [/^carbohydrates/i, /^carbs/i, /carb/i],
    fat: [/^fat \(g\)$/i, /^fat$/i, /^total fat/i, /^fat/i],
    weight: [/^weight$/i, /^body ?weight/i, /weight/i, /^mass/i],
  };
  function guessColumns(headers) {
    const out = {};
    for (const [k, pats] of Object.entries(COLS)) out[k] = findCol(headers, ...pats);
    /* "Saturated Fat" etc. must never be picked as fat */
    if (out.fat && /saturated|trans|poly|mono/i.test(out.fat)) out.fat = headers.find((h) => /^fat/i.test(h) && !/saturated|trans|poly|mono/i.test(h)) || null;
    if (out.weight && /unit/i.test(out.weight)) out.weight = null;
    return out;
  }

  /* ── format detectors ── */
  function kindOfCsv(name, headers) {
    const H = headers.join('|');
    const n = name.toLowerCase();
    if (/nutrition-summary/.test(n) || (/\bMeal\b/.test(H) && /Calories/.test(H) && /Fat \(g\)/.test(H) && /Protein \(g\)/.test(H) && !/Food Name|Name\|/.test(H))) return 'mfp-nutrition';
    if (/measurement-summary/.test(n)) return 'mfp-measurement';
    if (/exercise-summary/.test(n)) return 'skip';
    if (/Food Name/.test(H) && /Energy \(kcal\)/.test(H) && /\bDay\b/.test(H)) return 'cronometer-servings';
    if (/\bMetric\b/.test(H) && /\bAmount\b/.test(H) && /\bDay\b/.test(H)) return 'cronometer-biometrics';
    if (/Energy \(kcal\)/.test(H) && /^Date\|/.test(H) && /dailysummary|daily/.test(n)) return 'cronometer-daily';
    if (/\bName\b/.test(H) && /\bCalories\b/.test(H) && /\bType\b/.test(H) && /\bQuantity\b/.test(H)) return 'loseit-food';
    return 'generic';
  }

  /* ── per-format parsers. Each returns { entries, weights, notes } ── */
  function fromMfpNutrition(rows, src = 'mfp') {
    const groups = new Map();
    const order = dateOrderFor(rows.map((r) => r.Date));
    for (const r of rows) {
      const date = parseDate(r.Date, order || 'mdy');
      if (!date) continue;
      const meal = mealOf(r.Meal);
      const key = `${date}|${meal}|${r.Meal}`;
      const g = groups.get(key) || { date, meal, label: r.Meal || 'Food', kcal: 0, protein: 0, carbs: 0, fat: 0 };
      g.kcal += num(r.Calories) || 0;
      g.protein += num(r['Protein (g)']) || 0;
      g.carbs += num(r['Carbohydrates (g)']) || 0;
      g.fat += num(r['Fat (g)']) || 0;
      groups.set(key, g);
    }
    const entries = [...groups.values()].filter((g) => g.kcal > 0).map((g) => ({
      id: `imp:${src}:${g.date}:${slug(g.label)}`,
      date: g.date, meal: g.meal, name: `${g.label} (MyFitnessPal)`,
      kcal: Math.round(g.kcal), protein: r1(g.protein), carbs: r1(g.carbs), fat: r1(g.fat),
      source: 'import:mfp',
    }));
    return { entries, weights: [], notes: [`MyFitnessPal only exports meal totals, not individual foods — each meal arrives as one entry.`] };
  }

  function weightsFrom(rows, dateCol, weightCol, unit, src, label) {
    const order = dateOrderFor(rows.map((r) => r[dateCol]));
    const raw = rows.map((r) => ({ date: parseDate(r[dateCol], order || 'dmy'), v: num(r[weightCol]) }))
      .filter((x) => x.date && x.v > 0);
    const u = unit || guessWeightUnit(raw.map((x) => x.v));
    const byDate = new Map();
    for (const x of raw) byDate.set(x.date, weightToKg(x.v, u)); /* last reading of a day wins */
    return {
      weights: [...byDate].map(([date, kg]) => ({ id: `w:${date}`, date, kg: Math.round(kg * 100) / 100, source: `import:${src}` })),
      unit: u, label,
    };
  }

  function fromCronometerServings(rows) {
    const entries = [];
    const seen = new Map();
    for (const r of rows) {
      const date = parseDate(r.Day);
      const kcal = num(r['Energy (kcal)']);
      if (!date || !kcal) continue;
      const name = r['Food Name'] || 'Food';
      const base = `imp:cron:${date}:${slug(name)}`;
      const n = (seen.get(base) || 0) + 1; seen.set(base, n);
      entries.push({
        id: n > 1 ? `${base}:${n}` : base, date, meal: mealOf(r.Group), name,
        kcal: Math.round(kcal), protein: r1(num(r['Protein (g)'])), carbs: r1(num(r['Carbs (g)'] ?? r['Net Carbs (g)'])), fat: r1(num(r['Fat (g)'])),
        qtyLabel: r.Amount || '', source: 'import:cronometer',
      });
    }
    return { entries, weights: [], notes: [] };
  }

  function fromCronometerBiometrics(rows) {
    const wr = rows.filter((r) => /weight/i.test(r.Metric));
    const byDate = new Map();
    for (const r of wr) {
      const date = parseDate(r.Day);
      const v = num(r.Amount);
      if (date && v > 0) byDate.set(date, weightToKg(v, r.Unit));
    }
    return { entries: [], weights: [...byDate].map(([date, kg]) => ({ id: `w:${date}`, date, kg: Math.round(kg * 100) / 100, source: 'import:cronometer' })), notes: [] };
  }

  function fromLoseIt(rows) {
    const order = dateOrderFor(rows.map((r) => r.Date));
    const entries = [];
    const seen = new Map();
    for (const r of rows) {
      if (/^true$/i.test(r.Deleted || '')) continue;
      if (/exercise/i.test(r.Type || '')) continue;
      const date = parseDate(r.Date, order || 'mdy');
      const kcal = num(r.Calories);
      if (!date || !kcal || kcal < 0) continue;
      const base = `imp:loseit:${date}:${slug(r.Name)}`;
      const n = (seen.get(base) || 0) + 1; seen.set(base, n);
      entries.push({
        id: n > 1 ? `${base}:${n}` : base, date, meal: mealOf(r.Type), name: r.Name || 'Food',
        kcal: Math.round(kcal), protein: r1(num(r['Protein (g)'])), carbs: r1(num(r['Carbohydrates (g)'])), fat: r1(num(r['Fat (g)'])),
        qtyLabel: [r.Quantity, r.Units].filter(Boolean).join(' '), source: 'import:loseit',
      });
    }
    return { entries, weights: [], notes: [] };
  }

  /* Generic: one row per day (or per item) with a date and calories/macros
     and/or weight. `map` overrides the guessed columns. */
  function fromGeneric(rows, headers, map = {}, opts = {}) {
    const cols = { ...guessColumns(headers), ...map };
    const out = { entries: [], weights: [], notes: [], columns: cols, headers };
    if (!cols.date) { out.notes.push('Couldn’t find a date column — pick one below.'); return out; }
    const order = opts.dateOrder || dateOrderFor(rows.map((r) => r[cols.date])) || 'dmy';
    const src = slug(opts.source || 'csv') || 'csv';
    if (cols.kcal) {
      const seen = new Map();
      for (const r of rows) {
        const date = parseDate(r[cols.date], order);
        const kcal = num(r[cols.kcal]);
        if (!date || !kcal || kcal <= 0) continue;
        const name = (cols.name && r[cols.name]) || 'Imported intake';
        const base = `imp:${src}:${date}:${slug(name)}:${cols.meal ? slug(r[cols.meal]) : 'day'}`;
        const n = (seen.get(base) || 0) + 1; seen.set(base, n);
        out.entries.push({
          id: n > 1 ? `${base}:${n}` : base, date, meal: cols.meal ? mealOf(r[cols.meal]) : 'snacks', name,
          kcal: Math.round(kcal),
          protein: r1(cols.protein ? num(r[cols.protein]) : 0), carbs: r1(cols.carbs ? num(r[cols.carbs]) : 0), fat: r1(cols.fat ? num(r[cols.fat]) : 0),
          source: `import:${src}`,
        });
      }
    }
    if (cols.weight) {
      const w = weightsFrom(rows, cols.date, cols.weight, opts.weightUnit, src);
      out.weights = w.weights; out.weightUnit = w.unit;
    }
    out.dateOrder = order;
    return out;
  }

  /* ── Apple Health export.xml ──
     Can be hundreds of MB, so it is scanned as a stream for the handful of
     record types we need instead of being parsed as a DOM. */
  const HK = {
    HKQuantityTypeIdentifierBodyMass: 'weight',
    HKQuantityTypeIdentifierDietaryEnergyConsumed: 'kcal',
    HKQuantityTypeIdentifierDietaryProtein: 'protein',
    HKQuantityTypeIdentifierDietaryCarbohydrates: 'carbs',
    HKQuantityTypeIdentifierDietaryFatTotal: 'fat',
  };
  const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? m[1] : null; };
  function scanAppleHealthChunk(text, acc) {
    const re = /<Record\b[^>]*?type="(HKQuantityTypeIdentifier(?:BodyMass|DietaryEnergyConsumed|DietaryProtein|DietaryCarbohydrates|DietaryFatTotal))"[^>]*>/g;
    let m, lastEnd = 0;
    while ((m = re.exec(text))) {
      lastEnd = re.lastIndex;
      const tag = m[0];
      const kind = HK[m[1]];
      const date = (attr(tag, 'startDate') || '').slice(0, 10);
      let v = Number(attr(tag, 'value'));
      if (!date || !Number.isFinite(v)) continue;
      const unit = attr(tag, 'unit') || '';
      if (kind === 'weight') { acc.weights.set(date, weightToKg(v, unit)); continue; }
      if (kind === 'kcal' && /kJ/i.test(unit)) v /= 4.184;
      const d = acc.days.get(date) || { kcal: 0, protein: 0, carbs: 0, fat: 0 };
      d[kind] += v;
      acc.days.set(date, d);
    }
    return lastEnd;
  }
  async function fromAppleHealth(readText, onProgress) {
    const acc = { weights: new Map(), days: new Map() };
    await readText((chunk) => scanAppleHealthChunk(chunk, acc), onProgress);
    return {
      entries: [...acc.days].filter(([, d]) => d.kcal > 0).map(([date, d]) => ({
        id: `imp:health:${date}`, date, meal: 'snacks', name: 'Apple Health intake',
        kcal: Math.round(d.kcal), protein: r1(d.protein), carbs: r1(d.carbs), fat: r1(d.fat), source: 'import:apple-health',
      })),
      weights: [...acc.weights].map(([date, kg]) => ({ id: `w:${date}`, date, kg: Math.round(kg * 100) / 100, source: 'import:apple-health' })),
      notes: ['Apple Health stores daily totals from other apps, so intake arrives as one entry per day.'],
    };
  }
  /* Streams a File/Blob (or string) through `scan` with overlap so a record
     split across a chunk boundary is never lost. */
  const streamText = (source) => async (scan, onProgress) => {
    if (typeof source === 'string') { scan(source); return; }
    const total = source.size || 0;
    const reader = source.stream().pipeThrough(new TextDecoderStream()).getReader();
    let carry = '', read = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      read += value.length;
      const text = carry + value;
      const consumed = scan(text);
      /* keep the unconsumed tail (at most one partial record) */
      carry = text.slice(Math.max(consumed, text.length - 4096));
      if (onProgress && total) onProgress(Math.min(0.99, read / total));
    }
    if (carry) scan(carry);
  };

  /* ── entry point ──
     files: Array of File/Blob with .name (or { name, text } objects in tests)
     Returns { sources: [{ name, kind, entries, weights, notes, … }] }. */
  async function analyse(files, opts = {}) {
    const sources = [];
    const csvs = [];
    for (const f of files) {
      const name = f.name || 'file';
      const lower = name.toLowerCase();
      if (lower.endsWith('.zip')) {
        const inner = await readZip(await f.arrayBuffer());
        const xml = inner.find((x) => /export\.xml$/i.test(x.name) && !/cda/i.test(x.name));
        if (xml) {
          const text = await xml.text();
          sources.push({ name: 'Apple Health', kind: 'apple-health', ...(await fromAppleHealth(streamText(text))) });
          continue;
        }
        for (const x of inner) if (/\.csv$/i.test(x.name)) csvs.push({ name: x.name.split('/').pop(), text: await x.text() });
      } else if (lower.endsWith('.xml')) {
        sources.push({ name: 'Apple Health', kind: 'apple-health', ...(await fromAppleHealth(streamText(f.text && !f.stream ? await f.text() : f), opts.onProgress)) });
      } else {
        csvs.push({ name, text: await f.text() });
      }
    }

    for (const c of csvs) {
      const { headers, rows } = parseCsv(c.text);
      if (!headers.length) continue;
      const kind = kindOfCsv(c.name, headers);
      if (kind === 'skip') continue;
      let res;
      if (kind === 'mfp-nutrition') res = { label: 'MyFitnessPal · food', ...fromMfpNutrition(rows) };
      else if (kind === 'mfp-measurement') {
        const w = weightsFrom(rows, 'Date', findCol(headers, /^weight$/i, /weight/i) || 'Weight', opts.weightUnit, 'mfp');
        res = { label: 'MyFitnessPal · weight', entries: [], weights: w.weights, weightUnit: w.unit,
                notes: ['MyFitnessPal doesn’t label the unit — check it below.'] };
      }
      else if (kind === 'cronometer-servings') res = { label: 'Cronometer · food', ...fromCronometerServings(rows) };
      else if (kind === 'cronometer-biometrics') res = { label: 'Cronometer · weight', ...fromCronometerBiometrics(rows) };
      else if (kind === 'cronometer-daily') res = { label: 'Cronometer · daily totals', ...fromGeneric(rows, headers, {}, { source: 'cronometer' }) };
      else if (kind === 'loseit-food') res = { label: 'Lose It! · food', ...fromLoseIt(rows) };
      else res = { label: c.name, ...fromGeneric(rows, headers, {}, { source: c.name.replace(/\.csv$/i, ''), weightUnit: opts.weightUnit }) };
      sources.push({ name: c.name, kind, rows, ...res });
    }

    /* Cronometer ships both per-food and daily-total files; importing both
       would double-count. Keep the detailed one. */
    if (sources.some((s) => s.kind === 'cronometer-servings')) {
      for (const s of sources) if (s.kind === 'cronometer-daily') { s.entries = []; s.notes = ['Skipped — the per-food file has the same data in more detail.']; }
    }
    return { sources };
  }

  /* Re-runs a generic/measurement source with user-corrected columns/units. */
  function reparse(source, { map, weightUnit, dateOrder } = {}) {
    if (source.kind === 'mfp-measurement') {
      const w = weightsFrom(source.rows, 'Date', findCol(source.headers || Object.keys(source.rows[0] || {}), /weight/i) || 'Weight', weightUnit, 'mfp');
      return { ...source, weights: w.weights, weightUnit: w.unit };
    }
    const headers = source.headers || Object.keys(source.rows[0] || {});
    return { ...source, ...fromGeneric(source.rows, headers, map, { source: source.name.replace(/\.csv$/i, ''), weightUnit, dateOrder }) };
  }

  return {
    parseCsv, readZip, parseDate, dateOrderFor, guessColumns, guessWeightUnit, weightToKg, num,
    kindOfCsv, fromMfpNutrition, fromCronometerServings, fromCronometerBiometrics, fromLoseIt, fromGeneric,
    scanAppleHealthChunk, fromAppleHealth, streamText, analyse, reparse,
  };
});
