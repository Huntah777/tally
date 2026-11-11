/* ============================================================
   Tally engine — the numbers behind the app.
   ------------------------------------------------------------
   Plain JS (no JSX, no DOM) so the same file runs in the page
   (window.TallyEngine) and in Node for tests (require()).

   Everything here is a pure function of the app state. Nothing calls a
   service: targets, trend, pace and the health guidance are all worked out
   on the device.

   Units: kilograms, centimetres, kcal, grams, ISO dates (YYYY-MM-DD, local).
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── constants ─────────────────────────────────────────────────────
     7,700 kcal per kg of body weight is the standard approximation
     (≈3,500 kcal/lb). Real tissue lost is a mix of fat, lean mass and water,
     so it's an estimate, which is why the adaptive TDEE below exists. */
  const KCAL_PER_KG = 7700;
  const ACTIVITY = {
    sedentary: { factor: 1.2,   label: 'Sedentary',         hint: 'Desk job, little exercise' },
    light:     { factor: 1.375, label: 'Lightly active',    hint: 'Walks, exercise 1–3×/week' },
    moderate:  { factor: 1.55,  label: 'Moderately active', hint: 'Exercise 3–5×/week' },
    active:    { factor: 1.725, label: 'Very active',       hint: 'Hard exercise 6–7×/week' },
    athlete:   { factor: 1.9,   label: 'Athlete',           hint: 'Physical job + training' },
  };
  /* Weekly pace presets, kg/week. */
  const PACES = [
    { id: 'gentle',     kg: 0.25, label: 'Gentle' },
    { id: 'steady',     kg: 0.5,  label: 'Steady' },
    { id: 'brisk',      kg: 0.75, label: 'Brisk' },
    { id: 'aggressive', kg: 1.0,  label: 'Aggressive' },
  ];
  /* Common calorie floors used by the NHS and dietitians: below these it is
     hard to meet nutrient needs without medical oversight. */
  const FLOOR = { female: 1200, male: 1500, other: 1350 };
  const VLCD = 800; /* very-low-calorie diet: medical supervision territory */
  const MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'];
  const TOMBSTONED = ['entries', 'weights', 'foods'];

  /* ── dates ─────────────────────────────────────────────────────── */
  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => isoOf(new Date());
  const parseIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (iso, n) => { const d = parseIso(iso); d.setDate(d.getDate() + n); return isoOf(d); };
  /* "29 April 2027" — for sentences; the UI formats its own labels. */
  const fmtDay = (iso) => parseIso(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  /* Calendar days from a to b, DST-proof (noon UTC on both sides). */
  const daysBetween = (a, b) => {
    const t = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d, 12); };
    return Math.round((t(b) - t(a)) / 86400000);
  };

  /* ── units ─────────────────────────────────────────────────────── */
  const LB_PER_KG = 2.2046226218;
  const kgTo = (kg, units) => {
    if (kg == null) return null;
    if (units === 'lb') return kg * LB_PER_KG;
    if (units === 'st') return kg * LB_PER_KG / 14;
    return kg;
  };
  const toKg = (v, units) => (units === 'lb' ? v / LB_PER_KG : units === 'st' ? (v * 14) / LB_PER_KG : v);
  /* Human string for a weight in the user's units: 82.4 kg / 181.6 lb / 12 st 13.6 lb */
  function fmtWeight(kg, units, { signed = false, digits = 1 } = {}) {
    if (kg == null || !isFinite(kg)) return '—';
    const sign = signed ? (kg > 0 ? '+' : kg < 0 ? '−' : '') : (kg < 0 ? '−' : '');
    const a = Math.abs(kg);
    if (units === 'st') {
      /* Round first, then split, or 13.97 lb would print as "14.0 lb". */
      const lb = Math.round(a * LB_PER_KG * 10) / 10;
      const st = Math.floor(lb / 14);
      const rem = lb - st * 14;
      return st ? `${sign}${st} st ${rem.toFixed(digits === 0 ? 0 : 1)} lb` : `${sign}${rem.toFixed(1)} lb`;
    }
    if (units === 'lb') return `${sign}${(a * LB_PER_KG).toFixed(digits)} lb`;
    return `${sign}${a.toFixed(digits)} kg`;
  }

  /* ── profile maths ─────────────────────────────────────────────── */
  function ageOn(profile, iso) {
    if (!profile?.birthYear) return profile?.age || 35;
    return Math.max(14, Number(iso.slice(0, 4)) - Number(profile.birthYear));
  }
  /* Mifflin–St Jeor, the most accurate of the common equations for
     non-athletes. 'other' sits between the two sex constants. */
  function bmr(profile, kg, iso = today()) {
    if (!profile?.heightCm || !kg) return null;
    const s = profile.sex === 'male' ? 5 : profile.sex === 'female' ? -161 : -78;
    return 10 * kg + 6.25 * profile.heightCm - 5 * ageOn(profile, iso) + s;
  }
  const formulaTdee = (profile, kg, iso) => {
    const b = bmr(profile, kg, iso);
    return b == null ? null : b * (ACTIVITY[profile.activity]?.factor || 1.375);
  };
  const bmiOf = (kg, heightCm) => (kg && heightCm ? kg / Math.pow(heightCm / 100, 2) : null);
  const healthyRangeKg = (heightCm) => {
    if (!heightCm) return null;
    const m2 = Math.pow(heightCm / 100, 2);
    return { min: 18.5 * m2, max: 24.9 * m2 };
  };
  const floorFor = (profile) => FLOOR[profile?.sex] || FLOOR.other;

  /* ── intake ────────────────────────────────────────────────────── */
  const live = (arr) => (arr || []).filter((x) => x && !x.deleted);

  function dayTotals(entries, iso) {
    const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, count: 0, byMeal: {} };
    for (const m of MEALS) t.byMeal[m] = { kcal: 0, protein: 0, carbs: 0, fat: 0, items: [] };
    for (const e of live(entries)) {
      if (e.date !== iso) continue;
      t.kcal += e.kcal || 0; t.protein += e.protein || 0; t.carbs += e.carbs || 0; t.fat += e.fat || 0; t.count++;
      const m = t.byMeal[e.meal] || t.byMeal.snacks;
      m.kcal += e.kcal || 0; m.protein += e.protein || 0; m.carbs += e.carbs || 0; m.fat += e.fat || 0;
      m.items.push(e);
    }
    return t;
  }

  /* date → totals for every day that has anything logged */
  function intakeByDay(entries) {
    const map = new Map();
    for (const e of live(entries)) {
      const d = map.get(e.date) || { kcal: 0, protein: 0, carbs: 0, fat: 0, count: 0 };
      d.kcal += e.kcal || 0; d.protein += e.protein || 0; d.carbs += e.carbs || 0; d.fat += e.fat || 0; d.count++;
      map.set(e.date, d);
    }
    return map;
  }

  /* For the adaptive TDEE a day counts as "logged" only if it looks
     complete-ish: days with a single coffee logged would drag the average
     down and make the estimate wildly optimistic. The safety checks use a
     much lower bar — someone genuinely eating 700 kcal a day must not be
     filtered out as "probably a partial log". */
  const MIN_LOGGED_KCAL = 800;
  const MIN_SAFETY_KCAL = 300;

  function intakeWindow(entries, endIso, days, minKcal = MIN_LOGGED_KCAL) {
    const by = intakeByDay(entries);
    let kcal = 0, protein = 0, n = 0;
    for (let i = 0; i < days; i++) {
      const d = by.get(addDays(endIso, -i));
      if (d && d.kcal >= minKcal) { kcal += d.kcal; protein += d.protein; n++; }
    }
    return { days: n, avgKcal: n ? kcal / n : null, avgProtein: n ? protein / n : null };
  }

  /* ── weight ───────────────────────────────────────────────────── */
  const sortedWeights = (weights) =>
    live(weights).filter((w) => w.kg > 0 && w.date).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  /* Smoothed trend weight. Plain exponential smoothing (the "Hacker's Diet"
     10% rule) always lags a steady loss by a week or more, so the line sits
     above every reading and understates progress. This is Holt's linear
     smoothing instead: it tracks a level and a daily slope, so a steady
     downward drift is followed without lag while a single salty dinner still
     barely moves it. Days without a reading extend the line along the slope.
     The slope is clamped so a couple of wild early readings can't send it
     off a cliff. */
  const TREND_ALPHA = 0.15;   /* level responsiveness */
  const TREND_BETA  = 0.05;   /* slope responsiveness */
  const MAX_SLOPE   = 0.3;    /* kg/day, ≈2 kg/week either way */
  function trendSeries(weights) {
    const ws = sortedWeights(weights);
    if (!ws.length) return [];
    const byDate = new Map(ws.map((w) => [w.date, w.kg]));
    const out = [];
    /* Seed the level from the first few readings, not just the first, so
       one unusual first weigh-in doesn't skew the start of the line. */
    const seed = ws.slice(0, 3).map((w) => w.kg).sort((a, b) => a - b)[Math.min(1, ws.length - 1)];
    let level = seed, slope = 0;
    const last = ws[ws.length - 1].date;
    for (let d = ws[0].date; d <= last; d = addDays(d, 1)) {
      const kg = byDate.has(d) ? byDate.get(d) : null;
      const predicted = level + slope;
      if (kg != null) {
        const nextLevel = predicted + TREND_ALPHA * (kg - predicted);
        slope = slope + TREND_BETA * (nextLevel - level - slope);
        slope = Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, slope));
        level = nextLevel;
      } else {
        /* Damp the slope through gaps so a fortnight without weighing in
           doesn't extrapolate a straight line off the chart. */
        level = predicted;
        slope *= 0.95;
      }
      out.push({ date: d, kg, trend: level });
    }
    return out;
  }

  /* Least-squares slope of raw weigh-ins in the window ending at endIso.
     Uses raw readings, not the EWMA, because the smoothed line lags by about
     a week and would understate a genuinely fast loss. */
  function weightRate(weights, endIso, windowDays = 28) {
    const start = addDays(endIso, -windowDays + 1);
    const pts = sortedWeights(weights).filter((w) => w.date >= start && w.date <= endIso);
    if (pts.length < 4) return null;
    const span = daysBetween(pts[0].date, pts[pts.length - 1].date);
    if (span < 10) return null;
    const xs = pts.map((p) => daysBetween(start, p.date));
    const ys = pts.map((p) => p.kg);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    if (!den) return null;
    const perDay = num / den;
    return { kgPerDay: perDay, kgPerWeek: perDay * 7, points: pts.length, spanDays: span, from: pts[0].date, to: pts[pts.length - 1].date };
  }

  function currentWeight(state) {
    const tr = trendSeries(state.weights);
    if (tr.length) return tr[tr.length - 1].trend;
    return state.profile?.startKg || null;
  }

  /* ── adaptive TDEE ─────────────────────────────────────────────
     Formulas are typically off by ±10–15% for any one person. Once there are
     a few weeks of food logs and weigh-ins, the body itself tells us its
     maintenance: average intake plus the energy implied by the weight change.
     It is blended in gradually as the evidence builds, never trusted alone
     on thin data, and clamped to a sane range against bad logs. */
  function adaptiveTdee(state, asOf = today()) {
    const kg = currentWeight(state);
    const formula = formulaTdee(state.profile, kg, asOf);
    const intake = intakeWindow(state.entries, asOf, 28);
    const rate = weightRate(state.weights, asOf, 28);
    if (!intake.days || intake.days < 14 || !rate || rate.points < 6) {
      return { tdee: formula, formula, observed: null, weight: 0, loggedDays: intake.days };
    }
    let observed = intake.avgKcal - rate.kgPerDay * KCAL_PER_KG;
    observed = Math.min(5000, Math.max(1000, observed));
    if (formula == null) return { tdee: observed, formula, observed, weight: 1, loggedDays: intake.days };
    const w = Math.min(0.8, intake.days / 28);
    return { tdee: formula * (1 - w) + observed * w, formula, observed, weight: w, loggedDays: intake.days };
  }

  /* ── targets ───────────────────────────────────────────────────── */
  function targets(state, asOf = today()) {
    const p = state.profile || {};
    const kg = currentWeight(state);
    const est = adaptiveTdee(state, asOf);
    const tdee = est.tdee;
    const pace = Number(p.paceKg ?? 0.5);
    const floor = floorFor(p);
    const atGoal = p.goalKg && kg && kg <= p.goalKg;
    const wantedDeficit = atGoal ? 0 : (pace * KCAL_PER_KG) / 7;

    let kcal = tdee ? Math.round(tdee - wantedDeficit) : 2000;
    let floorApplied = false;
    if (kcal < floor) { kcal = floor; floorApplied = true; }
    const deficit = tdee ? tdee - kcal : null;
    const effectivePace = deficit != null ? (deficit * 7) / KCAL_PER_KG : null;

    /* Protein: ~1.6 g/kg is the level that best protects muscle during a
       deficit. Based on goal weight for people with a lot to lose, where
       body-weight protein targets become unrealistically high. */
    const proteinBasis = p.goalKg && kg ? Math.min(kg, Math.max(p.goalKg, kg * 0.8)) : kg || 70;
    let protein = Math.round((p.proteinPerKg || 1.6) * proteinBasis);
    let fat = Math.round(Math.max((kcal * 0.27) / 9, 0.6 * proteinBasis));
    let carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));

    const o = p.override || {};
    if (o.kcal) kcal = Math.round(o.kcal);
    if (o.protein) protein = Math.round(o.protein);
    if (o.fat) fat = Math.round(o.fat);
    if (o.carbs) carbs = Math.round(o.carbs);
    else if (o.kcal || o.protein || o.fat) carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));

    return {
      kcal, protein, carbs, fat, tdee, est, floor, floorApplied, kg,
      deficit: tdee ? tdee - kcal : null,
      deficitPct: tdee ? (tdee - kcal) / tdee : null,
      plannedPaceKg: o.kcal && tdee ? ((tdee - kcal) * 7) / KCAL_PER_KG : effectivePace,
      atGoal: !!atGoal,
    };
  }

  /* Weeks to goal at a pace, and the resulting date. */
  function projection(kg, goalKg, kgPerWeek, fromIso = today()) {
    if (!kg || !goalKg || !kgPerWeek || kgPerWeek <= 0 || kg <= goalKg) return null;
    const weeks = (kg - goalKg) / kgPerWeek;
    if (weeks > 520) return null;
    return { weeks, date: addDays(fromIso, Math.round(weeks * 7)) };
  }

  /* ── insights ─────────────────────────────────────────────────────
     Rule-based health guidance. Each rule is grounded in mainstream advice
     (NHS, NICE, NIDDK): a safe sustained loss is about 0.5–1 kg (1–2 lb) a
     week, roughly ≤1% of body weight; faster than ~1.5 kg a week raises
     gallstone risk and accelerates muscle loss; the first fortnight is
     mostly water. Levels: danger > warn > info > good. */
  const LEVEL_ORDER = { danger: 0, warn: 1, info: 2, good: 3 };

  function insights(state, asOf = today()) {
    const out = [];
    const p = state.profile || {};
    const units = p.units || 'kg';
    const W = (kg, o) => fmtWeight(kg, units, o);
    const t = targets(state, asOf);
    const kg = t.kg;
    const goal = p.goalKg;
    const bmi = bmiOf(kg, p.heightCm);
    const range = healthyRangeKg(p.heightCm);
    const rate = weightRate(state.weights, asOf, 28);
    const ws = sortedWeights(state.weights);
    const daysTracked = ws.length ? daysBetween(ws[0].date, asOf) : 0;
    const week = intakeWindow(state.entries, asOf, 7, MIN_SAFETY_KCAL);
    const lossPerWeek = rate ? -rate.kgPerWeek : null;   /* positive = losing */
    const pctPerWeek = rate && kg ? (lossPerWeek / kg) * 100 : null;
    const kcalAdj = (kgPerWeek) => Math.round(((kgPerWeek * KCAL_PER_KG) / 7) / 10) * 10;

    if (!kg || !p.heightCm) {
      out.push({ id: 'setup', level: 'info', title: 'Finish your profile',
        body: 'Add your height, weight and goal so Tally can work out your targets and keep an eye on your pace.' });
      return out;
    }

    /* 1. BMI guard rails */
    if (bmi != null && bmi < 18.5) {
      out.push({ id: 'underweight', level: 'danger', title: 'You’re already below a healthy weight',
        body: `Your BMI is about ${bmi.toFixed(1)}. Losing more isn’t recommended — consider switching your goal to maintenance and speaking to your GP.`,
        facts: ['A BMI under 18.5 is linked to weaker immunity, bone loss and fatigue.',
                'If you feel pressure to keep losing weight, Beat (UK eating-disorder charity) has a free helpline.'] });
    }
    if (goal && range && goal < range.min) {
      out.push({ id: 'goal-low', level: 'danger', title: 'Your goal is below a healthy weight',
        body: `For your height a healthy BMI range is roughly ${W(range.min)} – ${W(range.max)}. Your goal of ${W(goal)} is under that.`,
        facts: ['BMI isn’t perfect (it ignores muscle), but goals under 18.5 are a red flag for most adults.'] });
    }

    /* 2. Pace */
    const SAFE_PCT = 1.0;
    if (!rate) {
      out.push({ id: 'need-data', level: 'info', title: 'Pace check unlocks soon',
        body: 'Weigh in 3–4 times a week, ideally first thing in the morning. After about two weeks Tally can tell you whether your pace is healthy.',
        facts: ['Day-to-day weight swings of 0.5–1.5 kg are normal — water, salt, carbs and digestion all move the scale.'] });
    } else if (daysTracked < 21 && (lossPerWeek > 1 || pctPerWeek > SAFE_PCT)) {
      out.push({ id: 'water', level: 'info', title: 'That fast early drop is mostly water',
        body: `You’re down about ${W(lossPerWeek)} a week so far. In the first one to two weeks of a deficit that’s normal — judge your pace from week three onwards.`,
        facts: ['Your body stores carbohydrate as glycogen, and each gram holds about 3 g of water. Eating less releases it quickly.',
                'Expect the rate to settle closer to your planned pace.'] });
    } else if (lossPerWeek > 1.5 || pctPerWeek > 1.5) {
      const safe = Math.min(1, (kg * SAFE_PCT) / 100);
      out.push({ id: 'too-fast', level: 'danger', title: 'You’re losing weight too quickly',
        body: `Your trend is ${W(lossPerWeek)} a week (${pctPerWeek.toFixed(1)}% of your body weight). Eating about ${kcalAdj(lossPerWeek - safe)} kcal more a day would bring you to a safer ${W(safe)} a week.`,
        facts: ['Losing more than about 1.5 kg (3 lb) a week for several weeks raises the risk of gallstones.',
                'Very fast loss takes more muscle with it, which slows your metabolism and makes regain more likely.',
                'Fatigue, dizziness, feeling cold, hair thinning and irritability are common signs you’re under-eating.',
                'The NHS recommends 0.5–1 kg (1–2 lb) a week for sustainable weight loss.'],
        action: { kind: 'raise-kcal', kcal: kcalAdj(lossPerWeek - safe) } });
    } else if (lossPerWeek > 1.0 || pctPerWeek > SAFE_PCT) {
      const safe = Math.min(1, (kg * SAFE_PCT) / 100);
      out.push({ id: 'fast', level: 'warn', title: 'A little faster than recommended',
        body: `You’re losing ${W(lossPerWeek)} a week (${pctPerWeek.toFixed(1)}% of body weight). Around ${W(safe)} a week is the sustainable upper limit for you — roughly ${kcalAdj(lossPerWeek - safe)} kcal more a day.`,
        facts: ['Keeping protein high (about 1.6 g per kg) and doing resistance training 2–3× a week helps you hold on to muscle.',
                'Faster loss often means more hunger and a harder time sticking with it.'],
        action: { kind: 'raise-kcal', kcal: kcalAdj(lossPerWeek - safe) } });
    } else if (Math.abs(lossPerWeek) < 0.1 && rate.spanDays >= 18 && (p.paceKg ?? 0.5) > 0 && !t.atGoal) {
      const est = t.est;
      out.push({ id: 'plateau', level: 'info', title: 'Your weight has levelled off',
        body: est.observed
          ? `Your trend has barely moved in ${rate.spanDays} days. Based on what you’ve logged, your real maintenance looks closer to ${Math.round(est.observed)} kcal than the ${Math.round(est.formula)} kcal estimate. Tally has already adjusted your target.`
          : `Your trend has barely moved in ${rate.spanDays} days. Before cutting calories, check what you’re logging.`,
        facts: ['Most people under-report intake by 20–40% without realising it. Cooking oils, drinks, sauces and “bites” add up.',
                'Starting a new workout, eating more salt or the menstrual cycle can hold 1–2 kg of water for a few weeks and hide fat loss.',
                'Weigh yourself at the same time each day (after the toilet, before eating) for the cleanest trend.'] });
    } else if (lossPerWeek < -0.15 && (p.paceKg ?? 0.5) > 0) {
      out.push({ id: 'gaining', level: 'info', title: 'Your trend is creeping up',
        body: `You’re up about ${W(-lossPerWeek)} a week over the last ${rate.spanDays} days.`,
        facts: ['Weekends are the usual culprit — a few big days can cancel out a week of deficit.',
                'Water retention from new training or a salty meal can last several days; watch the trend line, not single readings.'] });
    } else if (lossPerWeek >= 0.1) {
      const canSpeed =
        daysTracked >= 21 && pctPerWeek < 0.35 && lossPerWeek < 0.45 && bmi >= 25 &&
        !t.floorApplied && (t.deficitPct == null || t.deficitPct < 0.2) && t.kcal - 200 >= t.floor;
      if (canSpeed) {
        const extra = Math.min(250, t.kcal - t.floor);
        const newPace = lossPerWeek + (extra * 7) / KCAL_PER_KG;
        const now = projection(kg, goal, lossPerWeek, asOf);
        const faster = projection(kg, goal, newPace, asOf);
        out.push({ id: 'speed-up', level: 'good', title: 'You’ve room to speed things up',
          body: `You’re losing a steady ${W(lossPerWeek)} a week (${pctPerWeek.toFixed(2)}%). Healthy loss for you could be up to ${W(Math.min(1, kg / 100))} a week, so there’s room to go a bit faster if you want to.`,
          facts: [
            `Option A: eat ~${extra} kcal less a day (target ${t.kcal - extra} kcal) → about ${W(newPace)} a week${faster && now ? `, reaching your goal around ${fmtDay(faster.date)} instead of ${fmtDay(now.date)}` : ''}.`,
            'Option B: add ~3,000 steps a day (about 25–30 minutes of walking) for roughly 100–150 kcal without eating less.',
            'Either way, keep protein high so the extra loss comes from fat.',
          ],
          action: { kind: 'lower-kcal', kcal: extra } });
      } else {
        const proj = projection(kg, goal, lossPerWeek, asOf);
        out.push({ id: 'on-track', level: 'good', title: 'Right on a healthy pace',
          body: `You’re losing ${W(lossPerWeek)} a week (${pctPerWeek.toFixed(1)}% of body weight).${proj ? ` At this rate you’ll reach ${W(goal)} around ${fmtDay(proj.date)}.` : ''}`,
          facts: ['Slow and steady keeps more muscle and makes it far more likely the weight stays off.'] });
      }
    }

    /* 3. Intake floor */
    if (week.days >= 4 && week.avgKcal < VLCD) {
      out.push({ id: 'vlcd', level: 'danger', title: `You’re averaging under ${VLCD} kcal a day`,
        body: `Your average over the last ${week.days} logged days is ${Math.round(week.avgKcal)} kcal. Diets this low should only be done with medical supervision.`,
        facts: ['Very low intakes risk gallstones, muscle loss, nutrient deficiencies and heart-rhythm problems.'] });
    } else if (week.days >= 4 && week.avgKcal < t.floor - 50) {
      out.push({ id: 'below-floor', level: 'warn', title: `Eating below ${t.floor} kcal`,
        body: `You’re averaging ${Math.round(week.avgKcal)} kcal over your last ${week.days} logged days. Below ${t.floor} kcal it’s hard to get enough protein, fibre, vitamins and minerals.`,
        facts: ['Undereating tends to backfire: more hunger, lower energy for daily movement and a higher chance of bingeing.'],
        action: { kind: 'raise-kcal', kcal: Math.round(t.floor - week.avgKcal) } });
    }

    /* 4. Planned deficit is steep */
    if (t.deficitPct != null && t.deficitPct > 0.25 && !t.floorApplied) {
      out.push({ id: 'steep-plan', level: 'warn', title: 'Your plan is a steep deficit',
        body: `Your target is ${Math.round(t.deficitPct * 100)}% below your maintenance (${Math.round(t.tdee)} kcal). Most people do better with 15–25%.`,
        facts: ['Choose a gentler pace in Me → Goal if you’re feeling run down or very hungry.'] });
    }
    if (t.floorApplied && !t.atGoal) {
      out.push({ id: 'floor', level: 'info', title: `Target held at ${t.floor} kcal`,
        body: `Your chosen pace would put you below ${t.floor} kcal, so Tally keeps your target there. You’ll lose about ${W(Math.max(0, t.plannedPaceKg))} a week instead.`,
        facts: ['Moving more is a safer way to widen the gap than eating less than this.'] });
    }

    /* 5. Protein */
    if (week.days >= 4 && week.avgProtein != null && kg) {
      const basis = goal ? Math.min(kg, Math.max(goal, kg * 0.8)) : kg;
      const perKg = week.avgProtein / basis;
      if (perKg < 1.2) {
        out.push({ id: 'protein', level: 'info', title: 'Protein is on the low side',
          body: `You’re averaging ${Math.round(week.avgProtein)} g a day, about ${perKg.toFixed(1)} g per kg. Aim for around ${Math.round(1.6 * basis)} g.`,
          facts: ['Protein keeps you fuller for longer and helps you keep muscle while you lose fat.',
                  'Easy wins: Greek yoghurt, eggs, chicken, tinned tuna, lentils, tofu, skyr or cottage cheese.'] });
      }
    }

    /* 6. Maintenance discovered */
    if (t.est.observed && t.est.formula && Math.abs(t.est.observed - t.est.formula) > 200 && !out.some((x) => x.id === 'plateau')) {
      out.push({ id: 'adaptive', level: 'info', title: `Your maintenance looks like ~${Math.round(t.est.observed)} kcal`,
        body: `From ${t.est.loggedDays} days of logs and your weight trend, your body burns about ${Math.round(t.est.observed)} kcal a day (the formula guessed ${Math.round(t.est.formula)}). Tally is gradually adjusting your target to match.`,
        facts: ['Formulas can be off by 10–15% for any one person. Your own data beats them once there’s enough of it.'] });
    }

    if (goal && kg && kg <= goal) {
      out.push({ id: 'goal-hit', level: 'good', title: 'You’ve reached your goal 🎉',
        body: 'Your target is now set to maintenance. Raise calories gradually (100–200 kcal a week) to find your new balance.' });
    }

    return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  }

  /* ── foods ─────────────────────────────────────────────────────── */
  /* Scales a per-100 g/ml food to a portion. */
  function portion(food, grams) {
    const f = grams / 100;
    const p = food.per100 || {};
    return {
      kcal: Math.round((p.kcal || 0) * f),
      protein: Math.round((p.protein || 0) * f * 10) / 10,
      carbs: Math.round((p.carbs || 0) * f * 10) / 10,
      fat: Math.round((p.fat || 0) * f * 10) / 10,
    };
  }

  /* ── merge (client side, mirrors functions/api/state.js) ───────── */
  const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
  const stampOf = (it) => Number(it?.updated ?? it?.created ?? 0) || 0;
  function mergeById(localItems, remoteItems, localTombs, remoteTombs, now = Date.now()) {
    const winners = new Map();
    const consider = (id, ts, kind, value) => {
      if (id == null) return;
      const cur = winners.get(id);
      if (!cur || ts >= cur.ts) winners.set(id, { ts, kind, value });
    };
    (remoteItems || []).forEach((it) => consider(it?.id, stampOf(it), 'item', it));
    (localItems || []).forEach((it) => consider(it?.id, stampOf(it), 'item', it));
    (remoteTombs || []).forEach((t) => consider(t?.id, Number(t?.deletedAt) || 0, 'tomb', t));
    (localTombs || []).forEach((t) => consider(t?.id, Number(t?.deletedAt) || 0, 'tomb', t));
    const items = [], tombstones = [];
    for (const w of winners.values()) {
      if (w.kind === 'item') items.push(w.value);
      else if (now - (Number(w.value.deletedAt) || 0) <= TOMBSTONE_TTL_MS) tombstones.push(w.value);
    }
    return { items, tombstones };
  }
  function mergeState(local, remote) {
    const out = { ...(local || {}), ...(remote || {}) };
    for (const key of TOMBSTONED) {
      const tKey = key + 'Deleted';
      const { items, tombstones } = mergeById(local?.[key], remote?.[key], local?.[tKey], remote?.[tKey]);
      out[key] = items; out[tKey] = tombstones;
    }
    const lp = local?.profile, rp = remote?.profile;
    if (lp || rp) out.profile = Number(lp?.updated || 0) > Number(rp?.updated || 0) ? lp : rp;
    out.aliases = { ...(remote?.aliases || {}), ...(local?.aliases || {}) };
    out.ui = { ...(remote?.ui || {}), ...(local?.ui || {}) };
    return out;
  }

  return {
    KCAL_PER_KG, ACTIVITY, PACES, FLOOR, VLCD, MEALS, TOMBSTONED,
    today, addDays, daysBetween, parseIso, isoOf, fmtDay,
    LB_PER_KG, kgTo, toKg, fmtWeight,
    bmr, formulaTdee, bmiOf, healthyRangeKg, floorFor, ageOn,
    dayTotals, intakeByDay, intakeWindow,
    sortedWeights, trendSeries, weightRate, currentWeight, adaptiveTdee,
    targets, projection, insights, portion,
    mergeById, mergeState,
  };
});
