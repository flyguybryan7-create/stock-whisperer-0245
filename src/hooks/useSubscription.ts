import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getStripeEnvironment } from "@/lib/stripe";

export type Subscription = {
  id: string;
  status: string;
  price_id: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  stripe_customer_id: string;
};

const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export function useSubscription(userId: string | null | undefined) {
  const [sub, setSub] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setSub(null);
      setLoading(false);
      return;
    }
    const env = (() => { try { return getStripeEnvironment(); } catch { return "sandbox" as const; } })();

    const fetchSub = async () => {
      const { data } = await supabase
        .from("subscriptions")
        .select("id,status,price_id,current_period_end,cancel_at_period_end,stripe_customer_id")
        .eq("user_id", userId)
        .eq("environment", env)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) {
        setSub((data as unknown as Subscription) ?? null);
        setLoading(false);
      }
    };

    fetchSub();
    const channel = supabase
      .channel(`subs:${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "subscriptions", filter: `user_id=eq.${userId}` }, () => {
        fetchSub();
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const isActive = !!sub && (
    (ACTIVE_STATUSES.has(sub.status) && (!sub.current_period_end || new Date(sub.current_period_end) > new Date())) ||
    (sub.status === "canceled" && !!sub.current_period_end && new Date(sub.current_period_end) > new Date())
  );
  const tier: "none" | "basic" | "pro" = !isActive
    ? "none"
    : sub?.price_id === "pro_monthly"
      ? "pro"
      : sub?.price_id === "basic_monthly"
        ? "basic"
        : "none";

  return { subscription: sub, loading, isActive, tier };
}