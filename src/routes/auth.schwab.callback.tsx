import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { exchangeSchwabCode } from "@/lib/schwab.functions";

export const SCHWAB_TOKEN_KEY = "bryantrade.schwab.tokens.v1";

export const Route = createFileRoute("/auth/schwab/callback")({
  component: SchwabCallback,
});

function SchwabCallback() {
  const navigate = useNavigate();
  const exchange = useServerFn(exchangeSchwabCode);
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
        localStorage.setItem(SCHWAB_TOKEN_KEY, JSON.stringify(tokens));
        setStatus("Connected! Redirecting…");
        setTimeout(() => navigate({ to: "/" }), 800);
      })
      .catch((e) => setStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`));
  }, [exchange, navigate]);

  return (
    <div style={{ minHeight: "100vh", background: "#0d1117", color: "#e6edf3", display: "grid", placeItems: "center", fontFamily: "monospace" }}>
      <div style={{ padding: 24, border: "1px solid #21262d", borderRadius: 8, background: "#161b22", maxWidth: 480 }}>
        <div style={{ fontSize: 12, color: "#8b949e", letterSpacing: 1.5, marginBottom: 8 }}>SCHWAB OAUTH</div>
        <div style={{ fontSize: 16 }}>{status}</div>
      </div>
    </div>
  );
}