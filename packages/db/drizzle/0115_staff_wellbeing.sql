CREATE TABLE "pulse_survey" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid,
	"title" text NOT NULL,
	"questions" jsonb NOT NULL,
	"opens_on" date NOT NULL,
	"closes_on" date NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "pulse_survey_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pulse_survey_title" CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
	CONSTRAINT "pulse_survey_state" CHECK (state IN ('draft', 'open', 'closed')),
	CONSTRAINT "pulse_survey_dates" CHECK (closes_on >= opens_on),
	CONSTRAINT "pulse_survey_questions" CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE TABLE "pulse_survey_participation" (
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"survey_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	CONSTRAINT "pulse_survey_participation_pkey" PRIMARY KEY("tenant_id","survey_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "pulse_survey_response" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"survey_id" uuid NOT NULL,
	"submitted_week" date NOT NULL,
	"answers" jsonb NOT NULL,
	CONSTRAINT "pulse_survey_response_answers" CHECK (jsonb_typeof(answers) = 'object'),
	CONSTRAINT "pulse_survey_response_week" CHECK (extract(isodow FROM submitted_week) = 1)
);
--> statement-breakpoint
CREATE TABLE "recognition" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"from_member_id" uuid NOT NULL,
	"to_member_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recognition_not_self" CHECK (from_member_id <> to_member_id),
	CONSTRAINT "recognition_message" CHECK (char_length(btrim(message)) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "wellbeing_check_in" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"member_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"mood" smallint NOT NULL,
	"note" text,
	"shared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wellbeing_check_in_mood" CHECK (mood BETWEEN 1 AND 5),
	CONSTRAINT "wellbeing_check_in_note" CHECK (note IS NULL OR char_length(note) <= 1000)
);
--> statement-breakpoint
ALTER TABLE "pulse_survey" ADD CONSTRAINT "pulse_survey_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pulse_survey_participation" ADD CONSTRAINT "pulse_survey_participation_survey_fk" FOREIGN KEY ("tenant_id","survey_id") REFERENCES "public"."pulse_survey"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pulse_survey_participation" ADD CONSTRAINT "pulse_survey_participation_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pulse_survey_response" ADD CONSTRAINT "pulse_survey_response_survey_fk" FOREIGN KEY ("tenant_id","survey_id") REFERENCES "public"."pulse_survey"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recognition" ADD CONSTRAINT "recognition_from_fk" FOREIGN KEY ("tenant_id","from_member_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recognition" ADD CONSTRAINT "recognition_to_fk" FOREIGN KEY ("tenant_id","to_member_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recognition" ADD CONSTRAINT "recognition_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "wellbeing_check_in" ADD CONSTRAINT "wellbeing_check_in_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "wellbeing_check_in" ADD CONSTRAINT "wellbeing_check_in_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "pulse_survey_location_idx" ON "pulse_survey" USING btree ("tenant_id","location_id","state");
--> statement-breakpoint
CREATE INDEX "pulse_survey_response_survey_idx" ON "pulse_survey_response" USING btree ("tenant_id","survey_id");
--> statement-breakpoint
CREATE INDEX "recognition_to_idx" ON "recognition" USING btree ("tenant_id","to_member_id","created_at");
--> statement-breakpoint
CREATE INDEX "recognition_location_idx" ON "recognition" USING btree ("tenant_id","location_id","created_at");
--> statement-breakpoint
CREATE INDEX "wellbeing_check_in_member_idx" ON "wellbeing_check_in" USING btree ("tenant_id","member_id","created_at");
--> statement-breakpoint
CREATE INDEX "wellbeing_check_in_location_idx" ON "wellbeing_check_in" USING btree ("tenant_id","location_id","created_at");
--> statement-breakpoint

-- Staff wellbeing and voice (scheduling.md section 16; SCHED-011). Every table has forced RLS and
-- the tenant policy (ADR-0002). A survey response is anonymous (rule 3): the application role has
-- no grant and no policy on it, and reaches it only through app.submit_pulse_response and
-- app.pulse_survey_results, which never return a single response and show results only once the
-- survey has closed and the minimum group size answered (rule 4).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pulse_survey', 'pulse_survey_participation', 'pulse_survey_response',
    'recognition', 'wellbeing_check_in'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- A permission about the member's own rows (`.self` only), held through any role in force or a
-- grant, whatever its scope: a care worker's assigned-scope role gives it. A role mixing portal and
-- staff permissions gives none, as at sign-in.
CREATE OR REPLACE FUNCTION app.holds_own_permission(p_permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.current_user_id() IS NOT NULL AND p_permission LIKE '%.self' AND (
    EXISTS (
      SELECT 1 FROM public.role_assignment ra
      JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
      WHERE ra.tenant_id = app.current_tenant_id()
        AND ra.tenant_user_id = app.current_user_id()
        AND ra.deleted_at IS NULL AND r.archived_at IS NULL
        AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
        AND NOT (r.permissions && ARRAY['comms.portal.family', 'comms.portal.self', 'comms.feed.read',
          'comms.notification.subscribe', 'comms.visit_booking.request']::text[])
        AND p_permission = ANY (r.permissions))
    OR EXISTS (
      SELECT 1 FROM public.access_grant g
      WHERE g.tenant_id = app.current_tenant_id()
        AND g.tenant_user_id = app.current_user_id()
        AND g.deleted_at IS NULL AND g.revoked_at IS NULL
        AND g.valid_from <= now() AND g.valid_to > now()
        AND p_permission = ANY (g.permissions)))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.holds_own_permission(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_own_permission(text) TO harbour_app, harbour_owner;
--> statement-breakpoint

-- Whether a member works at a home: a role in force there (or across the organisation), or that
-- home on their staff profile. Definer: the sender of a recognition note, or a survey, asks about a
-- colleague whose roles and file they cannot read; only yes or no leaves.
CREATE OR REPLACE FUNCTION app.works_at(p_member_id uuid, p_location_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_member_id IS NOT NULL AND p_location_id IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.role_assignment ra
      JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
      WHERE ra.tenant_id = app.current_tenant_id() AND ra.tenant_user_id = p_member_id
        AND ra.deleted_at IS NULL AND r.archived_at IS NULL
        AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
        AND (ra.location_id = p_location_id
          OR (ra.location_id IS NULL AND (r.scope_kind = 'tenant' OR ra.organisation_wide))))
    OR EXISTS (
      SELECT 1 FROM public.staff_profile s
      WHERE s.tenant_id = app.current_tenant_id() AND s.tenant_user_id = p_member_id
        AND s.location_id = p_location_id AND s.deleted_at IS NULL))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.works_at(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.works_at(uuid, uuid) TO harbour_app;
--> statement-breakpoint

-- Surveys: written by holders of scheduling.wellbeing.manage at the home (across the organisation
-- for an organisation survey); read by them, by the members who may answer an open or closed one,
-- and by the system.
CREATE POLICY pulse_survey_read ON public.pulse_survey AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.is_system()
    OR app.holds_permission_at('scheduling.wellbeing.manage', location_id)
    OR (state <> 'draft' AND deleted_at IS NULL
      AND app.holds_own_permission('scheduling.wellbeing.self')
      AND (location_id IS NULL OR app.works_at(app.current_user_id(), location_id))));
--> statement-breakpoint
CREATE POLICY pulse_survey_insert ON public.pulse_survey AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (state = 'draft' AND deleted_at IS NULL AND created_by = app.current_user_id()
    AND app.holds_permission_at('scheduling.wellbeing.manage', location_id));
--> statement-breakpoint
CREATE POLICY pulse_survey_update ON public.pulse_survey AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (app.holds_permission_at('scheduling.wellbeing.manage', location_id))
  WITH CHECK (app.holds_permission_at('scheduling.wellbeing.manage', location_id));
--> statement-breakpoint

-- Rule 1: draft, then open, then closed, never back; the home is fixed; questions, title and dates
-- change only while a draft; only a draft is removed; the times of opening and closing are the
-- database's.
CREATE OR REPLACE FUNCTION app.pulse_survey_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'pulse_survey_fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state AND NOT ((OLD.state = 'draft' AND NEW.state = 'open')
      OR (OLD.state = 'open' AND NEW.state = 'closed')) THEN
    RAISE EXCEPTION 'pulse_survey_wrong_state' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state <> 'draft' AND (NEW.questions IS DISTINCT FROM OLD.questions
      OR NEW.title IS DISTINCT FROM OLD.title OR NEW.opens_on IS DISTINCT FROM OLD.opens_on
      OR NEW.closes_on IS DISTINCT FROM OLD.closes_on) THEN
    RAISE EXCEPTION 'pulse_survey_fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND (OLD.state <> 'draft' OR OLD.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'pulse_survey_fixed' USING ERRCODE = 'check_violation';
  END IF;
  NEW.opened_at := CASE WHEN OLD.state = 'draft' AND NEW.state = 'open' THEN now() ELSE OLD.opened_at END;
  NEW.closed_at := CASE WHEN OLD.state = 'open' AND NEW.state = 'closed' THEN now() ELSE OLD.closed_at END;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER pulse_survey_guard BEFORE UPDATE ON public.pulse_survey
  FOR EACH ROW EXECUTE FUNCTION app.pulse_survey_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.pulse_survey_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.opened_at := NULL;
  NEW.closed_at := NULL;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER pulse_survey_insert_guard BEFORE INSERT ON public.pulse_survey
  FOR EACH ROW EXECUTE FUNCTION app.pulse_survey_insert_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.pulse_survey
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.pulse_survey
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint

-- Taking part: a member reads only their own; written only by app.submit_pulse_response.
CREATE POLICY pulse_survey_participation_read ON public.pulse_survey_participation AS RESTRICTIVE
  FOR SELECT TO harbour_app, harbour_owner
  USING (app.is_system() OR member_id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY pulse_survey_participation_write ON public.pulse_survey_participation AS RESTRICTIVE
  FOR INSERT TO harbour_app, harbour_owner
  WITH CHECK (member_id = app.current_user_id());
--> statement-breakpoint

-- Responses: nothing for the application role, even with a grant added by mistake.
CREATE POLICY pulse_survey_response_closed ON public.pulse_survey_response AS RESTRICTIVE
  FOR ALL TO harbour_app
  USING (false) WITH CHECK (false);
--> statement-breakpoint

-- Recognition (rule 5): written by its sender for a colleague at the home named, never
-- themselves; read by its sender, its recipient and the holders of scheduling.wellbeing.manage at
-- the recipient's home.
CREATE POLICY recognition_read ON public.recognition AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.is_system() OR from_member_id = app.current_user_id()
    OR to_member_id = app.current_user_id()
    OR app.holds_permission_at('scheduling.wellbeing.manage', location_id));
--> statement-breakpoint
CREATE POLICY recognition_insert ON public.recognition AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (from_member_id = app.current_user_id() AND to_member_id <> from_member_id
    AND app.holds_own_permission('scheduling.wellbeing.self')
    AND app.works_at(to_member_id, location_id));
--> statement-breakpoint

-- Check-ins (rule 6): the member's own; a manager at their home reads one only while it is
-- shared. Only the member changes it, and only whether it is shared.
CREATE POLICY wellbeing_check_in_read ON public.wellbeing_check_in AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (member_id = app.current_user_id()
    OR (shared_at IS NOT NULL
      AND app.holds_permission_at('scheduling.wellbeing.manage', location_id)));
--> statement-breakpoint
CREATE POLICY wellbeing_check_in_insert ON public.wellbeing_check_in AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (member_id = app.current_user_id()
    AND app.holds_own_permission('scheduling.wellbeing.self')
    AND app.works_at(member_id, location_id));
--> statement-breakpoint
CREATE POLICY wellbeing_check_in_update ON public.wellbeing_check_in AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (member_id = app.current_user_id())
  WITH CHECK (member_id = app.current_user_id());
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.wellbeing_check_in_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.member_id IS DISTINCT FROM OLD.member_id
      OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.mood IS DISTINCT FROM OLD.mood
      OR NEW.note IS DISTINCT FROM OLD.note OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'wellbeing_check_in_fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.shared_at IS NOT NULL AND OLD.shared_at IS NULL THEN
    NEW.shared_at := now();
  ELSIF NEW.shared_at IS NOT NULL THEN
    NEW.shared_at := OLD.shared_at;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER wellbeing_check_in_guard BEFORE UPDATE ON public.wellbeing_check_in
  FOR EACH ROW EXECUTE FUNCTION app.wellbeing_check_in_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.wellbeing_check_in_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.created_at := now();
  IF NEW.shared_at IS NOT NULL THEN
    NEW.shared_at := now();
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER wellbeing_check_in_insert_guard BEFORE INSERT ON public.wellbeing_check_in
  FOR EACH ROW EXECUTE FUNCTION app.wellbeing_check_in_insert_guard();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.wellbeing_check_in
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.pulse_survey
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pulse_survey_participation', 'pulse_survey_response', 'recognition'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.recognition_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER recognition_insert_guard BEFORE INSERT ON public.recognition
  FOR EACH ROW EXECUTE FUNCTION app.recognition_insert_guard();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.pulse_survey, public.wellbeing_check_in TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.recognition TO harbour_app;
--> statement-breakpoint
GRANT SELECT ON public.pulse_survey_participation TO harbour_app;
--> statement-breakpoint
REVOKE ALL ON public.pulse_survey_response FROM harbour_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.pulse_survey_participation FROM harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.pulse_survey, public.wellbeing_check_in, public.recognition FROM harbour_app;
--> statement-breakpoint
REVOKE UPDATE ON public.recognition FROM harbour_app;
--> statement-breakpoint

-- The minimum group size in force (rule 4): the larger of the global figure and the
-- organisation's own, so an organisation can raise it and never lower it; null with no global
-- figure (then results never show). For a home's nation, else England's.
CREATE OR REPLACE FUNCTION app.survey_min_group_size(p_location_id uuid) RETURNS numeric
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  WITH place AS (
    SELECT coalesce((SELECT l.nation::text FROM public.location l
      WHERE l.tenant_id = app.current_tenant_id() AND l.id = p_location_id), 'england') AS nation
  ),
  rows AS (
    SELECT r.value, r.tenant_id,
      CASE r.nation WHEN (SELECT nation FROM place) THEN 3 WHEN 'uk' THEN 2 ELSE 1 END AS fit
    FROM public.rate_table r
    WHERE r.key = 'wellbeing.survey_min_group_size'
      AND r.nation IN ((SELECT nation FROM place), 'uk', 'all')
      AND r.valid_from <= (now() AT TIME ZONE 'Europe/London')::date
      AND (r.valid_to IS NULL OR r.valid_to > (now() AT TIME ZONE 'Europe/London')::date)
      AND (r.tenant_id IS NULL OR r.tenant_id = app.current_tenant_id())
  ),
  global AS (SELECT value FROM rows WHERE tenant_id IS NULL ORDER BY fit DESC LIMIT 1),
  own AS (SELECT value FROM rows WHERE tenant_id IS NOT NULL ORDER BY fit DESC LIMIT 1)
  SELECT CASE WHEN (SELECT value FROM global) IS NULL THEN NULL
    ELSE greatest((SELECT value FROM global), coalesce((SELECT value FROM own), 0)) END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.survey_min_group_size(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.survey_min_group_size(uuid) TO harbour_app, harbour_owner;
--> statement-breakpoint

-- Rules 2 and 3: the caller answers an open survey they may answer, once. The participation row
-- and the response are written apart: the response has a random id, the UK week only, no member.
CREATE OR REPLACE FUNCTION app.submit_pulse_response(p_survey_id uuid, p_answers jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  s public.pulse_survey%ROWTYPE;
  me uuid := app.current_user_id();
  today date := (now() AT TIME ZONE 'Europe/London')::date;
  k text;
  v jsonb;
  q jsonb;
BEGIN
  IF me IS NULL OR NOT app.holds_own_permission('scheduling.wellbeing.self') THEN
    RAISE EXCEPTION 'pulse_response_not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO s FROM public.pulse_survey
    WHERE tenant_id = app.current_tenant_id() AND id = p_survey_id AND deleted_at IS NULL;
  IF NOT FOUND OR s.state = 'draft'
      OR (s.location_id IS NOT NULL AND NOT app.works_at(me, s.location_id)) THEN
    RAISE EXCEPTION 'pulse_survey_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF s.state <> 'open' OR today < s.opens_on OR today > s.closes_on THEN
    RAISE EXCEPTION 'pulse_survey_not_open' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_answers) <> 'object' OR p_answers = '{}'::jsonb THEN
    RAISE EXCEPTION 'pulse_response_invalid' USING ERRCODE = 'check_violation';
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each(p_answers) LOOP
    SELECT e INTO q FROM jsonb_array_elements(s.questions) e WHERE e->>'id' = k;
    IF q IS NULL THEN
      RAISE EXCEPTION 'pulse_response_invalid' USING ERRCODE = 'check_violation';
    END IF;
    IF q->>'kind' = 'scale' THEN
      IF jsonb_typeof(v) <> 'number' OR (v #>> '{}')::numeric NOT IN (1, 2, 3, 4, 5) THEN
        RAISE EXCEPTION 'pulse_response_invalid' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF jsonb_typeof(v) <> 'string' OR btrim(v #>> '{}') = '' OR char_length(v #>> '{}') > 2000 THEN
      RAISE EXCEPTION 'pulse_response_invalid' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  BEGIN
    INSERT INTO public.pulse_survey_participation (tenant_id, survey_id, member_id)
      VALUES (s.tenant_id, s.id, me);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'pulse_already_answered' USING ERRCODE = 'unique_violation';
  END;
  INSERT INTO public.pulse_survey_response (tenant_id, survey_id, submitted_week, answers)
    VALUES (s.tenant_id, s.id, date_trunc('week', today)::date, p_answers);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.submit_pulse_response(uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.submit_pulse_response(uuid, jsonb) TO harbour_app;
--> statement-breakpoint

-- Rule 4: a survey's results for a holder of scheduling.wellbeing.manage where it applies. Only
-- once it has closed, only when at least the minimum group size answered, and each question only
-- when that many answered it; never a count below the size, never a single response, free text in
-- alphabetical order.
CREATE OR REPLACE FUNCTION app.pulse_survey_results(p_survey_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  s public.pulse_survey%ROWTYPE;
  size numeric;
  n integer;
  q jsonb;
  answered integer;
  out_questions jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO s FROM public.pulse_survey
    WHERE tenant_id = app.current_tenant_id() AND id = p_survey_id AND deleted_at IS NULL;
  IF NOT FOUND OR NOT app.holds_permission_at('scheduling.wellbeing.manage', s.location_id) THEN
    RAISE EXCEPTION 'pulse_survey_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  size := app.survey_min_group_size(s.location_id);
  IF s.state <> 'closed' THEN
    RETURN jsonb_build_object('visible', false, 'reason', 'still_open', 'minGroupSize', size);
  END IF;
  IF size IS NULL THEN
    RETURN jsonb_build_object('visible', false, 'reason', 'no_size', 'minGroupSize', NULL);
  END IF;
  SELECT count(*) INTO n FROM public.pulse_survey_response r
    WHERE r.tenant_id = s.tenant_id AND r.survey_id = s.id;
  IF n < size THEN
    RETURN jsonb_build_object('visible', false, 'reason', 'too_few', 'minGroupSize', size);
  END IF;
  FOR q IN SELECT e FROM jsonb_array_elements(s.questions) e LOOP
    SELECT count(*) INTO answered FROM public.pulse_survey_response r
      WHERE r.tenant_id = s.tenant_id AND r.survey_id = s.id AND r.answers ? (q->>'id');
    IF answered < size THEN
      out_questions := out_questions || jsonb_build_array(jsonb_build_object(
        'id', q->>'id', 'kind', q->>'kind', 'text', q->>'text', 'visible', false));
    ELSIF q->>'kind' = 'scale' THEN
      out_questions := out_questions || jsonb_build_array(jsonb_build_object(
        'id', q->>'id', 'kind', 'scale', 'text', q->>'text', 'visible', true, 'answered', answered,
        'counts', (SELECT jsonb_agg(c ORDER BY p) FROM (
          SELECT p, (SELECT count(*) FROM public.pulse_survey_response r
            WHERE r.tenant_id = s.tenant_id AND r.survey_id = s.id
              AND (r.answers ->> (q->>'id'))::numeric = p) AS c
          FROM generate_series(1, 5) p) x)));
    ELSE
      out_questions := out_questions || jsonb_build_array(jsonb_build_object(
        'id', q->>'id', 'kind', 'free_text', 'text', q->>'text', 'visible', true,
        'answered', answered,
        'texts', (SELECT jsonb_agg(t ORDER BY t COLLATE "C") FROM (
          SELECT r.answers ->> (q->>'id') AS t FROM public.pulse_survey_response r
          WHERE r.tenant_id = s.tenant_id AND r.survey_id = s.id AND r.answers ? (q->>'id')) y)));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('visible', true, 'minGroupSize', size, 'respondents', n,
    'questions', out_questions);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.pulse_survey_results(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.pulse_survey_results(uuid) TO harbour_app;
--> statement-breakpoint

-- Data migration: existing tenants' copies of the built-in roles gain the wellbeing permissions
-- their built-in definitions (packages/domain/src/platform/roles.ts) added, as a new version of
-- each role, audited (platform.role.permissions_migrated), as migration 0074 does. Idempotent.
ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.role WHERE is_builtin ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    WITH grants(key, add) AS (VALUES
        ('owner', ARRAY['scheduling.wellbeing.manage', 'scheduling.wellbeing.self']),
        ('registered_manager', ARRAY['scheduling.wellbeing.manage', 'scheduling.wellbeing.self']),
        ('deputy_manager', ARRAY['scheduling.wellbeing.manage', 'scheduling.wellbeing.self']),
        ('clinical_lead', ARRAY['scheduling.wellbeing.self']),
        ('team_leader', ARRAY['scheduling.wellbeing.self']),
        ('care_worker', ARRAY['scheduling.wellbeing.self']),
        ('activities', ARRAY['scheduling.wellbeing.self']),
        ('catering', ARRAY['scheduling.wellbeing.self']),
        ('housekeeping', ARRAY['scheduling.wellbeing.self']),
        ('maintenance', ARRAY['scheduling.wellbeing.self']),
        ('agency_worker', ARRAY['scheduling.wellbeing.self'])
      ),
      targets AS (
        SELECT r.id, r.tenant_id, r.key,
          ARRAY(SELECT p FROM unnest(g.add) WITH ORDINALITY AS a(p, n)
                WHERE p <> ALL (r.permissions) ORDER BY n) AS missing
        FROM public.role r JOIN grants g ON g.key = r.key
        WHERE r.tenant_id = t AND r.is_builtin AND NOT (r.permissions @> g.add)
      ),
      changed AS (
        UPDATE public.role r SET permissions = r.permissions || x.missing
          FROM targets x WHERE r.id = x.id
          RETURNING r.id
      )
    INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
        outcome, resource_type, resource_id, scope, reason)
      SELECT x.tenant_id, 'system', ARRAY['system'], 'platform.role.permissions_migrated',
        'success', 'role', x.id::text,
        jsonb_build_object('migration', '0115_staff_wellbeing', 'roleKey', x.key,
          'added', to_jsonb(x.missing)),
        'Existing tenants'' built-in role copies gained the staff wellbeing permissions their built-in definitions added (migration 0115)'
      FROM targets x JOIN changed c ON c.id = x.id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.role FORCE ROW LEVEL SECURITY;
