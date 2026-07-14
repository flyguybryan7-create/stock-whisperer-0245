import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { exchangeSchwabCode } from "@/lib/schwab.functions";
import { setOwnerSchwabTokens, setSharedSchwabTokensPublic } from "@/lib/schwab-shared.functions";

export const SCHWAB_TOKEN_KEY = "bryantrade.schwab.tokens.v1";
export const SCHWAB_CONNECTED_FLAG = "bryantrade.schwab.connected.v1";

export const Route = createFileRoute("/auth/schwab/callback")({
  component: SchwabCallback,
});

function SchwabCallback() {
  const navigate = useNavigate();
  const exchange = useServerFn(exchangeSchwabCode);
  const persistOwner = useServerFn(setOwnerSchwabTokens);
  const persistSharedPublic = useServerFn(setSharedSchwabTokensPublic);
  const [status, setStatus] = useState("Completing Schwab sign-in…");
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const err = params.get("error");
    if (err) { setStatus(`Schwab error: ${err}`); setFailed(true); return; }
    if (!code) { setStatus("Missing authorization code."); setFailed(true); return; }
    if (!state) { setStatus("Missing OAuth state."); setFailed(true); return; }
    const redirectUri = `${window.location.origin}/auth/schwab/callback`;
    exchange({ data: { code, redirectUri, state } })
      .then((tokens) => {
        // Persist tokens to localStorage so closing the Schwab tab and coming
        // back to BryanTrade keeps the connection alive (sessionStorage was
        // dropping the token when the user X-ed the OAuth tab).
        try { localStorage.setItem(SCHWAB_TOKEN_KEY, JSON.stringify(tokens)); } catch {}
        try { sessionStorage.setItem(SCHWAB_TOKEN_KEY, JSON.stringify(tokens)); } catch {}
        try { localStorage.setItem(SCHWAB_CONNECTED_FLAG, "1"); } catch {}
        // Best-effort: persist tokens to the shared owner row so every viewer
        // (including signed-out share-link viewers) sees live Schwab quotes.
        // Requires the caller to be signed into Lovable; safe to ignore failures.
        const payload = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresIn: tokens.expires_in,
          scope: tokens.scope,
          tokenType: tokens.token_type,
        };
        // Always persist to the public shared-owner row so the OptionsFlow /
        // shared Schwab feed keeps working across sessions and devices even
        // when nobody is signed into BryanTrade.
        persistSharedPublic({ data: payload })
          .then(() => console.info("[schwab] public shared owner token persisted"))
          .catch((e) => console.warn("[schwab] could not persist public shared token", e));
        // Additionally persist per-user if the caller is signed into BryanTrade.
        persistOwner({ data: payload })
          .then(() => console.info("[schwab] per-user owner token persisted"))
          .catch((e) => console.warn("[schwab] could not persist per-user owner token", e));
        setStatus("✅ Schwab connected — redirecting…");
        setDone(true);
        setTimeout(() => navigate({ to: "/" }), 800);
      })
      .catch((e) => {
        setStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`);
        setFailed(true);
      });
  }, [exchange, persistOwner, persistSharedPublic, navigate]);

  return (
    <div style={{ minHeight: "100vh", background: "#0d1117", color: "#e6edf3", display: "grid", placeItems: "center", fontFamily: "monospace" }}>
      <div style={{ padding: 24, border: "1px solid #21262d", borderRadius: 8, background: "#161b22", maxWidth: 480 }}>
        <div style={{ fontSize: 12, color: "#8b949e", letterSpacing: 1.5, marginBottom: 8 }}>SCHWAB OAUTH</div>
        <div style={{ fontSize: 16, marginBottom: 16 }}>{status}</div>
        {(done || failed) && (
          <a
            href="/"
            style={{
              display: "inline-block",
              padding: "10px 16px",
              background: failed ? "#21262d" : "#238636",
              color: "#fff",
              borderRadius: 6,
              textDecoration: "none",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            ← Return to BryanTrade
          </a>
        )}
      </div>
    </div>
  );
}