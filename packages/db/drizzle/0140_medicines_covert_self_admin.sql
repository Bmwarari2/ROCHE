CREATE TABLE "covert_medication_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"medication_id" uuid NOT NULL,
	"medicine_id" uuid NOT NULL,
	"capacity_assessment_id" uuid NOT NULL,
	"best_interests_decision_id" uuid NOT NULL,
	"attendees" jsonb NOT NULL,
	"method" text NOT NULL,
	"pharmacist_advice" text NOT NULL,
	"starts_on" date NOT NULL,
	"review_on" date NOT NULL,
	"reviewed_on" date,
	"ended_on" date,
	"ended_reason" text,
	"change_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "covert_medication_record_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "covert_medication_record_attendees" CHECK (jsonb_typeof(attendees) = 'array'),
	CONSTRAINT "covert_medication_record_words" CHECK (length(btrim(method)) > 0 AND length(btrim(pharmacist_advice)) > 0),
	CONSTRAINT "covert_medication_record_review" CHECK (review_on > starts_on),
	CONSTRAINT "covert_medication_record_ended" CHECK ((ended_on IS NULL) = (ended_reason IS NULL)
        AND (ended_reason IS NULL OR length(btrim(ended_reason)) > 0))
);
--> statement-breakpoint
CREATE TABLE "homely_remedy_administration" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"protocol_id" uuid NOT NULL,
	"protocol_version" integer NOT NULL,
	"outcome" text NOT NULL,
	"quantity" numeric(12, 3),
	"reason" text,
	"given_at" timestamp with time zone NOT NULL,
	"given_by" uuid NOT NULL,
	"allergies_checked" boolean DEFAULT false NOT NULL,
	"already_given_reason" text,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_id" uuid,
	"correction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "homely_remedy_administration_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "homely_remedy_administration_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "homely_remedy_administration_outcome" CHECK ((outcome = 'given' AND quantity > 0 AND supersedes_id IS NULL AND correction_reason IS NULL
           AND length(btrim(coalesce(reason, ''))) > 0 AND allergies_checked
           AND (cardinality(flags) = 0 OR length(btrim(coalesce(already_given_reason, ''))) > 0))
       OR (outcome = 'entered_in_error' AND quantity IS NULL AND supersedes_id IS NOT NULL
           AND supersedes_id <> id AND length(btrim(coalesce(correction_reason, ''))) > 0))
);
--> statement-breakpoint
CREATE TABLE "homely_remedy_protocol" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"vmp_id" text,
	"indication" text NOT NULL,
	"dose_quantity" numeric(12, 3) NOT NULL,
	"unit_name" text NOT NULL,
	"min_interval_hours" numeric(6, 2) NOT NULL,
	"max_daily_quantity" numeric(12, 3) NOT NULL,
	"max_days" integer NOT NULL,
	"authorised_member_ids" uuid[] NOT NULL,
	"approved_by_name" text NOT NULL,
	"approved_by_role" text NOT NULL,
	"approved_on" date NOT NULL,
	"review_on" date NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	"change_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "homely_remedy_protocol_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "homely_remedy_protocol_figures" CHECK (dose_quantity > 0 AND max_daily_quantity >= dose_quantity AND min_interval_hours > 0
        AND max_days >= 1),
	CONSTRAINT "homely_remedy_protocol_vmp" CHECK (vmp_id IS NULL OR vmp_id ~ '^[0-9]{6,18}$'),
	CONSTRAINT "homely_remedy_protocol_role" CHECK (approved_by_role IN ('gp', 'pharmacist')),
	CONSTRAINT "homely_remedy_protocol_staff" CHECK (cardinality(authorised_member_ids) > 0),
	CONSTRAINT "homely_remedy_protocol_review" CHECK (review_on > approved_on),
	CONSTRAINT "homely_remedy_protocol_withdrawn" CHECK ((withdrawn_at IS NULL) = (withdrawn_reason IS NULL))
);
--> statement-breakpoint
CREATE TABLE "self_administration_assessment" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"medicine_ids" uuid[] NOT NULL,
	"choice" text NOT NULL,
	"capacity" text NOT NULL,
	"capacity_assessment_id" uuid,
	"dexterity" text NOT NULL,
	"storage" text NOT NULL,
	"level" text NOT NULL,
	"notes" text,
	"assessed_on" date NOT NULL,
	"review_on" date NOT NULL,
	"assessed_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "self_administration_assessment_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "self_administration_assessment_choice" CHECK (choice IN ('wants_to', 'does_not_want_to')),
	CONSTRAINT "self_administration_assessment_capacity" CHECK (capacity IN ('has_capacity', 'lacks_capacity', 'assumed')
        AND (capacity = 'assumed') = (capacity_assessment_id IS NULL)),
	CONSTRAINT "self_administration_assessment_dexterity" CHECK (dexterity IN ('able', 'able_with_aids', 'unable')),
	CONSTRAINT "self_administration_assessment_storage" CHECK (storage IN ('lockable_storage', 'no_lockable_storage')),
	CONSTRAINT "self_administration_assessment_level" CHECK (level IN ('self_administers', 'self_administers_with_support', 'staff_administer')
        AND (level = 'staff_administer' OR (choice = 'wants_to' AND capacity <> 'lacks_capacity'
          AND dexterity <> 'unable' AND storage = 'lockable_storage'))),
	CONSTRAINT "self_administration_assessment_medicines" CHECK (cardinality(medicine_ids) > 0),
	CONSTRAINT "self_administration_assessment_review" CHECK (review_on > assessed_on)
);
--> statement-breakpoint
ALTER TABLE "medication_administration" DROP CONSTRAINT "medication_administration_flags";--> statement-breakpoint
ALTER TABLE "medication_administration" ADD COLUMN "covert" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "covert_medication_record" ADD CONSTRAINT "covert_medication_record_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "covert_medication_record" ADD CONSTRAINT "covert_medication_record_medication_fk" FOREIGN KEY ("tenant_id","person_id","medication_id") REFERENCES "public"."medication"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "covert_medication_record" ADD CONSTRAINT "covert_medication_record_capacity_fk" FOREIGN KEY ("tenant_id","person_id","capacity_assessment_id") REFERENCES "public"."capacity_assessment"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "covert_medication_record" ADD CONSTRAINT "covert_medication_record_best_interests_fk" FOREIGN KEY ("tenant_id","person_id","best_interests_decision_id") REFERENCES "public"."best_interests_decision"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homely_remedy_administration" ADD CONSTRAINT "homely_remedy_administration_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homely_remedy_administration" ADD CONSTRAINT "homely_remedy_administration_given_by_fk" FOREIGN KEY ("tenant_id","given_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homely_remedy_administration" ADD CONSTRAINT "homely_remedy_administration_protocol_fk" FOREIGN KEY ("tenant_id","protocol_id") REFERENCES "public"."homely_remedy_protocol"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homely_remedy_administration" ADD CONSTRAINT "homely_remedy_administration_supersedes_fk" FOREIGN KEY ("tenant_id","person_id","supersedes_id") REFERENCES "public"."homely_remedy_administration"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homely_remedy_protocol" ADD CONSTRAINT "homely_remedy_protocol_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_administration_assessment" ADD CONSTRAINT "self_administration_assessment_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_administration_assessment" ADD CONSTRAINT "self_administration_assessment_assessed_by_fk" FOREIGN KEY ("tenant_id","assessed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_administration_assessment" ADD CONSTRAINT "self_administration_assessment_capacity_fk" FOREIGN KEY ("tenant_id","person_id","capacity_assessment_id") REFERENCES "public"."capacity_assessment"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "covert_medication_record_open_key" ON "covert_medication_record" USING btree ("tenant_id","medicine_id") WHERE ended_on IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "covert_medication_record_person_idx" ON "covert_medication_record" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "homely_remedy_administration_supersedes_key" ON "homely_remedy_administration" USING btree ("tenant_id","supersedes_id") WHERE supersedes_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "homely_remedy_administration_person_idx" ON "homely_remedy_administration" USING btree ("tenant_id","person_id","given_at");--> statement-breakpoint
CREATE INDEX "homely_remedy_protocol_location_idx" ON "homely_remedy_protocol" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE INDEX "self_administration_assessment_person_idx" ON "self_administration_assessment" USING btree ("tenant_id","person_id","assessed_on");--> statement-breakpoint
ALTER TABLE "medication_administration" ADD CONSTRAINT "medication_administration_flags" CHECK (flags <@ ARRAY['early', 'late', 'interval_override', 'competence_override',
        'amount_differs', 'entry_not_yet_checked', 'other_unit_not_counted', 'over_maximum',
        'before_window', 'earlier_dose_outstanding', 'entry_not_usable', 'no_usable_dosing_record',
        'amount_in_other_unit', 'competence_not_current', 'given_before_recorded',
        'given_by_someone_else', 'close_to_last_dose', 'clock_drift', 'corrected',
        'dose_removed', 'dose_moved', 'breach_created', 'breach_hidden', 'close_to_next_dose',
        'inside_minimum_interval', 'differs_when_recorded', 'covert_without_record',
        'covert_review_overdue', 'self_admin_not_assessed', 'self_admin_review_overdue']::text[]);--> statement-breakpoint
-- Covert, self-administration and homely remedies security (ADR-0002 patterns; medicines.md
-- section 15; slice 38). Runs as harbour_owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['covert_medication_record', 'self_administration_assessment',
      'homely_remedy_protocol', 'homely_remedy_administration'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
  -- Records about a person follow that person's scope.
  FOREACH t IN ARRAY ARRAY['covert_medication_record', 'self_administration_assessment',
      'homely_remedy_administration'] LOOP
    EXECUTE format(
      'CREATE POLICY person_child_scope ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner '
      'USING (app.person_visible(person_id)) WITH CHECK (app.person_visible(person_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- A covert record is written only by a holder of medicines.covert.manage at the person's home
-- (HZ-026), in the database as well as the API.
CREATE POLICY covert_medication_record_write ON public.covert_medication_record AS RESTRICTIVE
  FOR INSERT TO harbour_app
  WITH CHECK (app.holds_permission_at('medicines.covert.manage',
    (SELECT p.location_id FROM public.person p WHERE p.tenant_id = covert_medication_record.tenant_id AND p.id = covert_medication_record.person_id)));
--> statement-breakpoint
CREATE POLICY covert_medication_record_change ON public.covert_medication_record AS RESTRICTIVE
  FOR UPDATE TO harbour_app
  USING (app.holds_permission_at('medicines.covert.manage',
    (SELECT p.location_id FROM public.person p WHERE p.tenant_id = covert_medication_record.tenant_id AND p.id = covert_medication_record.person_id)))
  WITH CHECK (app.holds_permission_at('medicines.covert.manage',
    (SELECT p.location_id FROM public.person p WHERE p.tenant_id = covert_medication_record.tenant_id AND p.id = covert_medication_record.person_id)));
--> statement-breakpoint
-- Homely remedy protocols belong to a home: read where the home is in scope, written by a holder
-- of medicines.record.manage there.
CREATE POLICY homely_remedy_protocol_scope ON public.homely_remedy_protocol AS RESTRICTIVE
  FOR SELECT TO harbour_app, harbour_owner
  USING (app.handover_location_visible(location_id));
--> statement-breakpoint
CREATE POLICY homely_remedy_protocol_write ON public.homely_remedy_protocol AS RESTRICTIVE
  FOR INSERT TO harbour_app
  WITH CHECK (app.holds_permission_at('medicines.record.manage', location_id));
--> statement-breakpoint
CREATE POLICY homely_remedy_protocol_change ON public.homely_remedy_protocol AS RESTRICTIVE
  FOR UPDATE TO harbour_app
  USING (app.holds_permission_at('medicines.record.manage', location_id))
  WITH CHECK (app.holds_permission_at('medicines.record.manage', location_id));
--> statement-breakpoint
-- Who may write the records about a person, in the database as well as the API (security review,
-- 06/11/2026): the permission at the person's home, or through an assigned role (care workers),
-- whose people the person scope policy already limits. An assessment needs
-- medicines.record.manage; a homely remedy dose needs medicines.emar.administer; marking one entered
-- in error needs either.
CREATE OR REPLACE FUNCTION app.may_record_for_person(p_permission text, p_person_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.current_user_id() IS NOT NULL AND (
    app.holds_permission_at(p_permission,
      (SELECT p.location_id FROM public.person p
        WHERE p.tenant_id = app.current_tenant_id() AND p.id = p_person_id))
    OR EXISTS (
      SELECT 1
      FROM public.role_assignment ra
      JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
      WHERE ra.tenant_id = app.current_tenant_id()
        AND ra.tenant_user_id = app.current_user_id()
        AND ra.deleted_at IS NULL
        AND r.archived_at IS NULL
        AND ra.valid_from <= now()
        AND (ra.valid_to IS NULL OR ra.valid_to > now())
        AND r.scope_kind::text = 'assigned'
        AND NOT (r.permissions && ARRAY['comms.portal.family', 'comms.portal.self', 'comms.feed.read',
          'comms.notification.subscribe', 'comms.visit_booking.request']::text[])
        AND p_permission = ANY (r.permissions)))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.may_record_for_person(text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.may_record_for_person(text, uuid) TO harbour_app;
--> statement-breakpoint
CREATE POLICY self_administration_assessment_write ON public.self_administration_assessment
  AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.may_record_for_person('medicines.record.manage', person_id));
--> statement-breakpoint
CREATE POLICY homely_remedy_administration_write ON public.homely_remedy_administration
  AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.may_record_for_person('medicines.emar.administer', person_id)
    OR (outcome = 'entered_in_error'
        AND app.may_record_for_person('medicines.record.manage', person_id)));
--> statement-breakpoint

-- A covert record stands on the person's capacity assessment for covert medicines that found a
-- lack of capacity, and the best-interests decision after it, made with the prescriber and a
-- pharmacist (NICE SC1 1.15.3; HZ-026). Its medicine never changes; every change has a new reason;
-- an ended record is closed.
CREATE OR REPLACE FUNCTION app.covert_medication_record_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT m.medicine_id INTO NEW.medicine_id FROM public.medication m
     WHERE m.tenant_id = NEW.tenant_id AND m.person_id = NEW.person_id AND m.id = NEW.medication_id;
    IF NEW.change_reason IS NOT NULL OR NEW.ended_on IS NOT NULL OR NEW.reviewed_on IS NOT NULL THEN
      RAISE EXCEPTION 'covert_medication_record: a new record is open and unreviewed'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (NEW.person_id, NEW.medication_id, NEW.medicine_id)
       IS DISTINCT FROM (OLD.person_id, OLD.medication_id, OLD.medicine_id) THEN
      RAISE EXCEPTION 'covert_medication_record: the person and medicine never change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.ended_on IS NOT NULL OR OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'covert_medication_record_closed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.change_reason IS NULL OR length(btrim(NEW.change_reason)) = 0
       OR NEW.change_reason IS NOT DISTINCT FROM OLD.change_reason THEN
      RAISE EXCEPTION 'covert_medication_record_change_needs_reason'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.capacity_assessment c
                  WHERE c.tenant_id = NEW.tenant_id AND c.person_id = NEW.person_id
                    AND c.id = NEW.capacity_assessment_id AND c.outcome = 'lacks_capacity'
                    AND c.decision_kind = 'covert_medicines'
                    AND NOT EXISTS (SELECT 1 FROM public.capacity_assessment s
                                     WHERE s.tenant_id = c.tenant_id AND s.supersedes_id = c.id))
     OR NOT EXISTS (SELECT 1 FROM public.best_interests_decision b
                     WHERE b.tenant_id = NEW.tenant_id AND b.person_id = NEW.person_id
                       AND b.id = NEW.best_interests_decision_id
                       AND b.capacity_assessment_id = NEW.capacity_assessment_id
                       AND NOT EXISTS (SELECT 1 FROM public.best_interests_decision s
                                        WHERE s.tenant_id = b.tenant_id AND s.supersedes_id = b.id)) THEN
    RAISE EXCEPTION 'covert_medication_record_needs_lack_of_capacity_and_best_interests'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (NEW.attendees @> '[{"role": "prescriber"}]'::jsonb
          AND NEW.attendees @> '[{"role": "pharmacist"}]'::jsonb) THEN
    RAISE EXCEPTION 'covert_medication_record_needs_prescriber_and_pharmacist'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER covert_medication_record_guard
  BEFORE INSERT OR UPDATE ON public.covert_medication_record
  FOR EACH ROW EXECUTE FUNCTION app.covert_medication_record_guard();
--> statement-breakpoint

-- A self-administration assessment covers only the person's own medicines, and a linked capacity
-- assessment is theirs, current and says what the assessment records (HZ-120).
CREATE OR REPLACE FUNCTION app.self_administration_assessment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.recorded_at := now();
  IF NEW.assessed_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'self_administration_assessment_not_the_assessor'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.medicine_ids) AS x(medicine_id)
              WHERE NOT EXISTS (SELECT 1 FROM public.medication m
                                 WHERE m.tenant_id = NEW.tenant_id AND m.person_id = NEW.person_id
                                   AND m.medicine_id = x.medicine_id)) THEN
    RAISE EXCEPTION 'self_administration_assessment_other_medicine'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.capacity_assessment_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.capacity_assessment c
        WHERE c.tenant_id = NEW.tenant_id AND c.person_id = NEW.person_id
          AND c.id = NEW.capacity_assessment_id AND c.outcome = NEW.capacity
          AND NOT EXISTS (SELECT 1 FROM public.capacity_assessment s
                           WHERE s.tenant_id = c.tenant_id AND s.supersedes_id = c.id)) THEN
    RAISE EXCEPTION 'self_administration_assessment_capacity_mismatch'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER self_administration_assessment_guard
  BEFORE INSERT ON public.self_administration_assessment
  FOR EACH ROW EXECUTE FUNCTION app.self_administration_assessment_guard();
--> statement-breakpoint

-- A protocol's home never changes, every change has a new reason, and a withdrawn protocol is
-- closed (HZ-120).
CREATE OR REPLACE FUNCTION app.homely_remedy_protocol_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.change_reason IS NOT NULL OR NEW.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'homely_remedy_protocol: a new protocol is in use'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    RAISE EXCEPTION 'homely_remedy_protocol: the home never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL OR OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'homely_remedy_protocol_closed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.change_reason IS NULL OR length(btrim(NEW.change_reason)) = 0
     OR NEW.change_reason IS NOT DISTINCT FROM OLD.change_reason THEN
    RAISE EXCEPTION 'homely_remedy_protocol_change_needs_reason' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER homely_remedy_protocol_guard
  BEFORE INSERT OR UPDATE ON public.homely_remedy_protocol
  FOR EACH ROW EXECUTE FUNCTION app.homely_remedy_protocol_guard();
--> statement-breakpoint

-- A homely remedy dose is stored at the server's time, for a person at the protocol's home, given
-- by a member the protocol names, against its current version; a record entered in error marks a
-- dose of the same person and protocol (HZ-120).
CREATE OR REPLACE FUNCTION app.homely_remedy_administration_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE pr public.homely_remedy_protocol;
DECLARE original public.homely_remedy_administration;
BEGIN
  NEW.recorded_at := now();
  -- The member recording is the member named: never another member's id.
  IF NEW.given_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'homely_remedy_administration_not_the_recorder'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO pr FROM public.homely_remedy_protocol h
   WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.protocol_id;
  IF NEW.outcome = 'given' THEN
    -- A dose given within the protocol carries no flags; one already given outside it is recorded
    -- with what the check found, and its reason (the API escalates it).
    IF NOT FOUND OR pr.version <> NEW.protocol_version
       OR (cardinality(NEW.flags) = 0 AND (pr.withdrawn_at IS NOT NULL OR pr.deleted_at IS NOT NULL
           OR NOT (NEW.given_by = ANY (pr.authorised_member_ids))))
       OR NOT EXISTS (SELECT 1 FROM public.person p WHERE p.tenant_id = NEW.tenant_id
                        AND p.id = NEW.person_id AND p.location_id = pr.location_id) THEN
      RAISE EXCEPTION 'homely_remedy_administration_outside_protocol'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO original FROM public.homely_remedy_administration o
     WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.supersedes_id;
    IF NOT FOUND OR original.outcome <> 'given' OR original.person_id <> NEW.person_id
       OR original.protocol_id <> NEW.protocol_id
       -- Marked by the member who gave it, or by a holder of medicines.record.manage there.
       OR NOT (original.given_by = NEW.given_by OR app.holds_permission_at('medicines.record.manage',
         (SELECT p.location_id FROM public.person p
           WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.person_id))) THEN
      RAISE EXCEPTION 'homely_remedy_administration: a correction stays with its dose'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER homely_remedy_administration_insert
  BEFORE INSERT ON public.homely_remedy_administration
  FOR EACH ROW EXECUTE FUNCTION app.homely_remedy_administration_insert();
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['covert_medication_record', 'homely_remedy_protocol'] LOOP
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['self_administration_assessment', 'homely_remedy_administration'] LOOP
    EXECUTE format(
      'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format(
      'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.covert_medication_record, public.homely_remedy_protocol
  TO harbour_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.self_administration_assessment, public.homely_remedy_administration
  TO harbour_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.covert_medication_record, public.homely_remedy_protocol
  FROM harbour_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.self_administration_assessment,
  public.homely_remedy_administration FROM harbour_app;
--> statement-breakpoint
-- Not published to devices yet: the round stream is a contract (medicines.md 13.8, slice 68).
--> statement-breakpoint
-- Sample data mode (migration 0069, HZ-072): a sample person's covert records, self-administration
-- assessments and homely remedy doses go with them, before the entries, capacity assessments and
-- best-interests decisions they reference. As the highest migration of batch 3b this states the
-- union of every list (0069 to 0139), children before the tables they reference.
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
    'covert_medication_record', 'self_administration_assessment', 'homely_remedy_administration',
    'outbreak_case', 'missing_event', 'missing_episode', 'medication_review',
    'medicine_stock_movement', 'medicine_disposal', 'medicine_order_line', 'medicine_stock_item',
    'controlled_drug_stock_check', 'controlled_drug_entry', 'controlled_drug_witness_assertion',
    'controlled_drug_page', 'medication_administration_witness',
    'medication_administration_conflict', 'medication_error', 'medication_administration',
    'medication_dosing_record', 'medication_reconciliation_decision',
    'medication_reconciliation_item', 'medication_reconciliation_source', 'medication_schedule',
    'medication', 'medication_reconciliation', 'dependency_assessment', 'about_me',
    'about_me_share_link', 'activity_record', 'admission_condition', 'advance_care_record',
    'allergy', 'assessment', 'bed_occupancy', 'body_map_mark', 'break_glass_event',
    'candour_record', 'care_note', 'care_plan_action', 'care_plan_change', 'consent_record',
    'document_signature', 'dols_legal_change_review', 'entry_device_deletion_flag',
    'exit_checklist_item', 'family_portal_user', 'feed_item_withdrawal', 'feed_view',
    'handover_note', 'incident_person', 'key_issue', 'legal_hold', 'letter',
    'notification_delivery', 'observation', 'person_assignment', 'person_care_profile',
    'property_item', 'refused_entry', 'sharing_decision_suspension', 'safeguarding_concern',
    'statutory_notification', 'visit_log', 'welcome_checklist_item', 'workflow_transition',
    'care_plan_section', 'dols_authorisation', 'death_step', 'death_record', 'exit_record',
    'feed_item', 'handover_item', 'hospital_transfer', 'notification', 'placement',
    'review_record', 'risk_assessment', 'sharing_decision', 'task', 'admission_decision',
    'best_interests_decision', 'care_plan', 'herbert_profile', 'ocr_field', 'ocr_extraction',
    'document', 'task_series', 'workflow_instance', 'capacity_assessment', 'contact',
    'pre_admission_assessment'
  ]::text[]
$$;--> statement-breakpoint
GRANT SELECT, DELETE ON public.covert_medication_record, public.self_administration_assessment,
  public.homely_remedy_administration TO harbour_sample_owner;

--> statement-breakpoint
-- Data migration: existing tenants' copies of the built-in roles gain medicines.covert.manage, as
-- the built-in definitions (packages/domain/src/platform/roles.ts) now give it: the owner, the
-- Registered Manager, the deputy and the clinical lead. Each change is audited in the same
-- transaction (platform.role.permissions_migrated), as migration 0074 does. Idempotent.
ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.role WHERE is_builtin ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    WITH grants(key, add) AS (VALUES
        ('owner', ARRAY['medicines.covert.manage']),
        ('registered_manager', ARRAY['medicines.covert.manage']),
        ('deputy_manager', ARRAY['medicines.covert.manage']),
        ('clinical_lead', ARRAY['medicines.covert.manage'])
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
        jsonb_build_object('migration', '0140_medicines_covert_self_admin', 'roleKey', x.key,
          'added', to_jsonb(x.missing)),
        'Existing tenants'' built-in role copies gained the covert medicines permission their built-in definitions added (migration 0140)'
      FROM targets x JOIN changed c ON c.id = x.id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.role FORCE ROW LEVEL SECURITY;
