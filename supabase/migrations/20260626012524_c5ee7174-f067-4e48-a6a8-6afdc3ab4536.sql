CREATE TABLE public.schwab_owner_tokens (
  user_id uuid NOT NULL PRIMARY KEY,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  obtained_at timestamptz NOT NULL DEFAULT now(),
  scope text,
  token_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.schwab_owner_tokens TO authenticated;
GRANT ALL ON public.schwab_owner_tokens TO service_role;

ALTER TABLE public.schwab_owner_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner can read own schwab tokens"
  ON public.schwab_owner_tokens FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Owner can insert own schwab tokens"
  ON public.schwab_owner_tokens FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Owner can update own schwab tokens"
  ON public.schwab_owner_tokens FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Owner can delete own schwab tokens"
  ON public.schwab_owner_tokens FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_schwab_owner_tokens_updated_at
  BEFORE UPDATE ON public.schwab_owner_tokens
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();