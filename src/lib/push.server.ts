// SERVER ONLY. import-protection blocks *.server.ts files from the client bundle.
// VAPID signing for Web Push (RFC 8292) using pure Web Crypto — no node-only deps.

const VAPID_PRIVATE_KEY_D = "INwmK0bzoqNCt-OneaSf50P9wxBokQLKQdcAMAs6Ubs";
const VAPID_PUBLIC_KEY =
  "BMR7dYueFO7Ik2HeHSs9X8Mo0EbIAjuuEB-CSuvahtdklpFqYeMiwKobZxMrrf1tjxGT4qiA8IEY71sBIfm3JCQ";
export const VAPID_SUBJECT = "mailto:alerts@bryantrade.app";

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// TS in strict mode treats Uint8Array<ArrayBufferLike> as incompatible with
// BufferSource / BodyInit. Copy into a fresh ArrayBuffer-backed view to satisfy.
function asBuf(u: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u.byteLength);
  copy.set(u);
  return copy.buffer;
}

async function importVapidSigningKey(): Promise<CryptoKey> {
  // Public key is 0x04 || X(32) || Y(32)
  const pub = b64urlDecode(VAPID_PUBLIC_KEY);
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);
  const d = b64urlDecode(VAPID_PRIVATE_KEY_D);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(x),
    y: b64urlEncode(y),
    d: b64urlEncode(d),
    ext: true,
  };
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function signVapidJwt(audience: string): Promise<string> {
  const header = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const payload = b64urlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: VAPID_SUBJECT,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const key = await importVapidSigningKey();
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64urlEncode(sig)}`;
}

export type PushSubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushSendResult = {
  endpoint: string;
  ok: boolean;
  status: number;
  gone: boolean;
};

/**
 * Send a "header-only" web push (empty body). This avoids the AES-128-GCM
 * payload encryption ceremony and still triggers the SW's `push` event, which
 * displays a notification using data we hand it via the URL convention.
 *
 * We encode the notification fields into the endpoint-specific request by
 * sending them in the `Topic` header is not enough, so we POST an encrypted
 * payload built with aes128gcm + ECDH per RFC 8291.
 */
export async function sendWebPush(
  sub: PushSubscriptionRow,
  payload: string,
): Promise<PushSendResult> {
  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await signVapidJwt(audience);

  const encrypted = await encryptPayload(payload, sub.p256dh, sub.auth);

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: "60",
      Urgency: "high",
    },
    body: encrypted,
  });

  return {
    endpoint: sub.endpoint,
    ok: res.ok,
    status: res.status,
    gone: res.status === 404 || res.status === 410,
  };
}

// ===== RFC 8291 aes128gcm payload encryption =====

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function encryptPayload(
  plaintext: string,
  p256dhB64: string,
  authB64: string,
): Promise<Uint8Array> {
  const userPub = b64urlDecode(p256dhB64); // 65 bytes uncompressed
  const authSecret = b64urlDecode(authB64);

  // 1. Ephemeral ECDH key pair
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const ephemeralPubRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", ephemeral.publicKey),
  );

  // 2. Import user's public key
  const userPubKey = await crypto.subtle.importKey(
    "raw",
    userPub,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  // 3. ECDH shared secret
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: userPubKey },
      ephemeral.privateKey,
      256,
    ),
  );

  // 4. PRK_key = HKDF(authSecret, shared, "WebPush: info\0" || ua_pub || as_pub, 32)
  const keyInfo = concat(
    new TextEncoder().encode("WebPush: info\0"),
    userPub,
    ephemeralPubRaw,
  );
  const prkKey = await hkdf(authSecret, shared, keyInfo, 32);

  // 5. Salt (16 bytes random)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 6. CEK = HKDF(salt, prkKey, "Content-Encoding: aes128gcm\0", 16)
  const cek = await hkdf(
    salt,
    prkKey,
    new TextEncoder().encode("Content-Encoding: aes128gcm\0"),
    16,
  );

  // 7. Nonce = HKDF(salt, prkKey, "Content-Encoding: nonce\0", 12)
  const nonce = await hkdf(
    salt,
    prkKey,
    new TextEncoder().encode("Content-Encoding: nonce\0"),
    12,
  );

  // 8. Plaintext padded: data || 0x02 || 0x00 * padLen  (we use no extra padding)
  const plain = concat(new TextEncoder().encode(plaintext), new Uint8Array([0x02]));

  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, plain),
  );

  // 9. Build aes128gcm header: salt(16) || rs(4=4096) || idlen(1) || keyid(idlen)
  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
  const header = concat(
    salt,
    rs,
    new Uint8Array([ephemeralPubRaw.length]),
    ephemeralPubRaw,
  );

  return concat(header, ciphertext);
}