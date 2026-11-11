/* Minimal WebAuthn (passkeys) verification on WebCrypto — no dependencies.

   What makes this small: the browser exposes the new credential's public key
   already in SPKI form (getPublicKey()) together with its algorithm, so
   registration never needs a CBOR/COSE parser. Attestation is 'none' — we
   trust the platform authenticator, we don't need to prove its make/model.

   Supported algorithms: ES256 (-7, what Apple/Google/Windows passkeys use),
   EdDSA (-8) and RS256 (-257, older Windows Hello). */
import { sha256, unb64url, bytesEqual, randomId, b64url } from './auth.js';

export const ALGS = [-7, -8, -257];
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const dec = new TextDecoder();

export const rpFor = (request) => {
  const url = new URL(request.url);
  return { id: url.hostname, origin: url.origin };
};

export async function issueChallenge(env, userId = null) {
  const id = randomId(12);
  const challenge = randomId(32);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM challenges WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO challenges (id, challenge, user_id, expires_at) VALUES (?, ?, ?, ?)')
      .bind(id, challenge, userId, now + CHALLENGE_TTL_MS),
  ]);
  return { challengeId: id, challenge };
}

/* Single use: the row is deleted whether or not verification then succeeds. */
export async function consumeChallenge(env, id) {
  const row = await env.DB.prepare('SELECT challenge, user_id, expires_at FROM challenges WHERE id = ?').bind(String(id || '')).first();
  if (!row) return null;
  await env.DB.prepare('DELETE FROM challenges WHERE id = ?').bind(id).run();
  return row.expires_at >= Date.now() ? row : null;
}

function checkClientData(clientDataB64, type, challenge, origin) {
  let cd;
  try { cd = JSON.parse(dec.decode(unb64url(clientDataB64))); } catch { return 'Bad client data'; }
  if (cd.type !== type) return 'Wrong ceremony type';
  if (cd.challenge !== challenge) return 'Challenge mismatch';
  if (cd.origin !== origin) return 'Origin mismatch';
  return null;
}

/* authenticatorData: rpIdHash(32) | flags(1) | signCount(4, big-endian) | … */
async function checkAuthData(authData, rpId) {
  if (authData.length < 37) return { error: 'Bad authenticator data' };
  if (!bytesEqual(authData.slice(0, 32), await sha256(rpId))) return { error: 'RP ID mismatch' };
  const flags = authData[32];
  if (!(flags & 0x01)) return { error: 'User not present' };
  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
  return { flags, signCount };
}

export async function verifyRegistration({ body, expected, rp }) {
  const cdErr = checkClientData(body.clientDataJSON, 'webauthn.create', expected.challenge, rp.origin);
  if (cdErr) return { error: cdErr };
  const ad = await checkAuthData(unb64url(body.authenticatorData), rp.id);
  if (ad.error) return ad;
  const alg = Number(body.alg);
  if (!ALGS.includes(alg)) return { error: 'Unsupported key type' };
  /* Import once now so a key we couldn't verify with later is refused up front. */
  try { await importKey(unb64url(body.publicKey), alg); } catch { return { error: 'Unreadable public key' }; }
  return { ok: true, signCount: ad.signCount, alg };
}

export async function verifyAssertion({ body, expected, rp, passkey }) {
  const cdErr = checkClientData(body.clientDataJSON, 'webauthn.get', expected.challenge, rp.origin);
  if (cdErr) return { error: cdErr };
  const authData = unb64url(body.authenticatorData);
  const ad = await checkAuthData(authData, rp.id);
  if (ad.error) return ad;

  /* A counter that fails to advance means a cloned authenticator. Synced
     passkeys always report 0, which is exempt by spec. */
  if ((ad.signCount || passkey.sign_count) && ad.signCount <= passkey.sign_count) {
    return { error: 'Authenticator counter went backwards' };
  }

  const clientHash = await sha256(unb64url(body.clientDataJSON));
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData, 0);
  signed.set(clientHash, authData.length);

  const key = await importKey(unb64url(passkey.public_key), passkey.alg);
  let sig = unb64url(body.signature);
  let params;
  if (passkey.alg === -7) { params = { name: 'ECDSA', hash: 'SHA-256' }; sig = derToRaw(sig, 32); }
  else if (passkey.alg === -8) params = { name: 'Ed25519' };
  else params = { name: 'RSASSA-PKCS1-v1_5' };

  const ok = await crypto.subtle.verify(params, key, sig, signed);
  return ok ? { ok: true, signCount: ad.signCount } : { error: 'Bad signature' };
}

function importKey(spki, alg) {
  if (alg === -7) return crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (alg === -8) return crypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify']);
  if (alg === -257) return crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  throw new Error('alg');
}

/* WebAuthn ECDSA signatures are ASN.1 DER; WebCrypto wants raw r‖s. */
export function derToRaw(der, size) {
  if (der[0] !== 0x30) throw new Error('not DER');
  let i = 2;
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const readInt = () => {
    if (der[i] !== 0x02) throw new Error('not INTEGER');
    const len = der[i + 1];
    let v = der.slice(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > size && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  const r = readInt(), s = readInt();
  const raw = new Uint8Array(size * 2);
  raw.set(r, 0); raw.set(s, size);
  return raw;
}

export { b64url };
