import { createServerFn } from "@tanstack/react-start";
import { setCookie, getCookie, deleteCookie } from "@tanstack/react-start/server";

/**
 * Schwab OAuth helpers.
 * Requires SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET as runtime secrets.
 * Callback URL registered with Schwab must match the one passed in here exactly.
 */

const AUTHORIZE_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const STATE_COOKIE = "schwab_oauth_state";

export type SchwabTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  obtained_at: number;
};

export const getSchwabAuthUrl = createServerFn({ method: "POST" })
  .inputValidator((d: { redirectUri: string }) => d)
  .handler(async ({ data }) => {
    const clientId = process.env.SCHWAB_CLIENT_ID;
    if (!clientId) throw new Error("SCHWAB_CLIENT_ID is not configured");
    const state = crypto.randomUUID();
    setCookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 10,
    });
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", data.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return { url: url.toString() };
  });

export const exchangeSchwabCode = createServerFn({ method: "POST" })
  .inputValidator((d: { code: string; redirectUri: string; state: string }) => d)
  .handler(async ({ data }): Promise<SchwabTokens> => {
    const expected = getCookie(STATE_COOKIE);
    if (!expected || !data.state || expected !== data.state) {
      throw new Error("Invalid OAuth state — possible CSRF. Please retry sign-in.");
    }
    deleteCookie(STATE_COOKIE, { path: "/" });
    const clientId = process.env.SCHWAB_CLIENT_ID;
    const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("Schwab credentials not configured");

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: data.code,
      redirect_uri: data.redirectUri,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Schwab token exchange failed (${res.status}): ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    return { ...json, obtained_at: Date.now() };
  });

export const refreshSchwabToken = createServerFn({ method: "POST" })
  .inputValidator((d: { refreshToken: string }) => d)
  .handler(async ({ data }): Promise<SchwabTokens> => {
    const clientId = process.env.SCHWAB_CLIENT_ID;
    const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("Schwab credentials not configured");
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: data.refreshToken,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Schwab token refresh failed (${res.status}): ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    return { ...json, obtained_at: Date.now() };
  });