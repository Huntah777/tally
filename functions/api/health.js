/* GET /api/health — liveness check (no secrets exposed). `db` says whether
   the D1 binding is attached, the usual cause of a broken fresh deploy;
   `invite` tells the sign-up form to ask for an invite code up front;
   `shortcut` is the shared iCloud link to the ready-made Apple Health
   Shortcut, when SHORTCUT_URL is set (see SETUP.md). */
import { json } from '../_lib/auth.js';

export async function onRequest({ env }) {
  const shortcut = (env.SHORTCUT_URL || '').trim();
  return json({
    ok: true,
    db: !!env.DB,
    invite: !!(env.SIGNUP_CODE || '').trim(),
    shortcut: /^https:\/\/(www\.)?icloud\.com\/shortcuts\//.test(shortcut) ? shortcut : null,
  });
}
