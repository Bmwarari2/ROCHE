-- The dm+d download (integrations.md section 11, "Release download"; slice 75; HZ-113).
--
-- 1. The load runs as its own job, which parses an archive fetched from the internet, so it gets a
-- role of its own, harbour_dmd_job (created by db:bootstrap), that may call the loader's functions
-- and read the dm+d tables and nothing else; the worker, which reads every organisation's outbox
-- and notifications, no longer calls the loader (security review of slice 75, H1).

GRANT USAGE ON SCHEMA public, app TO harbour_dmd_job;
--> statement-breakpoint
GRANT SELECT ON public.dmd_release, public.dmd_lookup, public.dmd_vtm, public.dmd_vmp,
  public.dmd_amp, public.dmd_vmpp, public.dmd_ampp, public.dmd_gtin TO harbour_dmd_job;
--> statement-breakpoint
GRANT SELECT ON app.database_environment TO harbour_dmd_job;
--> statement-breakpoint
-- The loader's functions are owned by harbour_dmd_loader, so only that role can change who runs
-- them (harbour_owner may SET ROLE to it, never inherit it; ADR-0002).
SET LOCAL ROLE harbour_dmd_loader;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.dmd_begin_release(text, date, text, text, jsonb),
  app.dmd_load_rows(uuid, text, jsonb), app.dmd_finish_release(uuid),
  app.dmd_record_refusal(text, date, text, text, text, jsonb, jsonb, integer) FROM harbour_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.dmd_begin_release(text, date, text, text, jsonb),
  app.dmd_load_rows(uuid, text, jsonb), app.dmd_finish_release(uuid),
  app.dmd_record_refusal(text, date, text, text, text, jsonb, jsonb, integer) TO harbour_dmd_job;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint

-- 2. The
-- worker's daily check says when the dm+d release in use is older than
-- medicines.dmd.stale_after_days, so it reads that figure from the rate table, as the screens do.
-- It may read the national rows only: the read policy (0002) already hides organisations' rows
-- from a session without a tenant, and the restrictive policy below keeps the worker to them
-- whatever it sets.

GRANT SELECT ON public.rate_table TO harbour_worker;
--> statement-breakpoint
CREATE POLICY rate_table_worker_national ON public.rate_table AS RESTRICTIVE FOR SELECT
  TO harbour_worker
  USING (tenant_id IS NULL);
