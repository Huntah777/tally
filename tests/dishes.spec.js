import { test, expect } from '@playwright/test';
const R = require('../lib/receipt.js');
const D = require('../lib/dishes.js');

const kcal = (name) => { const e = D.estimate(name); return e ? Math.round((e.food.per100.kcal * e.grams) / 100) : null; };

const DELIVEROO = `Deliveroo
Order #4821
McDonald's - Oxford Street
1x Big Mac Meal
£7.49
Size: Large
Drink: Diet Coke
1x 9 Chicken McNuggets £4.99
2x Cheeseburger £3.18
1x McFlurry Oreo £1.99
+ Extra sauce (+£0.40)
- No pickles
Subtotal £17.65
Delivery fee £1.99
Service fee £1.50
Rider tip £1.00
Total £22.14`;

const RESTAURANT = `THE OLD BELL
Table 12  Covers 2
Served by: Sam
2 Margherita           21.00
1 Chicken Katsu Curry  13.50
2 Peroni               12.40
Subtotal 46.90
Service Charge 12.5%    5.86
Total                  52.76
Visa 52.76`;

test.describe('takeaway & restaurant receipts', () => {
  test('detects delivery apps and restaurant bills, not supermarket receipts', () => {
    expect(R.detectKind(DELIVEROO)).toBe('takeaway');
    expect(R.detectKind(RESTAURANT)).toBe('takeaway');
    expect(R.detectKind('TESCO STORES\nTESCO SS MILK 2L 1.45\nTOTAL 1.45\nVISA 1.45')).toBe('grocery');
  });

  test('Deliveroo: prices on the next line, meal options folded in, fees dropped', () => {
    const items = R.parseReceiptText(DELIVEROO);
    expect(items.map((i) => [i.qty, i.name])).toEqual([
      [1, 'Big Mac Meal Large Diet Coke'],
      [1, '9 Chicken McNuggets'],
      [2, 'Cheeseburger'],
      [1, 'McFlurry Oreo'],
      [1, 'sauce'],
    ]);
    expect(items[4].mod).toBe(true);
  });

  test('restaurant bill: bare leading quantities, service charge and covers dropped', () => {
    const items = R.parseReceiptText(RESTAURANT);
    expect(items.map((i) => [i.qty, i.name])).toEqual([[2, 'Margherita'], [1, 'Chicken Katsu Curry'], [2, 'Peroni']]);
  });
});

test.describe('portion estimates', () => {
  test('specific dishes beat generic ones', () => {
    expect(D.findDish('Chicken Katsu Curry').name).toMatch(/katsu/i);
    expect(D.findDish('Chicken Tikka Masala').name).toBe('Chicken tikka masala');
    expect(D.findDish('Pepperoni Pizza').name).toMatch(/pepperoni/i);
    expect(D.findDish('Diet Coke').name).toMatch(/diet/i);
    expect(D.findDish('Garlic Naan').name).toBe('Garlic naan');
    expect(D.findDish('Teriyaki chicken').name).toMatch(/teriyaki/i);
  });

  test('meal deals add fries and the right drink', () => {
    /* within a few kcal: values round-trip through per-100g */
    expect(Math.abs(kcal('Big Mac Meal') - (508 + 337 + 139))).toBeLessThanOrEqual(5);
    expect(Math.abs(kcal('Big Mac Meal Diet Coke') - (508 + 337 + 1))).toBeLessThanOrEqual(5);
    expect(kcal('Big Mac Meal Large Diet Coke')).toBeGreaterThan(kcal('Big Mac Meal Diet Coke'));
  });

  test('piece counts, sizes and pizza diameter scale the portion', () => {
    expect(kcal('9 Chicken McNuggets')).toBeCloseTo(259 * 1.5, -1);
    expect(kcal('20 piece wings')).toBeCloseTo(480 * 20 / 6, -1);
    expect(kcal('Large fries')).toBeGreaterThan(kcal('Fries'));
    expect(kcal('Small fries')).toBeLessThan(kcal('Fries'));
    expect(kcal('Margherita 14"')).toBeCloseTo(1400 * (14 / 12) ** 2, -1);
  });

  test('short keywords only match whole words', () => {
    expect(D.findDish('pieces of chicken')?.name).not.toBe('Pie (meat, individual)');
    expect(D.findDish('Teriyaki bowl')?.name).not.toMatch(/tea/i);
  });

  test('unknown things return nothing rather than a wild guess', () => {
    expect(D.estimate('Gift card')).toBeNull();
    expect(D.estimate('Cutlery')).toBeNull();
  });
});
