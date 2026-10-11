-- Bank holidays are national facts (docs/specs/calendar.md): readable by every role, maintained
-- only by the owner role from the seed. Runs as harbour_owner.

ALTER TABLE public.bank_holiday ADD CONSTRAINT bank_holiday_nation
  CHECK (nation IN ('england', 'wales', 'scotland', 'northern_ireland'));
--> statement-breakpoint
ALTER TABLE public.bank_holiday ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.bank_holiday FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY national_read ON public.bank_holiday AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
--> statement-breakpoint
CREATE POLICY owner_maintenance ON public.bank_holiday AS PERMISSIVE FOR ALL TO harbour_owner
  USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.bank_holiday FROM harbour_app;
--> statement-breakpoint
GRANT SELECT ON public.bank_holiday TO harbour_app, harbour_worker;
