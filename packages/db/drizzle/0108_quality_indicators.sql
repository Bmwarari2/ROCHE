CREATE TABLE "quality_indicator_target" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid,
	"indicator_key" text NOT NULL,
	"green" numeric NOT NULL,
	"amber" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "quality_indicator_target_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "quality_indicator_target_key" CHECK (indicator_key IN ('falls', 'pressure_ulcers', 'medication_errors', 'missed_visits', 'overdue_reviews', 'training_compliance', 'agency_hours', 'complaints', 'staff_turnover', 'incident_response')),
	CONSTRAINT "quality_indicator_target_values" CHECK (green >= 0 AND amber >= 0 AND green <= 1000000 AND amber <= 1000000),
	CONSTRAINT "quality_indicator_target_direction" CHECK (CASE WHEN indicator_key IN ('training_compliance', 'incident_response')
        THEN green >= amber ELSE green <= amber END)
);
--> statement-breakpoint
ALTER TABLE "quality_indicator_target" ADD CONSTRAINT "quality_indicator_target_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quality_indicator_target_location_key" ON "quality_indicator_target" USING btree ("tenant_id","location_id","indicator_key") WHERE deleted_at IS NULL AND location_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "quality_indicator_target_organisation_key" ON "quality_indicator_target" USING btree ("tenant_id","indicator_key") WHERE deleted_at IS NULL AND location_id IS NULL;--> statement-breakpoint

-- Quality dashboard and PIR prefill (quality.md section 22; QUAL-005, QUAL-006; ADR-0108).

-- Targets are organisation figures (no personal data): read by any member who holds
-- quality.audit.manage somewhere; a location's target written by a holder at that location, the
-- organisation default (location_id NULL) only by a holder across the organisation.
ALTER TABLE public.quality_indicator_target ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.quality_indicator_target FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.quality_indicator_target AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY quality_indicator_target_read ON public.quality_indicator_target AS RESTRICTIVE
  FOR SELECT TO harbour_app, harbour_owner
  USING (app.is_system() OR app.holds_permission_anywhere('quality.audit.manage'));
--> statement-breakpoint
CREATE POLICY quality_indicator_target_record ON public.quality_indicator_target AS RESTRICTIVE
  FOR INSERT TO harbour_app, harbour_owner
  WITH CHECK (deleted_at IS NULL AND created_by IS NOT DISTINCT FROM app.current_user_id()
    AND app.holds_permission_at('quality.audit.manage', location_id));
--> statement-breakpoint
CREATE POLICY quality_indicator_target_change ON public.quality_indicator_target AS RESTRICTIVE
  FOR UPDATE TO harbour_app, harbour_owner
  USING (app.holds_permission_at('quality.audit.manage', location_id))
  WITH CHECK (app.holds_permission_at('quality.audit.manage', location_id));
--> statement-breakpoint

-- Only the figures, the version and the clearing change; the indicator and its place are fixed.
CREATE OR REPLACE FUNCTION app.quality_indicator_target_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.indicator_key IS DISTINCT FROM OLD.indicator_key OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'quality_indicator_target_fixed_fields' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'quality_indicator_target_cleared' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER quality_indicator_target_guard BEFORE UPDATE ON public.quality_indicator_target
  FOR EACH ROW EXECUTE FUNCTION app.quality_indicator_target_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.quality_indicator_target
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.quality_indicator_target
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.quality_indicator_target TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.quality_indicator_target FROM harbour_app;
--> statement-breakpoint

-- Rules 38 to 43: the counts behind the indicators and the PIR prefill for one location and a
-- period of UK days, as one JSON object of numbers. Security definer, owned by the no-login role
-- harbour_quality_reader, which holds SELECT on exactly the columns counted here and the role
-- tables the permission check reads. The tenant policy still holds it to the caller's
-- organisation; it counts every record at the location whoever it involves (rule 42), and only a
-- caller holding quality.audit.manage at the location may call it. Counts only: never a row, a
-- name or an id.
CREATE OR REPLACE FUNCTION app.quality_indicator_counts(
  p_location uuid, p_from date, p_to date, p_target_days integer)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_today date := (now() AT TIME ZONE 'Europe/London')::date;
  v_since date;
  v_result jsonb;
BEGIN
  IF v_tenant IS NULL OR app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'quality_counts_no_member' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_location IS NULL OR p_from IS NULL OR p_to IS NULL OR p_from > p_to
     OR p_to - p_from > 365 OR p_target_days IS NULL OR p_target_days < 0 OR p_target_days > 365 THEN
    RAISE EXCEPTION 'quality_counts_invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT (l.created_at AT TIME ZONE 'Europe/London')::date INTO v_since
    FROM public.location l WHERE l.tenant_id = v_tenant AND l.id = p_location;
  IF v_since IS NULL OR NOT app.holds_permission_at('quality.audit.manage', p_location) THEN
    RAISE EXCEPTION 'quality_counts_refused' USING ERRCODE = 'insufficient_privilege';
  END IF;

  WITH incidents AS (
    SELECT i.id, i.type, i.status, i.recorded_at,
           (i.occurred_at AT TIME ZONE 'Europe/London')::date AS occurred_on,
           (i.recorded_at AT TIME ZONE 'Europe/London')::date AS recorded_on
      FROM public.incident i
     WHERE i.tenant_id = v_tenant AND i.location_id = p_location AND i.deleted_at IS NULL
  ),
  in_period AS (SELECT * FROM incidents WHERE occurred_on BETWEEN p_from AND p_to),
  recorded AS (
    SELECT r.id, r.recorded_on,
           ((r.recorded_on + p_target_days + 1)::timestamp AT TIME ZONE 'Europe/London') AS deadline
      FROM incidents r WHERE r.recorded_on BETWEEN p_from AND p_to
  ),
  left_open AS (
    SELECT wi.subject_id AS incident_id, min(wt.occurred_at) AS at
      FROM public.workflow_instance wi
      JOIN public.workflow_transition wt ON wt.tenant_id = wi.tenant_id AND wt.instance_id = wi.id
     WHERE wi.tenant_id = v_tenant AND wi.definition_key = 'safety.incident'
       AND wi.subject_id IN (SELECT id FROM recorded) AND wt.from_state = 'open'
     GROUP BY wi.subject_id
  ),
  response AS (
    SELECT count(*) FILTER (WHERE lo.at IS NOT NULL AND lo.at < r.deadline) AS in_time,
           count(*) FILTER (WHERE lo.at IS NOT NULL OR now() >= r.deadline) AS decided
      FROM recorded r LEFT JOIN left_open lo ON lo.incident_id = r.id
  ),
  marks AS (
    WITH RECURSIVE chain AS (
      SELECT m.id AS origin, m.id, m.mark_type
        FROM public.body_map_mark m
       WHERE m.tenant_id = v_tenant AND m.location_id = p_location AND m.supersedes_id IS NULL
         AND m.mark_type = 'pressure_ulcer' AND m.status = 'present'
         AND (m.occurred_at AT TIME ZONE 'Europe/London')::date BETWEEN p_from AND p_to
      UNION ALL
      SELECT c.origin, n.id, n.mark_type
        FROM chain c JOIN public.body_map_mark n ON n.tenant_id = v_tenant AND n.supersedes_id = c.id
    )
    SELECT count(*) AS new_ulcers FROM (
      SELECT origin FROM chain GROUP BY origin HAVING bool_and(mark_type = 'pressure_ulcer')) o
  ),
  beds AS (
    SELECT coalesce(sum(GREATEST(0,
             LEAST(coalesce(b.to_date, p_to + 1), p_to + 1) - GREATEST(b.from_date, p_from))), 0)
             AS bed_days
      FROM public.bed_occupancy b
      JOIN public.room r ON r.tenant_id = b.tenant_id AND r.id = b.room_id
     WHERE b.tenant_id = v_tenant AND r.location_id = p_location AND b.deleted_at IS NULL
       AND b.from_date <= p_to AND (b.to_date IS NULL OR b.to_date > p_from)
  ),
  people_here AS (
    SELECT p.id FROM public.person p
     WHERE p.tenant_id = v_tenant AND p.location_id = p_location AND p.deleted_at IS NULL
       AND p.status NOT IN ('discharged', 'deceased', 'archived', 'not_admitted')
  ),
  reviews AS (
    SELECT count(*) AS due, count(*) FILTER (WHERE x.review_due_on < v_today) AS overdue
      FROM (
        SELECT cp.review_due_on FROM public.care_plan cp
         WHERE cp.tenant_id = v_tenant AND cp.location_id = p_location AND cp.status = 'active'
           AND cp.deleted_at IS NULL AND cp.review_due_on IS NOT NULL
           AND cp.person_id IN (SELECT id FROM people_here)
        UNION ALL
        SELECT ra.review_due_on FROM public.risk_assessment ra
         WHERE ra.tenant_id = v_tenant AND ra.status = 'active' AND ra.deleted_at IS NULL
           AND ra.person_id IN (SELECT id FROM people_here)
      ) x
  ),
  notes AS (
    SELECT count(*) AS care_notes FROM public.care_note n
     WHERE n.tenant_id = v_tenant AND n.location_id = p_location
       AND (n.occurred_at AT TIME ZONE 'Europe/London')::date BETWEEN p_from AND p_to
  )
  SELECT jsonb_build_object(
    'since', v_since,
    'today', v_today,
    'incidents', (SELECT count(*) FROM in_period),
    'falls', (SELECT count(*) FROM in_period WHERE type = 'fall'),
    'medicationErrors', (SELECT count(*) FROM in_period WHERE type = 'medication'),
    'pressureUlcers', (SELECT new_ulcers FROM marks),
    'bedDays', (SELECT bed_days FROM beds),
    'reviewsDue', (SELECT due FROM reviews),
    'reviewsOverdue', (SELECT overdue FROM reviews),
    'incidentsDecided', (SELECT decided FROM response),
    'incidentsReviewedInTime', (SELECT in_time FROM response),
    'careNotes', (SELECT care_notes FROM notes))
  INTO v_result;
  RETURN v_result;
END
$$;
--> statement-breakpoint

-- What harbour_quality_reader's function needs, and nothing else. Execute rights are set before
-- the owner changes (ADR-0002).
GRANT USAGE ON SCHEMA public, app TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, location_id, type, status, occurred_at, recorded_at, deleted_at)
  ON public.incident TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, location_id, supersedes_id, mark_type, status, occurred_at)
  ON public.body_map_mark TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, room_id, from_date, to_date, deleted_at)
  ON public.bed_occupancy TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, location_id) ON public.room TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, person_id, location_id, status, review_due_on, deleted_at)
  ON public.care_plan TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, person_id, status, review_due_on, deleted_at)
  ON public.risk_assessment TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, location_id, status, deleted_at) ON public.person TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, definition_key, subject_id) ON public.workflow_instance TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, instance_id, from_state, occurred_at)
  ON public.workflow_transition TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, location_id, occurred_at) ON public.care_note TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, created_at) ON public.location TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT ON public.role_assignment, public.role, public.access_grant TO harbour_quality_reader;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_permission_at(text, uuid) TO harbour_quality_reader;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.quality_indicator_counts(uuid, date, date, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.quality_indicator_counts(uuid, date, date, integer) TO harbour_app;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_quality_reader;
--> statement-breakpoint
ALTER FUNCTION app.quality_indicator_counts(uuid, date, date, integer) OWNER TO harbour_quality_reader;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_quality_reader;
