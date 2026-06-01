DROP POLICY IF EXISTS "anyone can insert a subscription" ON public.push_subscriptions;
DROP POLICY IF EXISTS "anyone can delete by endpoint" ON public.push_subscriptions;
DROP POLICY IF EXISTS "anyone can read" ON public.push_subscriptions;

REVOKE SELECT, INSERT, DELETE ON public.push_subscriptions FROM anon, authenticated;
