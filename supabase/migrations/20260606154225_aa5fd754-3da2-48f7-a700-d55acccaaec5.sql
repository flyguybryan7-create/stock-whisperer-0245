
CREATE TABLE public.pushover_alert_state (
  symbol TEXT PRIMARY KEY,
  last_price_alert_bucket TEXT,
  last_news_pubdate TIMESTAMPTZ,
  last_news_guid TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.pushover_alert_state TO service_role;
ALTER TABLE public.pushover_alert_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "no client access" ON public.pushover_alert_state AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
