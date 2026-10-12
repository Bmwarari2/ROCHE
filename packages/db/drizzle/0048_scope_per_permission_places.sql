-- Data scope per permission, review round 1 (ADR-0071; L1 and L2): a grant or a location role
-- with no location reaches the whole organisation only when it says so. Existing rows keep their
-- meaning: a grant with no location, and a location role assigned with no location, are marked
-- organisation-wide (each change a new version, in its tenant's context) before the checks are
-- added; from now on a missing location without the mark is refused (the grant by its check, the
-- location role by the trigger in 0049). Runs as harbour_owner.
ALTER TABLE "access_grant" ADD COLUMN "organisation_wide" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "role_assignment" ADD COLUMN "organisation_wide" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE public.access_grant NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.role_assignment NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  -- The tenants with a row to mark; `role` is read inside the loop, under each tenant's policy.
  FOR t IN
    SELECT tenant_id FROM public.access_grant WHERE location_id IS NULL
    UNION
    SELECT tenant_id FROM public.role_assignment WHERE location_id IS NULL
    ORDER BY 1
  LOOP
    -- record_version rows are written by the versioning trigger under the tenant's policy.
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    UPDATE public.access_grant SET organisation_wide = true
      WHERE tenant_id = t AND location_id IS NULL AND NOT organisation_wide;
    UPDATE public.role_assignment ra SET organisation_wide = true
      FROM public.role r
      WHERE ra.tenant_id = t AND r.tenant_id = t AND r.id = ra.role_id
        AND ra.location_id IS NULL AND r.scope_kind = 'location' AND NOT ra.organisation_wide;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;--> statement-breakpoint
ALTER TABLE public.access_grant FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.role_assignment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_place" CHECK (("access_grant"."location_id" IS NULL) = "access_grant"."organisation_wide");--> statement-breakpoint
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_organisation_wide" CHECK (NOT "role_assignment"."organisation_wide" OR "role_assignment"."location_id" IS NULL);
