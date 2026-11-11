/* GET /api/health — liveness check (no secrets exposed). `db` says whether
   the D1 binding is attached, the usual cause of a broken fresh deploy. */
import { json } from '../_lib/auth.js';

export async function onRequest({ env }) {
  return json({ ok: true, db: !!env.DB });
}
