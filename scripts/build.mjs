/* Copies only what the site serves into dist/.
   Pages publishes its whole output directory, so deploying the repo root
   would also publish tests, schema.sql, docs and — worst — the local dev
   database under .wrangler/. Functions are read from ./functions by
   Wrangler/Pages directly and don't need copying. */
import { cpSync, rmSync, mkdirSync } from 'node:fs';

const OUT = 'dist';
const PUBLIC = ['index.html', 'sw.js', 'manifest.json', '_headers', 'tally-icon.svg', 'icons', 'lib', 'vendor'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const p of PUBLIC) cpSync(p, `${OUT}/${p}`, { recursive: true });
console.log(`built ${OUT}/ (${PUBLIC.join(', ')})`);
