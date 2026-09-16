/**
 * Minimal, dependency-free HS256 JWT sign/verify — used only for the Sales
 * CRM renewal handoff (services/renewalHandoff.service.js). No package.json
 * addition needed: the whole thing is base64url + Node's built-in crypto,
 * and the output is a byte-for-byte standard JWT ("header.payload.signature",
 * alg HS256) — decodable and verifiable by any JWT library (jsonwebtoken,
 * PyJWT, ...), which matters because the verifying side lives in a
 * completely different app this codebase has no access to. Don't reach for
 * this for anything beyond that one handoff — this app's own session tokens
 * (auth.service.js) are opaque Mongo-backed tokens, not JWTs, and should
 * stay that way.
 */
import crypto from 'crypto';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** Signs `payload` (a plain object) as a standard HS256 JWT. `expiresInSecs`
 *  sets `exp` relative to now; `iat` is always stamped. */
export function signJwt(payload, secret, expiresInSecs) {
  if (!secret) throw new Error('signJwt: secret is required');
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSecs };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

/** Verifies signature + expiry and returns the decoded payload, or throws. */
export function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [headerB64, payloadB64, sigB64] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  const gotSig = b64urlDecode(sigB64);
  if (expectedSig.length !== gotSig.length || !crypto.timingSafeEqual(expectedSig, gotSig)) {
    throw new Error('Bad signature');
  }
  const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  if (typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('Token expired');
  }
  return payload;
}
