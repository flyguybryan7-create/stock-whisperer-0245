import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth")({
  head: () => ({ meta: [{ title: "Sign in — BryanTrade" }] }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setInfo(null); setLoading(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email, password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        setInfo("Check your email to confirm your account, then sign in.");
        setMode("signin");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate({ to: "/pricing" });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auth failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow">
        <h1 className="text-2xl font-bold text-foreground">
          {mode === "signin" ? "Sign in" : "Create account"}
        </h1>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="Email" className="w-full rounded border border-border bg-background px-3 py-2 text-foreground" />
        <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder="Password" className="w-full rounded border border-border bg-background px-3 py-2 text-foreground" />
        {error && <p className="text-sm text-red-500">{error}</p>}
        {info && <p className="text-sm text-green-500">{info}</p>}
        <button type="submit" disabled={loading}
          className="w-full rounded bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {loading ? "..." : mode === "signin" ? "Sign in" : "Sign up"}
        </button>
        <button type="button" onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(null); setInfo(null); }}
          className="w-full text-sm text-muted-foreground hover:text-foreground">
          {mode === "signin" ? "Don't have an account? Sign up" : "Have an account? Sign in"}
        </button>
        <Link to="/" className="block text-center text-xs text-muted-foreground hover:text-foreground">Back to terminal</Link>
      </form>
    </div>
  );
}