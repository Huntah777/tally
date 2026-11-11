/* Per-user state: merge + optimistic-concurrency write. Shared by
   /api/state (the app) and /api/ingest (Apple Health via Shortcuts), so both
   writers go through the same merge and can never clobber each other. */

export const MAX_BODY_BYTES = 5 * 1024 * 1024; /* 5 MB — years of food log fits easily */
const MAX_WRITE_ATTEMPTS    = 3;               /* optimistic-concurrency retries */
const TOMBSTONE_TTL_MS      = 90 * 24 * 60 * 60 * 1000; /* 90 days */

/* Collections carrying soft-delete tombstones in a sibling `<key>Deleted` array.
   Must stay in step with TOMBSTONED in lib/engine.js. */
const TOMBSTONED = ['entries', 'weights', 'foods', 'exercise', 'recipes'];

const stampOf   = (it) => Number(it?.updated ?? it?.created ?? 0) || 0;
const tombStamp = (t)  => Number(t?.deletedAt ?? 0) || 0;

/* Per-item last-write-wins across items and tombstones. A newer edit beats an
   older tombstone and vice versa; on an exact tie the tombstone wins. Absence
   is never read as a delete — a device that hasn't heard about an item yet
   simply pushes a payload without it. */
function mergeTombstoned(existingItems, incomingItems, existingTombs, incomingTombs, now) {
  const winners = new Map();
  const consider = (id, ts, kind, value) => {
    if (id === undefined || id === null) return;
    const cur = winners.get(id);
    if (!cur || ts >= cur.ts) winners.set(id, { ts, kind, value });
  };
  for (const it of existingItems || []) consider(it?.id, stampOf(it), 'item', it);
  for (const it of incomingItems || []) consider(it?.id, stampOf(it), 'item', it);
  for (const t of existingTombs  || []) consider(t?.id, tombStamp(t), 'tomb', t);
  for (const t of incomingTombs  || []) consider(t?.id, tombStamp(t), 'tomb', t);

  const items = [], tombstones = [];
  for (const w of winners.values()) {
    if (w.kind === 'item') items.push(w.value);
    else if (now - tombStamp(w.value) <= TOMBSTONE_TTL_MS) tombstones.push(w.value);
  }
  return { items, tombstones };
}

/* The profile is small but every field matters (a stale height silently
   shifts every target), so it is whole-object last-write-wins by `updated`
   rather than a key-by-key splice of two different people's edits. */
const newer = (a, b) => (Number(b?.updated || 0) >= Number(a?.updated || 0) ? b : a);

export function mergeState(existing, incoming, now = Date.now()) {
  const out = { ...existing, ...incoming };

  for (const key of TOMBSTONED) {
    const tKey = key + 'Deleted';
    const { items, tombstones } = mergeTombstoned(
      existing[key], incoming[key], existing[tKey], incoming[tKey], now,
    );
    out[key]  = items;
    out[tKey] = tombstones;
  }

  if (existing.profile || incoming.profile) out.profile = newer(existing.profile, incoming.profile);
  /* Receipt-line → food mappings Tally has learned. Keys never conflict in a
     way that matters (the latest mapping for a line is as good as any). */
  out.aliases = { ...(existing.aliases || {}), ...(incoming.aliases || {}) };
  out.ui = { ...(existing.ui || {}), ...(incoming.ui || {}) };
  return out;
}

/* Read → merge → conditional write, retrying if another device wrote in
   between. `makeIncoming(existing)` returns the changes to merge in; it gets
   the stored state so a writer can build on it (e.g. add body fat to a
   weigh-in that's already there).
   Returns { ok, merged, updatedAt } or { status, error }. */
export async function writeMerged(env, userId, makeIncoming) {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const row = await env.DB.prepare('SELECT data, updated_at FROM state WHERE user_id = ?').bind(userId).first();
    let existing = {};
    try { existing = row?.data ? JSON.parse(row.data) : {}; } catch {}
    const prevAt = row?.updated_at ?? 0;

    const merged = mergeState(existing, makeIncoming(existing));
    const serialised = JSON.stringify(merged);
    if (serialised.length > MAX_BODY_BYTES) return { status: 413, error: 'Payload too large' };

    /* Strictly monotonic so the ETag built from it never repeats. */
    const now = Math.max(Date.now(), prevAt + 1);

    if (!row) {
      /* First save for this user. A concurrent first save loses the
         PRIMARY KEY race and retries as an update. */
      try {
        await env.DB.prepare('INSERT INTO state (user_id, data, updated_at) VALUES (?, ?, ?)').bind(userId, serialised, now).run();
        return { ok: true, merged, updatedAt: now };
      } catch { continue; }
    }
    const result = await env.DB.prepare('UPDATE state SET data = ?, updated_at = ? WHERE user_id = ? AND updated_at = ?')
      .bind(serialised, now, userId, prevAt).run();
    if (result.meta.changes > 0) return { ok: true, merged, updatedAt: now };
  }
  return { status: 409, error: 'Too many concurrent writes, please retry' };
}
