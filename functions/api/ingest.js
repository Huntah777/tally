/* ============================================================
   Tally — POST /api/ingest   (Apple Health, via an iOS Shortcut)
   ------------------------------------------------------------
   A web app can't read HealthKit — only native apps can. Shortcuts can,
   and can run on a schedule, so a personal automation posts the day's
   numbers here each evening:

     Authorization: Bearer tly_…            (a sync key from Me → Apple Health)
     { "date": "2026-11-11",                 yyyy-MM-dd (defaults to today, UTC)
       "activeKcal": 612,                    Active Energy, summed for the day
       "steps": 9412,
       "weight": "126.4 kg",                 latest Body Mass
       "bodyFat": "35.6%" }                  latest Body Fat Percentage

   Every field is optional. Values may arrive the way Shortcuts formats them
   ("126.4 kg", "35.6%", "0.356", "278 lb", or a list to be summed), so
   they're parsed leniently and range-checked.

   Re-running for the same day replaces that day's numbers rather than
   adding to them, so the automation can run as often as you like.
   ============================================================ */
import { json, sha256hex } from '../_lib/auth.js';
import { writeMerged } from '../_lib/state.js';

const MAX_BODY = 16_384;

/* "126.4 kg" → 126.4 ; [300, 212] → 512 ; "1,234" → 1234 */
function numberIn(v, { sum = false } = {}) {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) {
    const ns = v.map((x) => numberIn(x)).filter((x) => x != null);
    if (!ns.length) return null;
    return sum ? ns.reduce((a, b) => a + b, 0) : ns[ns.length - 1];
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/(\d),(\d{3})\b/g, '$1$2').replace(',', '.');
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function weightKg(v) {
  const n = numberIn(v);
  if (n == null) return null;
  const s = String(Array.isArray(v) ? v[v.length - 1] : v).toLowerCase();
  if (/\blb|pound/.test(s)) return n / 2.2046226218;
  if (/\bst\b|stone/.test(s)) return n * 6.35029318;
  return n;
}

const inRange = (n, lo, hi) => (n != null && n >= lo && n <= hi ? n : null);
const pick = (b, ...keys) => { for (const k of keys) if (b[k] != null && b[k] !== '') return b[k]; return null; };

export async function onRequestPost({ request, env }) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token.startsWith('tly_')) return json({ error: 'Missing sync key. Add the header Authorization: Bearer <your key>.' }, 401);
  const hash = await sha256hex(token);
  const row = await env.DB.prepare('SELECT user_id FROM api_tokens WHERE token_hash = ?').bind(hash).first();
  if (!row) return json({ error: 'That sync key isn’t valid any more. Make a new one in Tally → Me → Apple Health.' }, 401);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'Payload too large' }, 413);
  let b;
  try { b = JSON.parse(raw || '{}'); } catch { return json({ error: 'Body must be JSON — use “Request Body: JSON” in the Shortcut.' }, 400); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return json({ error: 'Body must be a JSON object' }, 400);

  let date = String(pick(b, 'date', 'day') || '').trim().slice(0, 10);
  if (!date) date = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'date must look like 2026-11-11 (Format Date → Custom → yyyy-MM-dd)' }, 400);

  const activeKcal = inRange(numberIn(pick(b, 'activeKcal', 'active', 'activeEnergy'), { sum: true }), 0, 8000);
  const steps = inRange(numberIn(pick(b, 'steps', 'stepCount'), { sum: true }), 0, 150000);
  const kg = inRange(weightKg(pick(b, 'weight', 'weightKg', 'bodyMass')), 25, 400);
  let fat = numberIn(pick(b, 'bodyFat', 'bodyFatPct', 'fat'));
  if (fat != null && fat > 0 && fat <= 1) fat *= 100;          /* HealthKit stores 0.356 */
  fat = inRange(fat, 2, 75);

  if (activeKcal == null && steps == null && kg == null && fat == null) {
    return json({ error: 'Nothing to save. Send at least one of activeKcal, steps, weight or bodyFat.' }, 400);
  }

  const now = Date.now();
  const round1 = (n) => Math.round(n * 10) / 10;
  let fatUnattached = false;
  const r = await writeMerged(env, row.user_id, (existing) => {
    const out = {};
    if (activeKcal != null || steps != null) {
      const prev = (existing.exercise || []).find((x) => x.id === 'health:' + date);
      out.exercise = [{
        ...(prev || {}), id: 'health:' + date, date, kind: 'health', name: 'Apple Health',
        ...(activeKcal != null ? { activeKcal: Math.round(activeKcal) } : {}),
        ...(steps != null ? { steps: Math.round(steps) } : {}),
        created: prev?.created || now, updated: now,
      }];
    }
    if (kg != null || fat != null) {
      /* Body fat with no weight that day goes on the latest weigh-in from the
         past week instead. (Never onto the profile: the app rewrites that
         whole object, so a write here could undo an edit made on the phone.) */
      const ws = existing.weights || [];
      const sameDay = ws.find((w) => w.id === 'w:' + date);
      const recent = kg == null && !sameDay
        ? ws.filter((w) => w.date <= date && w.date >= isoMinusDays(date, 7) && w.kg > 0).sort((a, b) => (a.date < b.date ? 1 : -1))[0]
        : null;
      const prev = sameDay || recent || null;
      const id = prev?.id || 'w:' + date;
      /* A weigh-in typed into Tally that day wins over Health's weight, but
         body fat is still attached to it. */
      const keepManual = prev && !String(prev.source || '').startsWith('apple-health');
      if (kg != null || prev) {
        out.weights = [{
          ...(prev || {}), id, date: prev?.date || date,
          kg: keepManual || kg == null ? prev.kg : Math.round(kg * 100) / 100,
          ...(fat != null ? { fatPct: round1(fat) } : {}),
          source: keepManual ? prev.source : 'apple-health',
          created: prev?.created || now, updated: now,
        }];
      } else {
        fatUnattached = true;
      }
    }
    return out;
  });
  if (!r.ok) return json({ error: r.error }, r.status);

  await env.DB.prepare('UPDATE api_tokens SET last_used = ? WHERE token_hash = ?').bind(now, hash).run();
  return json({
    ok: true, date,
    saved: { activeKcal: activeKcal == null ? null : Math.round(activeKcal), steps, weightKg: kg == null ? null : round1(kg), bodyFatPct: fat == null || fatUnattached ? null : round1(fat) },
    ...(fatUnattached ? { note: 'Body fat skipped: no weigh-in in the last 7 days to attach it to.' } : {}),
  });
}

function isoMinusDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
