/* GET /api/health — liveness check (no secrets exposed). `db` says whether
   the D1 binding is attached, the usual cause of a broken fresh deploy;
   `invite` tells the sign-up form to ask for an invite code up front. */
import { json } from '../_lib/auth.js';

export async function onRequest({ env }) {
  return json({ ok: true, db: !!env.DB, invite: !!(env.SIGNUP_CODE || '').trim() });
}
