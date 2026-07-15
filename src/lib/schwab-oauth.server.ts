import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const SCHWAB_AUTHORIZE_URL = "https://api.schwabapi.com/v1/oauth/authorize";
export const SCHWAB_TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";

// Schwab requires the OAuth callback URL to match the developer-app setting
// exactly. The registered callback for this app is the dedicated route below.
const DEFAULT_SCHWAB_REDIRECT_URI = "https://stock-whisperer-0246.lovable.app/auth/schwab/callback";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const ALLOWED_RETURN_ORIGINS = new Set([
  "https://stock-whisperer-0246.lovable.app",
  "https://id-preview--326e5fc3-8819-4c6a-86d7-4a9b1b611b45.lovable.app",
]);

type SchwabStatePayload = {
  nonce: string;
  ts: number;
  returnOrigin: string | null;
};

function stateSecret(): string {
  const secret = process.env.SCHWAB_CLIENT_SECRET;
  if (!secret) throw new Error("SCHWAB_CLIENT_SECRET is not configured");
  return secret;
}

function sanitizeReturnOrigin(origin?: string): string | null {
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") return null;
    const normalized = parsed.origin;
    if (ALLOWED_RETURN_ORIGINS.has(normalized) || parsed.hostname === "localhost") return normalized;
  } catch {
    return null;
  }
  return null;
}

export function getSchwabRedirectUri(): string {
  const configured = process.env.SCHWAB_REDIRECT_URI;
  if (configured) return configured;
  return DEFAULT_SCHWAB_REDIRECT_URI;
}

export function signSchwabState(returnOrigin?: string): string {
  const payload: SchwabStatePayload = {
    nonce: randomUUID(),
    ts: Date.now(),
    returnOrigin: sanitizeReturnOrigin(returnOrigin),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", stateSecret()).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${sig}`;
}

export function verifySchwabState(state: string): { ok: true; returnOrigin: string | null } | { ok: false } {
  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false };
  const [encodedPayload, sig] = parts;
  const expected = createHmac("sha256", stateSecret()).update(encodedPayload).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<SchwabStatePayload>;
    if (!Number.isFinite(payload.ts) || Date.now() - Number(payload.ts) > STATE_MAX_AGE_MS) return { ok: false };
    return { ok: true, returnOrigin: sanitizeReturnOrigin(payload.returnOrigin ?? undefined) };
  } catch {
    return { ok: false };
  }
}
