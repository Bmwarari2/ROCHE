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
	CONSTRAINT "quality_indicator_target_percent" CHECK (indicator_key NOT IN ('missed_visits', 'overdue_reviews', 'training_compliance', 'agency_hours', 'staff_turnover', 'incident_response') OR (green <= 100 AND amber <= 100)),
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
-- caller holding quality.audit.manage at the location may call it, for whole months that have
-- ended. Counts only: never a row, a name or an id.
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
  -- Rule 42: whole calendar months that have ended, at most twelve, so no two periods can be
  -- subtracted to single out a day (slice 47 security review, M1).
  IF p_location IS NULL OR p_from IS NULL OR p_to IS NULL OR p_from > p_to
     OR extract(day FROM p_from) <> 1 OR extract(day FROM p_to + 1) <> 1 OR p_to >= v_today
     OR p_from < (date_trunc('month', p_to) - interval '11 months')::date
     OR p_target_days IS NULL OR p_target_days < 0 OR p_target_days > 365 THEN
    RAISE EXCEPTION 'quality_counts_invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT (l.created_at AT TIME ZONE 'Europe/London')::date INTO v_since
    FROM public.location l WHERE l.tenant_id = v_tenant AND l.id = p_location;
  IF v_since IS NULL OR NOT app.holds_permission_at('quality.audit.manage', p_location) THEN
    RAISE EXCEPTION 'quality_counts_refused' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Rule 38: the location counts from the later of its record's creation and its first care note
  -- (the day staff started recording in Harbour), so an onboarding gap is never a quiet month.
  SELECT GREATEST(v_since, coalesce(min((n.occurred_at AT TIME ZONE 'Europe/London')::date), v_today))
    INTO v_since
    FROM public.care_note n WHERE n.tenant_id = v_tenant AND n.location_id = p_location;

  WITH incidents AS (
    SELECT i.id, i.type, i.status, i.raised_by,
           (i.occurred_at AT TIME ZONE 'Europe/London')::date AS occurred_on
      FROM public.incident i
     WHERE i.tenant_id = v_tenant AND i.location_id = p_location AND i.deleted_at IS NULL
       -- Only what the period can count (UK days, a day either side for the clock change).
       AND i.occurred_at >= p_from - 1 AND i.occurred_at < p_to + 2
  ),
  in_period AS (SELECT * FROM incidents WHERE occurred_on BETWEEN p_from AND p_to),
  -- Rule 38: reviewed in time means moved on from open by someone other than its raiser within
  -- the target days of the day it occurred, and not back to open since (slice 47 clinical review).
  timed AS (
    SELECT r.id, r.status,
           ((r.occurred_on + p_target_days + 1)::timestamp AT TIME ZONE 'Europe/London') AS deadline,
           (SELECT min(wt.occurred_at)
              FROM public.workflow_instance wi
              JOIN public.workflow_transition wt ON wt.tenant_id = wi.tenant_id AND wt.instance_id = wi.id
             WHERE wi.tenant_id = v_tenant AND wi.definition_key = 'safety.incident'
               AND wi.subject_id = r.id AND wt.from_state = 'open'
               AND wt.created_by IS DISTINCT FROM r.raised_by) AS reviewed_at
      FROM in_period r
  ),
  response AS (
    SELECT count(*) FILTER (WHERE status <> 'open' AND reviewed_at < deadline) AS in_time,
           count(*) FILTER (WHERE (status <> 'open' AND reviewed_at IS NOT NULL) OR now() >= deadline)
             AS decided
      FROM timed
  ),
  -- A new pressure ulcer: a mark first recorded in the period whose latest version that is not a
  -- healing record is a pressure ulcer, whatever it was first recorded as (corrections either way).
  marks AS (
    WITH RECURSIVE chain AS (
      SELECT m.id AS origin, m.id, m.mark_type, m.status, 0 AS depth
        FROM public.body_map_mark m
       WHERE m.tenant_id = v_tenant AND m.location_id = p_location AND m.supersedes_id IS NULL
         AND (m.occurred_at AT TIME ZONE 'Europe/London')::date BETWEEN p_from AND p_to
      UNION ALL
      SELECT c.origin, n.id, n.mark_type, n.status, c.depth + 1
        FROM chain c JOIN public.body_map_mark n ON n.tenant_id = v_tenant AND n.supersedes_id = c.id
    ) CYCLE id SET is_cycle USING path
    SELECT count(*) AS new_ulcers FROM (
      SELECT DISTINCT ON (origin) origin, mark_type
        FROM chain WHERE NOT is_cycle AND status = 'present'
       ORDER BY origin, depth DESC) latest
     WHERE latest.mark_type = 'pressure_ulcer'
  ),
  -- Occupied bed-days: each day a bed was held for someone in the period, less days away in
  -- hospital (between the day they left and the day they came back) and days after a death.
  bed_day AS (
    SELECT b.person_id, d::date AS day
      FROM public.bed_occupancy b
      JOIN public.room r ON r.tenant_id = b.tenant_id AND r.id = b.room_id
      CROSS JOIN LATERAL generate_series(GREATEST(b.from_date, p_from),
        LEAST(coalesce(b.to_date, p_to + 1), p_to + 1) - 1, interval '1 day') AS d
     WHERE b.tenant_id = v_tenant AND r.location_id = p_location AND b.deleted_at IS NULL
       AND b.from_date <= p_to AND (b.to_date IS NULL OR b.to_date > p_from)
  ),
  beds AS (
    SELECT count(*) AS bed_days FROM bed_day x
     WHERE NOT EXISTS (
             SELECT 1 FROM public.hospital_transfer h
              WHERE h.tenant_id = v_tenant AND h.person_id = x.person_id AND h.deleted_at IS NULL
                AND x.day > (h.left_at AT TIME ZONE 'Europe/London')::date
                AND (h.returned_at IS NULL OR x.day < (h.returned_at AT TIME ZONE 'Europe/London')::date))
       AND NOT EXISTS (
             SELECT 1 FROM public.person p
              WHERE p.tenant_id = v_tenant AND p.id = x.person_id AND p.deceased_at IS NOT NULL
                AND x.day > (p.deceased_at AT TIME ZONE 'Europe/London')::date)
  ),
  -- Overdue reviews as at today, for the people living at the location now (wherever their plan
  -- was written). A person with no active care plan holding a review date counts as overdue.
  people_here AS (
    SELECT p.id FROM public.person p
     WHERE p.tenant_id = v_tenant AND p.location_id = p_location AND p.deleted_at IS NULL
       AND p.status IN ('active', 'on_leave', 'in_hospital')
  ),
  plans AS (
    SELECT cp.person_id, cp.review_due_on FROM public.care_plan cp
     WHERE cp.tenant_id = v_tenant AND cp.status = 'active' AND cp.deleted_at IS NULL
       AND cp.review_due_on IS NOT NULL AND cp.person_id IN (SELECT id FROM people_here)
  ),
  no_review AS (
    SELECT count(*) AS n FROM people_here h WHERE NOT EXISTS (SELECT 1 FROM plans WHERE plans.person_id = h.id)
  ),
  reviews AS (
    SELECT count(*) AS due, count(*) FILTER (WHERE x.review_due_on < v_today) AS overdue
      FROM (
        SELECT review_due_on FROM plans
        UNION ALL
        SELECT ra.review_due_on FROM public.risk_assessment ra
         WHERE ra.tenant_id = v_tenant AND ra.status = 'active' AND ra.deleted_at IS NULL
           AND ra.person_id IN (SELECT id FROM people_here)
      ) x
  ),
  notes AS (
    SELECT count(*) AS care_notes FROM public.care_note n
     WHERE n.tenant_id = v_tenant AND n.location_id = p_location
       AND n.occurred_at >= p_from - 1 AND n.occurred_at < p_to + 2
       AND (n.occurred_at AT TIME ZONE 'Europe/London')::date BETWEEN p_from AND p_to
  ),
  -- A downtime at the location not yet reconciled leaves its paper records out (rule 38).
  outages AS (
    SELECT count(*) AS open_outages FROM public.outage o
     WHERE o.tenant_id = v_tenant AND o.location_id = p_location AND o.deleted_at IS NULL
       AND o.cancelled_at IS NULL AND o.reconciled_at IS NULL
       AND o.started_at < ((p_to + 1)::timestamp AT TIME ZONE 'Europe/London')
       AND (o.ended_at IS NULL OR o.ended_at >= (p_from::timestamp AT TIME ZONE 'Europe/London'))
  )
  SELECT jsonb_build_object(
    'since', v_since,
    'today', v_today,
    'incidents', (SELECT count(*) FROM in_period),
    'falls', (SELECT count(*) FROM in_period WHERE type = 'fall'),
    'medicationErrors', (SELECT count(*) FROM in_period WHERE type = 'medication'),
    'pressureUlcers', (SELECT new_ulcers FROM marks),
    'bedDays', (SELECT bed_days FROM beds),
    'reviewsDue', (SELECT due FROM reviews) + (SELECT n FROM no_review),
    'reviewsOverdue', (SELECT overdue FROM reviews) + (SELECT n FROM no_review),
    'peopleWithoutReviewDate', (SELECT n FROM no_review),
    'incidentsDecided', (SELECT decided FROM response),
    'incidentsReviewedInTime', (SELECT in_time FROM response),
    'careNotes', (SELECT care_notes FROM notes),
    'openOutages', (SELECT open_outages FROM outages))
  INTO v_result;
  RETURN v_result;
END
$$;
--> statement-breakpoint

-- What harbour_quality_reader's function needs, and nothing else. Execute rights are set before
-- the owner changes (ADR-0002).
GRANT USAGE ON SCHEMA public, app TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, location_id, type, status, raised_by, occurred_at, deleted_at)
  ON public.incident TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, location_id, supersedes_id, mark_type, status, occurred_at)
  ON public.body_map_mark TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, person_id, room_id, from_date, to_date, deleted_at)
  ON public.bed_occupancy TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, location_id) ON public.room TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, person_id, status, review_due_on, deleted_at)
  ON public.care_plan TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, person_id, status, review_due_on, deleted_at)
  ON public.risk_assessment TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, location_id, status, deceased_at, deleted_at) ON public.person
  TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, person_id, left_at, returned_at, deleted_at) ON public.hospital_transfer
  TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, location_id, started_at, ended_at, cancelled_at, reconciled_at, deleted_at)
  ON public.outage TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, definition_key, subject_id) ON public.workflow_instance TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, instance_id, from_state, occurred_at, created_by)
  ON public.workflow_transition TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, location_id, occurred_at) ON public.care_note TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, created_at) ON public.location TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, tenant_user_id, role_id, location_id, organisation_wide, valid_from,
  valid_to, deleted_at) ON public.role_assignment TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, scope_kind, permissions, archived_at) ON public.role TO harbour_quality_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, tenant_user_id, location_id, organisation_wide, permissions, valid_from,
  valid_to, revoked_at, deleted_at) ON public.access_grant TO harbour_quality_reader;
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
--> statement-breakpoint

-- What the counts look up by (slice 47 security review, L2): corrections of a mark, and the
-- incident workflow of an incident.
CREATE INDEX "body_map_mark_supersedes_idx" ON "body_map_mark" USING btree ("tenant_id","supersedes_id") WHERE supersedes_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workflow_instance_subject_idx" ON "workflow_instance" USING btree ("tenant_id","definition_key","subject_id");--> statement-breakpoint

-- DSPT outcomes as the toolkit has published them, "standards exceeded" in earlier years (H-917,
-- recommended answer applied 31/10/2026). Widening only: every stored outcome stays valid.
ALTER TABLE "dspt_submission" DROP CONSTRAINT "dspt_submission_outcome";--> statement-breakpoint
ALTER TABLE "dspt_submission" ADD CONSTRAINT "dspt_submission_outcome" CHECK (outcome IN ('standards_exceeded', 'standards_met', 'approaching_standards', 'standards_not_met'));
