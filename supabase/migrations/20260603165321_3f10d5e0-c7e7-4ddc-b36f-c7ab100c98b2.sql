-- Explicitly block client-side writes to subscriptions. Service role bypasses RLS,
-- so webhooks/admin code continue to work. Authenticated users can still SELECT
-- their own row (existing policy).
CREATE POLICY "No client inserts on subscriptions"
  ON public.subscriptions FOR INSERT TO authenticated, anon
  WITH CHECK (false);

CREATE POLICY "No client updates on subscriptions"
  ON public.subscriptions FOR UPDATE TO authenticated, anon
  USING (false) WITH CHECK (false);

CREATE POLICY "No client deletes on subscriptions"
  ON public.subscriptions FOR DELETE TO authenticated, anon
  USING (false);