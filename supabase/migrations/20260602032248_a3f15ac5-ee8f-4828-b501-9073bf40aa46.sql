CREATE TABLE public.watchlists (
  user_id UUID NOT NULL PRIMARY KEY,
  symbols TEXT[] NOT NULL DEFAULT '{}',
  names JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.watchlists TO authenticated;
GRANT ALL ON public.watchlists TO service_role;

ALTER TABLE public.watchlists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own watchlist" ON public.watchlists FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own watchlist" ON public.watchlists FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own watchlist" ON public.watchlists FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users delete own watchlist" ON public.watchlists FOR DELETE USING (auth.uid() = user_id);