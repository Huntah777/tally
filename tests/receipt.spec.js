import { test, expect } from '@playwright/test';
const R = require('../lib/receipt.js');

const TESCO = `TESCO STORES LTD
TEL 0345 677 9000
TESCO SS MILK 2L          1.45
WARBURTONS WHLML BRD 800G 1.40
2 @ £0.70
BANANAS LOOSE             1.30
TIPTREE STRAWB JAM        2.75
CLUBCARD PRICE           -0.50
CARRIER BAG               0.10
SUBTOTAL                  7.00
TOTAL                     6.50
VISA CONTACTLESS          6.50
CHANGE DUE                0.00`;

test('keeps food lines, drops totals/payment/loyalty/bags', () => {
  const items = R.parseReceiptText(TESCO);
  expect(items.map((i) => i.name)).toEqual(['TESCO SS MILK 2L', 'WARBURTONS WHLML BRD 800G', 'BANANAS LOOSE', 'TIPTREE STRAWB JAM']);
  expect(items[1].qty).toBe(2);
});

test('expands abbreviations and strips store names', () => {
  expect(R.expand('TESCO SS MILK 2L')).toBe('semi skimmed milk');
  expect(R.expand('SBY CHKN BRST FLLTS 650G')).toBe('chicken breast fillets');
  expect(R.expand('ASDA GRK YOG 500G')).toBe('greek yoghurt');
});

test('pack sizes', () => {
  expect(R.packSize('MILK 2L')).toEqual({ amount: 2000, unit: 'ml' });
  expect(R.packSize('YOG 4X125G')).toEqual({ amount: 500, unit: 'g' });
  expect(R.packSize('CHICKEN 1.2KG')).toEqual({ amount: 1200, unit: 'g' });
});

test('aliases survive size and store changes; remembered matches win', () => {
  expect(R.aliasKey('TESCO SS MILK 2L')).toBe(R.aliasKey('SS MILK 4PT'));
  const foods = [{ id: 'f1', name: 'Semi skimmed milk', brand: 'Tesco', per100: { kcal: 50 } }, { id: 'f2', name: 'Whole milk', per100: { kcal: 64 } }];
  const aliases = { [R.aliasKey('TESCO SS MILK 2L')]: { foodId: 'f1', grams: 250 } };
  expect(R.matchLocal({ name: 'TESCO SS MILK 1L' }, foods, aliases)).toMatchObject({ how: 'remembered', grams: 250 });
  expect(R.matchLocal({ name: 'WHOLE MILK 2PT' }, foods, {})).toMatchObject({ how: 'similar', food: { id: 'f2' } });
});
