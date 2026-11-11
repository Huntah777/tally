# Tally — deployment & setup

Same shape as Command Deck and Folio: a single-file React PWA (`index.html`)
served by Cloudflare Pages, Pages Functions under `functions/`, and one D1
database. The only build step is `npm run build`, which copies the public
files into `dist/`. That keeps tests, docs, `schema.sql` and the local dev
database in `.wrangler/` out of what gets published.

**It costs nothing to run.** Every piece fits inside a free tier:

| Piece | Service | Free allowance |
|---|---|---|
| Hosting + API | Cloudflare Pages + Functions | Unlimited static requests, 100k Function calls/day |
| Accounts + data | Cloudflare D1 | 5 GB, 5M reads/day, 100k writes/day |
| Food database | Open Food Facts | Free and open, no key |
| Barcode scanning | On-device (BarcodeDetector / ZXing) | No server work |
| Receipt reading | On-device OCR (Tesseract, vendored) | No server work |
| Passkeys | WebAuthn, verified in the Function with WebCrypto | No third-party auth |

---

## 1. One-time setup

```bash
npm install
npx wrangler login
npx wrangler d1 create tally-db
```

Copy `wrangler.toml.example` to `wrangler.toml` (it's gitignored) and paste the
`database_id` that `d1 create` printed. Then create the tables:

```bash
npx wrangler d1 execute tally-db --remote --file=./schema.sql
```

The schema is safe to re-run. Everything is `IF NOT EXISTS`.

## 2. Pages project

**Direct upload (how it's deployed today):**

```bash
npm run deploy
```

This builds `dist/` and uploads it plus `functions/` to the `tally` project.
The D1 binding comes from `wrangler.toml`.

**Or connect Git** so every push deploys:

*Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git* and
pick this repo.

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |

Then **Settings → Bindings → Add → D1 database**:

| Variable name | D1 database |
|---|---|
| `DB` | `tally-db` |

Add it for Production (and Preview, if you use preview deployments), then
redeploy once.

### Optional: invite-only sign-ups

By default anyone who finds the URL can create an account. To restrict that,
add an environment variable (*Settings → Variables and Secrets*):

| Name | Value |
|---|---|
| `SIGNUP_CODE` | any phrase you'll give to people you invite |

The sign-up form then asks for the code.

## 3. Accounts, passwords and passkeys

- Passwords are hashed with PBKDF2-SHA256 (100k iterations, the Workers
  maximum). Sessions are HttpOnly cookies, and only their SHA-256 is stored.
- **There's no email reset**, because sending email would mean another service.
  Instead every account gets a **recovery code** at sign-up, shown once. It
  resets the password and is then replaced with a new one.
- Wrong passwords are throttled: 8 per email or 30 per IP in 15 minutes.
- **Passkeys** (Face ID, Touch ID, Windows Hello, Android) can be added under
  *Me → Account*. They're tied to the domain they were created on, so after a
  move to a custom domain people need to add them again.

If someone loses both their password and recovery code, reset them from the
CLI:

```bash
npx wrangler d1 execute tally-db --remote --command "SELECT id, email FROM users WHERE email = 'them@example.com'"
```

Deleting that user's row lets them sign up fresh, but **this loses their
data**. Ask them for a backup first (*Me → Download backup*).

## Updates (no cache clearing needed)

Same scheme as For The Ummah. `npm run build` stamps one build ID into
`sw.js` (so each deploy gets a fresh shell cache), into `index.html`
(`window.__TALLY_BUILD__`), into `/version.json`, and onto the `/lib/*.js`
URLs. A new page can therefore never run against old engine code.

An open app checks for a new build when it comes back to the foreground, when
it comes back online, and every 30 minutes. The new service worker takes over
at once. The page then reloads, but **only when it's safe**: never while a
sheet is open or a field has focus. In that case a "New version ready" pill
waits, and the switch happens as soon as the person is done. There's at most
one automatic reload per build, so a broken deploy can't cause a reload loop.

If the app ever fails to start (a broken deploy or a bad cache), a plain-JS
watchdog shows **Repair app** after 10 seconds instead of a blank screen. The
same button is under *Me → App*. It clears the cached shell and reloads, and
your data isn't touched.

`tests/updates.spec.js` simulates a deploy against the real service worker,
both idle and mid-entry, and also tests the watchdog.

## Apple Health sync

A web app can't read HealthKit, so an iOS Shortcut does it. It runs as a
daily personal automation and posts the day's active energy, steps, weight
and body fat to `/api/ingest` using a personal **sync link** with the key
embedded (made in *Me → Apple Health*, stored hashed in the `api_tokens`
table, shown once). The server does the fiddly parts: it takes the date from
the caller's time zone, adds up raw sample lists, and parses units, so the
Shortcut is three actions.

For a one-tap setup, build the Shortcut once with an import question for the
link, share it via iCloud, and set the link as `SHORTCUT_URL` in Pages →
Settings → Variables. Me → Apple Health then shows an **Add Shortcut** button.
A key can only send Health numbers; it can't read data or sign in. The
step-by-step setup is in the app, in the same card.

How the numbers are used (`exerciseForDay` in `lib/engine.js`):

- Active energy counts only above what the chosen day-to-day activity level
  already assumes. A watch also counts walking around the house.
- With steps only, steps above the level's baseline count.
- On an Apple Health day, workouts logged by hand aren't added on top,
  because the watch already counted them.
- Half of the credit is added to the day's target by default (*Me →
  Exercise*: Off / Half / All).

`schema.sql` is safe to re-run after pulling. It added `api_tokens` for this.

## 4. Local development

```bash
npx wrangler d1 execute tally-db --local --file=./schema.sql
npm run dev            # http://localhost:8790
```

To test invite-only sign-up locally, copy `.dev.vars.example` to `.dev.vars`.

## 5. Tests

```bash
npm test
```

- **unit:** the engine (targets, trend, adaptive maintenance, every health
  insight), the importers (MyFitnessPal ZIP, Lose It!, Cronometer, Apple
  Health, generic CSV) and receipt parsing.
- **api:** sign-up and login, CSRF, per-user isolation, merge and tombstones,
  ETag, recovery codes, throttling, account deletion. Runs against
  `wrangler pages dev` with a throwaway local D1 in `.wrangler/test-state`.
- **chromium / iphone:** end-to-end in a browser: sign up, onboarding, logging,
  persistence across devices, and a real passkey round-trip using Chromium's
  virtual authenticator.

## How the pieces fit

| File | Role |
|---|---|
| `index.html` | The whole UI (React + in-browser Babel, like the siblings) |
| `lib/engine.js` | Targets, trend weight, pace, adaptive maintenance, health insights |
| `lib/importers.js` | MyFitnessPal / Lose It! / Cronometer / Apple Health / CSV import |
| `lib/receipt.js` | Receipt parsing (supermarkets, Deliveroo/Uber Eats/Just Eat, restaurant bills), abbreviations, learned matches |
| `lib/dishes.js` | Typical UK takeaway & restaurant portions (~170 dishes), offline, labelled as estimates |
| `functions/api/auth/[action].js` | Sign up, sign in, recovery, password change, delete |
| `functions/api/passkey/[action].js` | WebAuthn registration and sign-in |
| `functions/api/state.js` | Per-user state, merged on every write (same design as Folio) |
| `functions/api/food/*.js` | Open Food Facts barcode lookup and search, edge-cached |
| `vendor/tesseract/` | On-device OCR, loaded only when a receipt is scanned |
| `vendor/zxing.min.js` | Barcode reader for browsers without BarcodeDetector (iOS) |

The `lib/*.js` files are plain scripts that work in the page and in Node, so
the tests exercise exactly the code the app runs.

## Design

Tally follows iOS 26 (Liquid Glass): SF Pro and Apple's system colours,
grouped-inset cards, capsule controls, a floating glass tab bar with a separate
+ button, and inset glass sheets. It respects Reduce Transparency and Reduce
Motion, and has Auto, Dark and Light themes. Install it from Safari with
*Share → Add to Home Screen* and it runs full-screen like a native app.
