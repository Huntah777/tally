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
