/* Copies only what the site serves into dist/, and stamps the build.

   Pages publishes its whole output directory, so deploying the repo root
   would also publish tests, schema.sql, docs and — worst — the local dev
   database under .wrangler/. Functions are read from ./functions by
   Wrangler/Pages directly and don't need copying.

   Build id (same scheme as For The Ummah): one id per build, written into
     • sw.js          → a fresh shell cache per deploy, no hand-bumped version
     • index.html     → window.__TALLY_BUILD__, so the open app knows its own build
     • version.json   → what the open app compares against to spot a new deploy
     • /lib/*.js URLs → ?v=<id>, so a new page can never run against old engine code */
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';

const OUT = 'dist';
const PUBLIC = ['index.html', 'sw.js', 'manifest.json', '_headers', 'tally-icon.svg', 'icons', 'lib', 'vendor'];
const BUILD = Date.now().toString(36);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const p of PUBLIC) cpSync(p, `${OUT}/${p}`, { recursive: true });

const libs = readdirSync('lib').filter((f) => f.endsWith('.js')).map((f) => `/lib/${f}`);
const stamp = (file, extra = (s) => s) => {
  let s = readFileSync(`${OUT}/${file}`, 'utf8');
  for (const l of libs) s = s.split(`'${l}'`).join(`'${l}?v=${BUILD}'`).split(`"${l}"`).join(`"${l}?v=${BUILD}"`);
  s = extra(s);
  writeFileSync(`${OUT}/${file}`, s);
};
stamp('index.html', (s) => s.split('__TALLY_BUILD__VALUE').join(BUILD));
stamp('sw.js', (s) => s.split('__BUILD_ID__').join(BUILD));
writeFileSync(`${OUT}/version.json`, JSON.stringify({ build: BUILD }));

console.log(`built ${OUT}/ · build ${BUILD} (${new Date(parseInt(BUILD, 36)).toISOString()})`);
