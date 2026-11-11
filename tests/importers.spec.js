import { test, expect } from '@playwright/test';
import { deflateRawSync } from 'zlib';
const I = require('../lib/importers.js');

const file = (name, text) => ({ name, text: async () => text, arrayBuffer: async () => Buffer.from(text) });

/* Minimal ZIP writer (deflate) — enough to round-trip the reader. */
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), comp = deflateRawSync(data), nm = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nm, comp); centrals.push(ch, nm);
    offset += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const buf = Buffer.concat([...locals, cd, end]);
  return { name: 'export.zip', arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
}

const MFP_NUTRITION = `Date,Meal,Calories,Fat (g),Saturated Fat,Polyunsaturated Fat,Monounsaturated Fat,Trans Fat,Cholesterol,Sodium (mg),Potassium,Carbohydrates (g),Fiber,Sugar,Protein (g),Vitamin A,Vitamin C,Calcium,Iron,Note
2024-03-01,Breakfast,420,12,3,0,0,0,0,300,0,55,4,10,22,0,0,0,0,
2024-03-01,Lunch,610,20,5,0,0,0,0,800,0,70,6,8,35,0,0,0,0,
2024-03-02,Dinner,"1,050",40,12,0,0,0,0,900,0,90,8,12,60,0,0,0,0,
`;
const MFP_MEASURE = `Date,Weight\n2024-03-01,210.4\n2024-03-08,208.0\n`;

test('MyFitnessPal export ZIP: meals become entries, weight unit detected as lb', async () => {
  const { sources } = await I.analyse([zip({
    'File-Export-2024/Nutrition-Summary-2024-01-01-to-2024-03-31.csv': MFP_NUTRITION,
    'File-Export-2024/Measurement-Summary-2024-01-01-to-2024-03-31.csv': MFP_MEASURE,
    'File-Export-2024/Exercise-Summary-2024-01-01-to-2024-03-31.csv': 'Date,Exercise,Calories\n2024-03-01,Run,300\n',
  })]);
  const food = sources.find((s) => s.kind === 'mfp-nutrition');
  expect(food.entries).toHaveLength(3);
  expect(food.entries.find((e) => e.date === '2024-03-02').kcal).toBe(1050);
  expect(food.entries[0]).toMatchObject({ meal: 'breakfast', protein: 22, carbs: 55, fat: 12 });
  const w = sources.find((s) => s.kind === 'mfp-measurement');
  expect(w.weightUnit).toBe('lb');
  expect(w.weights[0].kg).toBeCloseTo(95.44, 1);
  expect(sources.some((s) => /exercise/i.test(s.name))).toBe(false);
});

test('re-importing produces the same ids (no duplicates)', async () => {
  const a = (await I.analyse([file('Nutrition-Summary.csv', MFP_NUTRITION)])).sources[0].entries.map((e) => e.id);
  const b = (await I.analyse([file('Nutrition-Summary.csv', MFP_NUTRITION)])).sources[0].entries.map((e) => e.id);
  expect(a).toEqual(b);
  expect(new Set(a).size).toBe(a.length);
});

test('Lose It! food log', async () => {
  const csv = `Date,Name,Icon,Type,Quantity,Units,Calories,Deleted,Fat (g),Protein (g),Carbohydrates (g)
03/01/2024,Eggs,Egg,Breakfast,2,Each,156,false,10.6,12.6,1.1
03/01/2024,Eggs,Egg,Breakfast,1,Each,78,false,5.3,6.3,0.6
03/01/2024,Old thing,x,Lunch,1,Each,500,true,1,1,1
03/13/2024,Running,Run,Exercise,30,Minutes,-300,false,0,0,0`;
  const s = (await I.analyse([file('food-logs.csv', csv)])).sources[0];
  expect(s.kind).toBe('loseit-food');
  expect(s.entries).toHaveLength(2);
  expect(new Set(s.entries.map((e) => e.id)).size).toBe(2);
  expect(s.entries[0].date).toBe('2024-03-01');
});

test('Cronometer servings + biometrics; daily summary skipped to avoid double counting', async () => {
  const servings = `Day,Time,Group,Food Name,Amount,Energy (kcal),Carbs (g),Fat (g),Protein (g)
2024-03-01,08:00,Breakfast,Oats,40 g,150,27,3,5
2024-03-01,19:00,Dinner,Chicken,200 g,330,0,7,62`;
  const daily = `Date,Energy (kcal),Protein (g)\n2024-03-01,480,67`;
  const bio = `Day,Group,Metric,Unit,Amount\n2024-03-01,Weight,Weight,lbs,200\n2024-03-01,Vitals,Heart Rate,bpm,60`;
  const { sources } = await I.analyse([file('servings.csv', servings), file('dailysummary.csv', daily), file('biometrics.csv', bio)]);
  expect(sources.find((s) => s.kind === 'cronometer-servings').entries).toHaveLength(2);
  expect(sources.find((s) => s.kind === 'cronometer-daily').entries).toHaveLength(0);
  expect(sources.find((s) => s.kind === 'cronometer-biometrics').weights[0].kg).toBeCloseTo(90.72, 1);
});

test('Apple Health export.xml: body mass and dietary energy per day', async () => {
  const xml = `<?xml version="1.0"?><HealthData>
 <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Scale" unit="kg" startDate="2024-03-01 07:00:00 +0000" endDate="2024-03-01 07:00:00 +0000" value="88.2"/>
 <Record type="HKQuantityTypeIdentifierDietaryEnergyConsumed" unit="kcal" startDate="2024-03-01 12:00:00 +0000" value="600"/>
 <Record type="HKQuantityTypeIdentifierDietaryEnergyConsumed" unit="kJ" startDate="2024-03-01 19:00:00 +0000" value="4184"/>
 <Record type="HKQuantityTypeIdentifierDietaryProtein" unit="g" startDate="2024-03-01 19:00:00 +0000" value="40"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-03-01 19:00:00 +0000" value="9000"/>
</HealthData>`;
  const s = (await I.analyse([file('export.xml', xml)])).sources[0];
  expect(s.weights).toEqual([expect.objectContaining({ date: '2024-03-01', kg: 88.2 })]);
  expect(s.entries[0]).toMatchObject({ date: '2024-03-01', kcal: 1600, protein: 40 });
});

test('generic CSV: column guessing, UK dates, unit override', async () => {
  const csv = `Day;Body Weight;Energy\n25/02/2024;14.5;2100\n03/03/2024;14.3;1950`;
  const s = (await I.analyse([file('my-sheet.csv', csv)])).sources[0];
  expect(s.kind).toBe('generic');
  expect(s.columns).toMatchObject({ date: 'Day', weight: 'Body Weight', kcal: 'Energy' });
  expect(s.dateOrder).toBe('dmy');
  expect(s.entries.map((e) => e.date)).toEqual(['2024-02-25', '2024-03-03']);
  expect(s.weightUnit).toBe('st');
  const kg = I.reparse(s, { weightUnit: 'kg' });
  expect(kg.weights[0].kg).toBe(14.5);
});

test('date parsing', () => {
  expect(I.parseDate('2024-1-5')).toBe('2024-01-05');
  expect(I.parseDate('05/01/2024', 'dmy')).toBe('2024-01-05');
  expect(I.parseDate('05/01/2024', 'mdy')).toBe('2024-05-01');
  expect(I.parseDate('Jan 5, 2024')).toBe('2024-01-05');
  expect(I.parseDate('5 January 2024')).toBe('2024-01-05');
});
