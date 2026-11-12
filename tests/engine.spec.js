import { test, expect } from '@playwright/test';
const E = require('../lib/engine.js');

const T = '2026-11-11';
const profile = { sex: 'male', birthYear: 1990, heightCm: 178, activity: 'light', paceKg: 0.5, goalKg: 80, units: 'kg', done: true, updated: 1 };

/* Weigh-ins every other day for `days`, losing `perWeek` kg/week from `start`. */
function series(start, perWeek, days = 42, end = T) {
  const out = [];
  for (let i = days; i >= 0; i -= 2) {
    const d = E.addDays(end, -i);
    out.push({ id: 'w:' + d, date: d, kg: +(start - ((days - i) / 7) * perWeek).toFixed(2) });
  }
  return out;
}
function intake(kcal, days = 28, protein = 140, end = T) {
  return Array.from({ length: days }, (_, i) => ({ id: 'e' + i, date: E.addDays(end, -i), meal: 'dinner', kcal, protein, carbs: 150, fat: 60 }));
}
const ids = (s) => E.insights(s, T).map((i) => i.id);

test.describe('maths', () => {
  test('Mifflin–St Jeor BMR', () => {
    // 10*90 + 6.25*178 - 5*36 + 5 = 1837.5
    expect(E.bmr(profile, 90, T)).toBeCloseTo(1837.5, 1);
    expect(E.bmr({ ...profile, sex: 'female' }, 90, T)).toBeCloseTo(1671.5, 1);
  });

  test('targets: 0.5 kg/week is a ~550 kcal deficit, with the calorie floor respected', () => {
    const s = { profile, weights: [{ id: 'w', date: T, kg: 90 }], entries: [] };
    const t = E.targets(s, T);
    expect(Math.round(t.tdee - t.kcal)).toBeGreaterThanOrEqual(549);
    expect(Math.round(t.tdee - t.kcal)).toBeLessThanOrEqual(551);
    const tiny = { profile: { ...profile, sex: 'female', heightCm: 150, birthYear: 1950, activity: 'sedentary', paceKg: 1 }, weights: [{ id: 'w', date: T, kg: 55 }] };
    const tt = E.targets(tiny, T);
    expect(tt.kcal).toBe(1200);
    expect(tt.floorApplied).toBe(true);
  });

  test('macros add up to the calorie target', () => {
    const t = E.targets({ profile, weights: [{ id: 'w', date: T, kg: 90 }] }, T);
    expect(Math.abs(t.protein * 4 + t.carbs * 4 + t.fat * 9 - t.kcal)).toBeLessThan(6);
  });

  test('trend follows a steady loss without lagging behind it', () => {
    const ws = series(95, 0.7, 42);
    const tr = E.trendSeries(ws);
    const last = tr[tr.length - 1];
    expect(Math.abs(last.trend - ws[ws.length - 1].kg)).toBeLessThan(0.6);
  });

  test('weight rate by regression', () => {
    const r = E.weightRate(series(95, 0.8, 28), T, 28);
    expect(r.kgPerWeek).toBeCloseTo(-0.8, 2);
  });

  test('adaptive TDEE discovers real maintenance from logs + weight', () => {
    // eating 2000 and losing 0.5 kg/wk ⇒ maintenance ≈ 2000 + 550
    const s = { profile, weights: series(92, 0.5, 28), entries: intake(2000) };
    const est = E.adaptiveTdee(s, T);
    expect(est.observed).toBeGreaterThan(2450);
    expect(est.observed).toBeLessThan(2650);
  });

  test('stone formatting', () => {
    expect(E.fmtWeight(95.25, 'st')).toBe('15 st 0.0 lb');
    expect(E.fmtWeight(E.toKg(12.5, 'st'), 'st')).toBe('12 st 7.0 lb');
  });
});

test.describe('insights', () => {
  test('too fast after the first three weeks → danger with a calorie suggestion', () => {
    const s = { profile, weights: series(100, 1.8, 42), entries: intake(1500) };
    const tooFast = E.insights(s, T).find((i) => i.id === 'too-fast');
    expect(tooFast.level).toBe('danger');
    expect(tooFast.action.kcal).toBeGreaterThan(0);
  });

  test('fast loss in the first fortnight is explained as water, not alarmed about', () => {
    const s = { profile, weights: series(100, 2, 12), entries: [] };
    expect(ids(s)).toContain('water');
    expect(ids(s)).not.toContain('too-fast');
  });

  test('slow but healthy with headroom → suggests speeding up', () => {
    const s = { profile: { ...profile, paceKg: 0.25, goalKg: 75 }, weights: series(100, 0.25, 42), entries: intake(2600) };
    const i = E.insights(s, T).find((x) => x.id === 'speed-up');
    expect(i).toBeTruthy();
    expect(i.level).toBe('good');
    expect(i.action.kind).toBe('lower-kcal');
  });

  test('no speed-up advice for someone already in a healthy BMI', () => {
    const s = { profile: { ...profile, heightCm: 185, paceKg: 0.25, goalKg: 70 }, weights: series(80, 0.2, 42), entries: intake(2400) };
    expect(ids(s)).not.toContain('speed-up');
  });

  test('eating under 800 kcal → danger', () => {
    const s = { profile, weights: series(90, 0.5, 28), entries: intake(700, 7) };
    expect(ids(s)).toContain('vlcd');
  });

  test('goal below a healthy BMI → danger', () => {
    const s = { profile: { ...profile, goalKg: 50 }, weights: [{ id: 'w', date: T, kg: 70 }] };
    expect(E.insights(s, T)[0].id).toBe('goal-low');
  });

  test('plateau is explained, not punished', () => {
    const s = { profile, weights: series(90, 0, 28), entries: intake(1900) };
    expect(ids(s)).toContain('plateau');
  });
});

test('client merge mirrors the server: newer tombstone wins, newer edit undeletes', () => {
  const local = { entries: [{ id: 'a', kcal: 1, updated: 10 }], entriesDeleted: [{ id: 'b', deletedAt: 30 }] };
  const remote = { entries: [{ id: 'a', kcal: 2, updated: 20 }, { id: 'b', kcal: 3, updated: 20 }, { id: 'c', updated: 40 }], entriesDeleted: [{ id: 'c', deletedAt: 35 }] };
  const m = E.mergeState(local, remote);
  expect(m.entries.find((e) => e.id === 'a').kcal).toBe(2);
  expect(m.entries.find((e) => e.id === 'b')).toBeUndefined();
  expect(m.entries.find((e) => e.id === 'c')).toBeTruthy();
});

test.describe('exercise & body composition', () => {
  const me = { ...profile, activity: 'sedentary', paceKg: 1, heightCm: 186, birthYear: 1999, goalKg: 100 };
  const base = { profile: me, weights: [{ id: 'w', date: T, kg: 126.4, fatPct: 35.6 }], entries: [], exercise: [] };

  test('Katch–McArdle from body fat matches what a smart scale reports', () => {
    const t = E.targets({ ...base, profile: { ...me, bmrMethod: 'bodyfat' } }, T);
    expect(Math.round(t.bmr)).toBe(2128);                 /* the scale said 2,114 */
    expect(t.bmrMethod).toBe('bodyfat');
    expect(E.targets(base, T).bmrMethod).toBe('formula');  /* opt-in only */
  });

  test('workouts are net of resting burn, and half is added back by default', () => {
    expect(E.exerciseKcal('gym', 60, 126.4)).toBe(Math.round(4 * 126.4));
    const workout = [{ id: 'g', date: T, kind: 'workout', kcal: 500 }];
    const t = E.targets({ ...base, exercise: workout }, T);
    expect(t.exerciseBonus).toBe(250);
    expect(t.kcal).toBe(t.kcalBase + 250);
    expect(t.deficit).toBe(E.targets(base, T).deficit);   /* the plan itself doesn't move */
    expect(E.targets({ ...base, profile: { ...me, exerciseEatBack: 1 }, exercise: workout }, T).exerciseBonus).toBe(500);
    const off = E.targets({ ...base, profile: { ...me, exerciseEatBack: 0 }, exercise: workout }, T);
    expect(off.kcal).toBe(off.kcalBase);
  });

  test('Apple Health: only active energy above the activity level counts, and workouts are not double-counted', () => {
    const day = E.exerciseForDay({ ...base, exercise: [
      { id: 'health:' + T, date: T, kind: 'health', activeKcal: 650, steps: 9000 },
      { id: 'g', date: T, kind: 'workout', kcal: 400 },
    ] }, T);
    expect(day.source).toBe('health');
    expect(day.baseline).toBeGreaterThan(150);
    expect(day.credit).toBe(650 - day.baseline);
  });

  test('steps-only days credit steps above the level baseline', () => {
    const quiet = E.exerciseForDay({ ...base, exercise: [{ id: 'h', date: T, kind: 'health', steps: 4000 }] }, T);
    const busy = E.exerciseForDay({ ...base, exercise: [{ id: 'h', date: T, kind: 'health', steps: 15000 }] }, T);
    expect(quiet.credit).toBe(0);
    expect(busy.credit).toBe(Math.round(10000 * 0.0005 * 126.4));
  });

  test('adaptive maintenance takes logged exercise out so it is not counted twice', () => {
    const ws = series(130, 0.5, 28);
    const ex = Array.from({ length: 28 }, (_, i) => ({ id: 'x' + i, date: E.addDays(T, -i), kind: 'workout', kcal: 300 }));
    const without = E.adaptiveTdee({ profile: me, weights: ws, entries: intake(2400) }, T).observed;
    const withEx = E.adaptiveTdee({ profile: me, weights: ws, entries: intake(2400), exercise: ex }, T).observed;
    expect(Math.round(without - withEx)).toBe(300);
  });
});

test.describe('exercise counts towards the deficit', () => {
  const me = { ...profile, activity: 'sedentary', paceKg: 1, heightCm: 186, birthYear: 1999, goalKg: 100 };
  const run = (date, kcal) => ({ id: 'r' + date, date, kind: 'workout', kcal, minutes: 40 });

  test('a 400 kcal run: half to eat, half extra deficit, burned goes up by all of it', () => {
    const base = { profile: me, weights: [{ id: 'w', date: T, kg: 126.4 }], entries: [] };
    const plain = E.targets(base, T);
    const t = E.targets({ ...base, exercise: [run(T, 400)] }, T);
    expect(t.exerciseBonus).toBe(200);
    expect(t.exerciseDeficit).toBe(200);
    expect(t.burned).toBe(plain.burned + 400);
    expect(t.deficitToday).toBe(plain.deficitToday + 200);
    /* with nothing eaten back, all 400 is deficit */
    const none = E.targets({ ...base, profile: { ...me, exerciseEatBack: 0 }, exercise: [run(T, 400)] }, T);
    expect(none.exerciseDeficit).toBe(400);
    expect(none.kcal).toBe(none.kcalBase);
  });

  test('regular exercise speeds up the expected pace and goal date', () => {
    const base = { profile: me, weights: [{ id: 'w', date: T, kg: 126.4 }], entries: [] };
    const ex = Array.from({ length: 14 }, (_, i) => run(E.addDays(T, -(i + 1)), 500));
    const t = E.targets({ ...base, exercise: ex }, T);
    expect(t.exerciseAvgDeficit).toBe(250);
    expect(t.plannedPaceKg).toBeCloseTo(t.dietPaceKg + (250 * 7) / 7700, 5);
  });

  test('summary totals for the Exercise page', () => {
    const s = { profile: me, weights: [{ id: 'w', date: T, kg: 126.4 }], exercise: [run(T, 400), run(E.addDays(T, -2), 300), { id: 'old', date: E.addDays(T, -10), kind: 'workout', kcal: 999 }] };
    const w = E.exerciseSummary(s, T, 7);
    expect(w.days).toHaveLength(7);
    expect(w.burned).toBe(700);
    expect(w.added).toBe(350);
    expect(w.extraDeficit).toBe(350);
    expect(w.workouts).toBe(2);
    expect(w.minutes).toBe(80);
  });
});

test.describe('saved meals & recipes', () => {
  const bowl = { id: 'b', name: 'Yoghurt bowl', servings: 1, items: [
    { name: 'Greek yoghurt', per100: { kcal: 57, protein: 10.4, carbs: 3.9, fat: 0 }, grams: 200 },
    { name: 'Granola', per100: { kcal: 450, protein: 9, carbs: 60, fat: 18 }, grams: 40 },
    { name: 'Honey', kcal: 64, carbs: 17 },
  ] };
  test('totals add up, and editing grams recalculates from per-100 g', () => {
    expect(E.recipeTotals(bowl).total.kcal).toBe(114 + 180 + 64);
    const more = { ...bowl, items: bowl.items.map((x, i) => (i === 0 ? { ...x, grams: 300 } : x)) };
    expect(E.recipeTotals(more).total.kcal).toBe(171 + 180 + 64);
  });
  test('batch recipes split into servings', () => {
    const chilli = { name: 'Chilli', servings: 6, items: [{ name: 'Pot', kcal: 3000, protein: 240, carbs: 240, fat: 120 }] };
    expect(E.recipePortion(chilli, 1)).toEqual({ kcal: 500, protein: 40, carbs: 40, fat: 20 });
    expect(E.recipePortion(chilli, 1.5).kcal).toBe(750);
  });
});
