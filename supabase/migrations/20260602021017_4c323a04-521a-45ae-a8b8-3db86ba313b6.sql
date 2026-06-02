-- push_subscriptions is only accessed server-side via service_role (which bypasses RLS).
-- Add an explicit deny-all policy so the linter sees that client roles have no access.
CREATE POLICY "No client access to push subscriptions"
ON public.push_subscriptions
AS RESTRICTIVE
FOR ALL
TO anon, authenticated
USING (false)
WITH CHECK (false);

-- Revoke any default table privileges from client roles for clarity.
REVOKE ALL ON public.push_subscriptions FROM anon, authenticated;
GRANT ALL ON public.push_subscriptions TO service_role;