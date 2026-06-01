import { createServerFn } from "@tanstack/react-start";

/**
 * Schwab OAuth helpers.
 * Requires SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET as runtime secrets.
 * Callback URL registered with Schwab must match the one passed in here exactly.
 */

const AUTHORIZE_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";

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
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", data.redirectUri);
    url.searchParams.set("response_type", "code");
    return { url: url.toString() };
  });

export const exchangeSchwabCode = createServerFn({ method: "POST" })
  .inputValidator((d: { code: string; redirectUri: string }) => d)
  .handler(async ({ data }): Promise<SchwabTokens> => {
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