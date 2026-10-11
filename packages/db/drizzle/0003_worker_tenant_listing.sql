-- The worker lists active tenants (identifier and status only) so scheduled jobs can then act inside
-- each tenant's row-level security context as the application role.
GRANT SELECT (id, status) ON public.tenant TO harbour_worker;
--> statement-breakpoint
CREATE POLICY worker_tenant_listing ON public.tenant AS PERMISSIVE FOR SELECT TO harbour_worker
  USING (true);
