CREATE TABLE public.push_subscriptions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, DELETE ON public.push_subscriptions TO anon, authenticated;
GRANT ALL ON public.push_subscriptions TO service_role;

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Single-user personal app: allow anyone to subscribe/unsubscribe their own device.
CREATE POLICY "anyone can insert a subscription"
  ON public.push_subscriptions FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "anyone can delete by endpoint"
  ON public.push_subscriptions FOR DELETE TO anon, authenticated USING (true);

CREATE POLICY "anyone can read"
  ON public.push_subscriptions FOR SELECT TO anon, authenticated USING (true);
