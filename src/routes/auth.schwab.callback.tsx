import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { exchangeSchwabCode } from "@/lib/schwab.functions";
import { setOwnerSchwabTokens } from "@/lib/schwab-shared.functions";

export const SCHWAB_TOKEN_KEY = "bryantrade.schwab.tokens.v1";

export const Route = createFileRoute("/auth/schwab/callback")({
  component: SchwabCallback,
});

function SchwabCallback() {
  const navigate = useNavigate();
  const exchange = useServerFn(exchangeSchwabCode);
  const persistOwner = useServerFn(setOwnerSchwabTokens);
  const [status, setStatus] = useState("Completing Schwab sign-in…");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const err = params.get("error");
    if (err) { setStatus(`Schwab error: ${err}`); return; }
    if (!code) { setStatus("Missing authorization code."); return; }
    if (!state) { setStatus("Missing OAuth state."); return; }
    const redirectUri = `${window.location.origin}/auth/schwab/callback`;
    exchange({ data: { code, redirectUri, state } })
      .then((tokens) => {
        // Use sessionStorage (cleared on tab close) to reduce XSS exposure window
        // for sensitive OAuth tokens.
        sessionStorage.setItem(SCHWAB_TOKEN_KEY, JSON.stringify(tokens));
        // Clean up any token previously written to localStorage.
        try { localStorage.removeItem(SCHWAB_TOKEN_KEY); } catch {}
        // Best-effort: persist tokens to the shared owner row so every viewer
        // (including signed-out share-link viewers) sees live Schwab quotes.
        // Requires the caller to be signed into Lovable; safe to ignore failures.
        persistOwner({ data: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresIn: tokens.expires_in,
          scope: tokens.scope,
          tokenType: tokens.token_type,
        }}).catch((e) => console.warn("[schwab] could not persist owner token", e));
        setStatus("Connected! Redirecting…");
        setTimeout(() => navigate({ to: "/" }), 800);
      })
      .catch((e) => setStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`));
  }, [exchange, persistOwner, navigate]);

  return (
    <div style={{ minHeight: "100vh", background: "#0d1117", color: "#e6edf3", display: "grid", placeItems: "center", fontFamily: "monospace" }}>
      <div style={{ padding: 24, border: "1px solid #21262d", borderRadius: 8, background: "#161b22", maxWidth: 480 }}>
        <div style={{ fontSize: 12, color: "#8b949e", letterSpacing: 1.5, marginBottom: 8 }}>SCHWAB OAUTH</div>
        <div style={{ fontSize: 16 }}>{status}</div>
      </div>
    </div>
  );
}