import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { StripeEmbeddedCheckout } from "@/components/StripeEmbeddedCheckout";
import { PaymentTestModeBanner } from "@/components/PaymentTestModeBanner";
import { useAuthUser } from "@/hooks/useAuthUser";
import { useSubscription } from "@/hooks/useSubscription";
import { createPortalSession } from "@/utils/payments.functions";
import { getStripeEnvironment } from "@/lib/stripe";
import { useServerFn } from "@tanstack/react-start";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing — BryanTrade Pro Terminal" },
      { name: "description", content: "Pick a plan: Basic for buy/sell signals or Pro for buy/sell + day-trade signals." },
    ],
  }),
  component: PricingPage,
});

type Plan = { id: "basic_monthly" | "pro_monthly"; name: string; price: string; features: string[] };

const PLANS: Plan[] = [
  { id: "basic_monthly", name: "Basic", price: "$9/mo", features: ["Buy / Sell signals", "Watchlist", "News & charts"] },
  { id: "pro_monthly", name: "Pro", price: "$29/mo", features: ["Everything in Basic", "Day-trade signals", "Real-time alerts"] },
];

function PricingPage() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuthUser();
  const { subscription, tier, loading: subLoading } = useSubscription(user?.id);
  const [openPriceId, setOpenPriceId] = useState<string | null>(null);
  const portalFn = useServerFn(createPortalSession);
  const [portalError, setPortalError] = useState<string | null>(null);

  const openPortal = async () => {
    setPortalError(null);
    try {
      const result = await portalFn({ data: { environment: getStripeEnvironment(), returnUrl: window.location.href } });
      if ("error" in result) throw new Error(result.error);
      window.open(result.url, "_blank");
    } catch (e) {
      setPortalError(e instanceof Error ? e.message : "Could not open portal");
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <PaymentTestModeBanner />
      <div className="mx-auto max-w-5xl px-4 py-10">
        <div className="mb-8 flex items-center justify-between">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">← Terminal</Link>
          <div className="text-sm text-muted-foreground">
            {authLoading ? null : user ? (
              <span>{user.email} · <button onClick={async () => { await import("@/integrations/supabase/client").then(m => m.supabase.auth.signOut()); navigate({ to: "/" }); }} className="underline">Sign out</button></span>
            ) : (
              <Link to="/auth" className="underline">Sign in</Link>
            )}
          </div>
        </div>

        <h1 className="text-4xl font-bold text-foreground">Choose your plan</h1>
        <p className="mt-2 text-muted-foreground">Cancel anytime. Access stays active until the end of your paid period.</p>

        {!subLoading && subscription && (
          <div className="mt-6 rounded border border-border bg-card p-4 text-sm">
            <div className="font-medium text-foreground">
              Current plan: <span className="capitalize">{tier}</span> · status <span className="capitalize">{subscription.status}</span>
              {subscription.cancel_at_period_end && subscription.current_period_end && (
                <span className="ml-2 text-orange-500">ends {new Date(subscription.current_period_end).toLocaleDateString()}</span>
              )}
            </div>
            <button onClick={openPortal} className="mt-2 rounded bg-secondary px-3 py-1 text-secondary-foreground hover:opacity-90">
              Manage billing
            </button>
            {portalError && <p className="mt-2 text-red-500">{portalError}</p>}
          </div>
        )}

        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {PLANS.map((plan) => {
            const isCurrent = tier !== "none" && (
              (plan.id === "basic_monthly" && tier === "basic") ||
              (plan.id === "pro_monthly" && tier === "pro")
            );
            return (
              <div key={plan.id} className="flex flex-col rounded-xl border border-border bg-card p-6">
                <h2 className="text-2xl font-semibold text-foreground">{plan.name}</h2>
                <div className="mt-1 text-3xl font-bold text-foreground">{plan.price}</div>
                <ul className="mt-4 flex-1 space-y-2 text-sm text-muted-foreground">
                  {plan.features.map((f) => <li key={f}>✓ {f}</li>)}
                </ul>
                {!user ? (
                  <Link to="/auth" className="mt-6 rounded bg-primary px-4 py-2 text-center font-medium text-primary-foreground hover:bg-primary/90">
                    Sign in to subscribe
                  </Link>
                ) : isCurrent ? (
                  <button disabled className="mt-6 rounded bg-secondary px-4 py-2 font-medium text-secondary-foreground opacity-60">
                    Current plan
                  </button>
                ) : subscription ? (
                  <button onClick={openPortal}
                    className="mt-6 rounded bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90">
                    Switch to {plan.name} in billing portal
                  </button>
                ) : (
                  <button onClick={() => setOpenPriceId(plan.id)}
                    className="mt-6 rounded bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90">
                    Subscribe
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {openPriceId && user && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-2xl rounded-lg bg-background shadow-xl">
              <div className="flex items-center justify-between border-b border-border p-3">
                <h3 className="font-medium text-foreground">Checkout</h3>
                <button onClick={() => setOpenPriceId(null)} className="text-muted-foreground hover:text-foreground">✕</button>
              </div>
              <div className="max-h-[80vh] overflow-y-auto p-4">
                <StripeEmbeddedCheckout
                  priceId={openPriceId}
                  customerEmail={user.email}
                  returnUrl={`${window.location.origin}/checkout/return?session_id={CHECKOUT_SESSION_ID}`}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}