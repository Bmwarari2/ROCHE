CREATE TABLE "staff_line_manager" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"worker_id" uuid NOT NULL,
	"manager_id" uuid NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "staff_line_manager_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_line_manager_not_self" CHECK (manager_id <> worker_id),
	CONSTRAINT "staff_line_manager_dates" CHECK (valid_to IS NULL OR valid_to > valid_from)
);
--> statement-breakpoint
CREATE TABLE "staff_team" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"name" text NOT NULL,
	"location_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "staff_team_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_team_name" CHECK (length(btrim(name)) BETWEEN 2 AND 120)
);
--> statement-breakpoint
CREATE TABLE "staff_team_member" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"team_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"is_lead" boolean DEFAULT false NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "staff_team_member_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_team_member_dates" CHECK (valid_to IS NULL OR valid_to > valid_from)
);
--> statement-breakpoint
ALTER TABLE "staff_line_manager" ADD CONSTRAINT "staff_line_manager_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_line_manager" ADD CONSTRAINT "staff_line_manager_manager_fk" FOREIGN KEY ("tenant_id","manager_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_team" ADD CONSTRAINT "staff_team_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_team_member" ADD CONSTRAINT "staff_team_member_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "public"."staff_team"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_team_member" ADD CONSTRAINT "staff_team_member_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_line_manager_manager_idx" ON "staff_line_manager" USING btree ("tenant_id","manager_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_line_manager_current_key" ON "staff_line_manager" USING btree ("tenant_id","worker_id") WHERE valid_to IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_team_name_key" ON "staff_team" USING btree ("tenant_id",lower("name")) WHERE archived_at IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "staff_team_member_member_idx" ON "staff_team_member" USING btree ("tenant_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_team_member_current_key" ON "staff_team_member" USING btree ("tenant_id","team_id","member_id") WHERE valid_to IS NULL AND deleted_at IS NULL;--> statement-breakpoint

-- Reporting lines (ADR-0137, provisional; amends ADR-0136): who line manages whom, and staff teams
-- with their leads, kept with history. Maintained by organisation-wide holders of
-- workforce.staff_file.manage (HR). Read by HR, by the members a row is about, and by holders of a
-- development read permission whose scope covers the member. A line manager's current direct reports
-- and a team lead's current team widen the scope of the development permissions they already hold;
-- the relationship grants nothing by itself (least privilege). Runs as harbour_owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_line_manager', 'staff_team', 'staff_team_member'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
    EXECUTE format(
      'CREATE POLICY reporting_line_insert ON public.%I AS RESTRICTIVE FOR INSERT TO harbour_app '
      'WITH CHECK (app.is_system() OR app.holds_staff_permission_everywhere(''workforce.staff_file.manage''))', t);
    EXECUTE format(
      'CREATE POLICY reporting_line_update ON public.%I AS RESTRICTIVE FOR UPDATE TO harbour_app '
      'USING (app.is_system() OR app.holds_staff_permission_everywhere(''workforce.staff_file.manage'')) '
      'WITH CHECK (app.is_system() OR app.holds_staff_permission_everywhere(''workforce.staff_file.manage''))', t);
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE POLICY reporting_line_read ON public.staff_line_manager AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (app.is_system() OR worker_id = app.current_user_id() OR manager_id = app.current_user_id()
    OR app.holds_staff_permission_everywhere('workforce.staff_file.manage')
    OR app.reads_development_of(worker_id));
--> statement-breakpoint
CREATE POLICY reporting_line_read ON public.staff_team_member AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (app.is_system() OR member_id = app.current_user_id()
    OR app.holds_staff_permission_everywhere('workforce.staff_file.manage')
    OR app.reads_development_of(member_id));
--> statement-breakpoint
-- A team's name and home are not about a person: readable by anyone who reads development records
-- somewhere, or maintains reporting lines.
CREATE POLICY reporting_line_read ON public.staff_team AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.is_system() OR app.reads_development()
    OR app.holds_staff_permission('workforce.staff_file.manage'));
--> statement-breakpoint
-- A line or membership keeps who and what it is about and when it started; only its end, a team's
-- name, home and archiving, and a membership's lead flag change.
CREATE OR REPLACE FUNCTION app.reporting_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'staff_line_manager' THEN
    IF (NEW.worker_id, NEW.manager_id, NEW.valid_from)
       IS DISTINCT FROM (OLD.worker_id, OLD.manager_id, OLD.valid_from) THEN
      RAISE EXCEPTION 'A line keeps its member, manager and start' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'staff_team_member' THEN
    IF (NEW.team_id, NEW.member_id, NEW.valid_from)
       IS DISTINCT FROM (OLD.team_id, OLD.member_id, OLD.valid_from) THEN
      RAISE EXCEPTION 'A membership keeps its team, member and start' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_TABLE_NAME <> 'staff_team' AND OLD.valid_to IS NOT NULL
     AND NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
    RAISE EXCEPTION 'An ended line or membership stays ended' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER reporting_line_guard BEFORE UPDATE ON public.staff_line_manager
  FOR EACH ROW EXECUTE FUNCTION app.reporting_line_guard();
--> statement-breakpoint
CREATE TRIGGER reporting_line_guard BEFORE UPDATE ON public.staff_team_member
  FOR EACH ROW EXECUTE FUNCTION app.reporting_line_guard();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.staff_line_manager, public.staff_team, public.staff_team_member
  TO harbour_app;
--> statement-breakpoint
GRANT SELECT ON public.staff_line_manager, public.staff_team, public.staff_team_member
  TO harbour_workforce_definer;
--> statement-breakpoint
-- Earlier versions follow the rows' own read rule.
CREATE POLICY record_version_reporting_lines ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (table_name NOT IN ('staff_line_manager', 'staff_team_member')
    OR app.is_system()
    OR app.holds_staff_permission_everywhere('workforce.staff_file.manage')
    OR app.reads_development_of(COALESCE(data->>'worker_id', data->>'member_id')::uuid));
--> statement-breakpoint

-- Development scope (ADR-0136, amended by ADR-0137): as migration 0161, and also, for a reader who
-- holds one of the permissions in any role in force or access grant, their current direct reports
-- and the current members of the teams they currently lead. One set-based query. Replaced as its
-- owner, so its ACL stays as 0161 set it.
GRANT CREATE ON SCHEMA app TO harbour_workforce_definer;
--> statement-breakpoint
SET ROLE harbour_workforce_definer;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.development_scope_members_for(p_reader uuid, p_permissions text[],
  p_workers uuid[])
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH reader_roles AS (
    SELECT ra.location_id, ra.organisation_wide, r.scope_kind::text AS scope
    FROM public.role_assignment ra
    JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
    WHERE ra.tenant_id = app.current_tenant_id()
      AND ra.tenant_user_id = p_reader
      AND ra.deleted_at IS NULL
      AND r.archived_at IS NULL
      AND ra.valid_from <= now()
      AND (ra.valid_to IS NULL OR ra.valid_to > now())
      AND NOT (r.permissions && ARRAY['comms.portal.family', 'comms.portal.self', 'comms.feed.read',
        'comms.notification.subscribe', 'comms.visit_booking.request']::text[])
      AND r.permissions && p_permissions
  ),
  reader_grants AS (
    SELECT g.location_id, g.organisation_wide
    FROM public.access_grant g
    WHERE g.tenant_id = app.current_tenant_id()
      AND g.tenant_user_id = p_reader
      AND g.deleted_at IS NULL
      AND g.revoked_at IS NULL
      AND g.valid_from <= now()
      AND g.valid_to > now()
      AND g.permissions && p_permissions
  ),
  everywhere AS (
    SELECT EXISTS (SELECT 1 FROM reader_roles
                   WHERE scope = 'none'
                      OR (location_id IS NULL AND scope IN ('tenant', 'location')
                          AND (scope = 'tenant' OR organisation_wide)))
        OR EXISTS (SELECT 1 FROM reader_grants WHERE location_id IS NULL AND organisation_wide)
      AS yes
  ),
  homes AS (
    SELECT location_id FROM reader_roles
     WHERE scope IN ('tenant', 'location') AND location_id IS NOT NULL
    UNION
    SELECT location_id FROM reader_grants WHERE location_id IS NOT NULL
  ),
  today AS (SELECT (now() AT TIME ZONE 'Europe/London')::date AS d),
  -- Reporting lines widen a holder's scope; they never grant a permission (ADR-0137).
  related AS (
    SELECT lm.worker_id AS member
    FROM public.staff_line_manager lm, today
    WHERE lm.tenant_id = app.current_tenant_id()
      AND lm.manager_id = p_reader
      AND lm.deleted_at IS NULL
      AND lm.valid_from <= today.d
      AND (lm.valid_to IS NULL OR lm.valid_to > today.d)
    UNION
    SELECT m.member_id
    FROM public.staff_team_member lead
    JOIN public.staff_team t ON t.tenant_id = lead.tenant_id AND t.id = lead.team_id
    JOIN public.staff_team_member m ON m.tenant_id = lead.tenant_id AND m.team_id = lead.team_id
    CROSS JOIN today
    WHERE lead.tenant_id = app.current_tenant_id()
      AND lead.member_id = p_reader
      AND lead.is_lead
      AND lead.deleted_at IS NULL
      AND lead.valid_from <= today.d
      AND (lead.valid_to IS NULL OR lead.valid_to > today.d)
      AND t.archived_at IS NULL
      AND t.deleted_at IS NULL
      AND m.deleted_at IS NULL
      AND m.member_id <> p_reader
      AND m.valid_from <= today.d
      AND (m.valid_to IS NULL OR m.valid_to > today.d)
  ),
  holds AS (
    SELECT EXISTS (SELECT 1 FROM reader_roles) OR EXISTS (SELECT 1 FROM reader_grants) AS yes
  )
  SELECT tu.id
  FROM public.tenant_user tu
  WHERE p_reader IS NOT NULL
    AND tu.tenant_id = app.current_tenant_id()
    AND tu.id = ANY (p_workers)
    AND ((SELECT yes FROM everywhere)
      OR ((SELECT yes FROM holds) AND tu.id IN (SELECT member FROM related))
      OR (EXISTS (SELECT 1 FROM homes) AND (
        EXISTS (
          SELECT 1
          FROM public.role_assignment wa
          JOIN public.role wr ON wr.id = wa.role_id AND wr.tenant_id = wa.tenant_id
          WHERE wa.tenant_id = tu.tenant_id
            AND wa.tenant_user_id = tu.id
            AND wa.deleted_at IS NULL
            AND wr.archived_at IS NULL
            AND wa.valid_from <= now()
            AND (wa.valid_to IS NULL OR wa.valid_to > now())
            AND (wa.location_id IN (SELECT location_id FROM homes)
              OR (wa.location_id IS NULL AND (wr.scope_kind = 'tenant' OR wa.organisation_wide))))
        OR EXISTS (
          SELECT 1
          FROM public.staff_profile sp
          WHERE sp.tenant_id = tu.tenant_id
            AND sp.tenant_user_id = tu.id
            AND sp.deleted_at IS NULL
            AND sp.location_id IN (SELECT location_id FROM homes)))))
$$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_workforce_definer;
