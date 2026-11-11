/* GET /api/health — liveness check (no secrets exposed) */
import { json } from '../_lib/auth.js';

export async function onRequest({ env }) {
  return json({ ok: true, sync_configured: !!(env.SYNC_TOKEN || '').trim() });
}
