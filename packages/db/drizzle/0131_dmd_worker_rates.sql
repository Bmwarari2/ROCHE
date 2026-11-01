-- The dm+d download (integrations.md section 11, "Release download"; slice 75; HZ-113). The
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
