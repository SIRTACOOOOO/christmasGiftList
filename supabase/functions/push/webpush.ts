// Web Push without any libraries: RFC 8291 (message encryption, aes128gcm) + RFC 8292 (VAPID), using only the WebCrypto
// built into Deno. Fewer imports means the function starts faster (important: notifications should feel instant).
const enc = new TextEncoder();

export const b64u = (buf: ArrayBuffer | Uint8Array): string => {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = (s: string): Uint8Array => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
};
const concat = (...a: Uint8Array[]): Uint8Array => {
  const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0;
  for (const x of a) { o.set(x, i); i += x.length; }
  return o;
};
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** Encrypts `plaintext` for one browser subscription. `asKeys` and `salt` are only passed by the test (RFC 8291 appendix A). */
export async function encryptPayload(
  plaintext: Uint8Array, uaPublic: Uint8Array, authSecret: Uint8Array,
  test?: { asKeys: CryptoKeyPair; salt: Uint8Array },
): Promise<Uint8Array> {
  const as = test?.asKeys ?? await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode('WebPush: info\0'), uaPublic, asPub), 32);
  const salt = test?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPub.length]), asPub, ct);   // header + one 4096-byte record
}

const keyCache = new Map<string, CryptoKey>();
/** The "Authorization: vapid ..." header that proves the message comes from you (your private VAPID key). */
export async function vapidHeader(endpoint: string, subject: string, pub: string, priv: string): Promise<string> {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  let key = keyCache.get(pub + priv);
  if (!key) {
    const p = unb64u(pub);
    key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: b64u(p.slice(1, 33)), y: b64u(p.slice(33, 65)), d: priv, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    keyCache.set(pub + priv, key);
  }
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body)));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${pub}`;
}

export type Sub = { endpoint: string; p256dh: string; auth: string };
/** Sends one notification. Urgency "high" matters: without it Android can hold messages back for minutes while the phone sleeps. */
export async function sendPush(sub: Sub, payload: unknown, vapid: { subject: string; pub: string; priv: string }, ttl = 3600): Promise<{ status: number; text: string }> {
  const body = await encryptPayload(enc.encode(JSON.stringify(payload)), unb64u(sub.p256dh), unb64u(sub.auth));
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': await vapidHeader(sub.endpoint, vapid.subject, vapid.pub, vapid.priv),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'TTL': String(ttl), 'Urgency': 'high',
    },
    body, signal: AbortSignal.timeout(8000),
  });
  const text = r.status >= 300 ? (await r.text().catch(() => '')).slice(0, 200) : '';
  if (r.status < 300) await r.body?.cancel();
  return { status: r.status, text };
}
