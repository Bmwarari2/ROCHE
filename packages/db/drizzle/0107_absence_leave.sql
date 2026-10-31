CREATE TABLE "absence" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"member_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"state" text NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"self_certified_at" timestamp with time zone,
	"bradford_excluded_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "absence_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "absence_kind" CHECK (kind IN ('annual_leave', 'sickness', 'compassionate', 'carers_leave', 'parental_leave', 'maternity', 'paternity', 'adoption', 'parental_bereavement', 'unpaid', 'other')),
	CONSTRAINT "absence_state" CHECK (state IN ('requested', 'approved', 'declined', 'postponed', 'cancelled', 'recorded')),
	CONSTRAINT "absence_dates" CHECK ((ends_on IS NULL OR ends_on >= starts_on) AND (ends_on IS NOT NULL OR kind = 'sickness')),
	CONSTRAINT "absence_decision" CHECK ((state NOT IN ('approved', 'declined', 'postponed') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
        AND (state NOT IN ('requested', 'recorded') OR (decided_by IS NULL AND decided_at IS NULL))),
	CONSTRAINT "absence_decider_is_member" CHECK (decided_by IS DISTINCT FROM member_id),
	CONSTRAINT "absence_reason" CHECK ((state NOT IN ('declined', 'postponed') OR decision_reason IS NOT NULL)
        AND (decision_reason IS NULL OR char_length(btrim(decision_reason)) BETWEEN 3 AND 500)
        AND (bradford_excluded_reason IS NULL OR (kind = 'sickness' AND char_length(btrim(bradford_excluded_reason)) BETWEEN 3 AND 500))),
	CONSTRAINT "absence_self_certified" CHECK (self_certified_at IS NULL OR kind = 'sickness'),
	CONSTRAINT "absence_statutory" CHECK ((state <> 'declined' OR kind NOT IN ('maternity', 'paternity', 'adoption', 'parental_bereavement', 'carers_leave', 'parental_leave'))
        AND (state <> 'postponed' OR kind IN ('carers_leave', 'parental_leave')))
);
--> statement-breakpoint
CREATE TABLE "fit_note" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"absence_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"issued_on" date NOT NULL,
	"covers_from" date NOT NULL,
	"covers_to" date NOT NULL,
	"fitness" text NOT NULL,
	"phased_return" boolean DEFAULT false NOT NULL,
	"amended_duties" boolean DEFAULT false NOT NULL,
	"altered_hours" boolean DEFAULT false NOT NULL,
	"workplace_adaptations" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "fit_note_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "fit_note_fitness" CHECK (fitness IN ('not_fit', 'may_be_fit')),
	CONSTRAINT "fit_note_dates" CHECK (covers_to >= covers_from AND issued_on <= covers_to),
	CONSTRAINT "fit_note_adjustments" CHECK (fitness = 'may_be_fit' OR NOT (phased_return OR amended_duties OR altered_hours OR workplace_adaptations))
);
--> statement-breakpoint
CREATE TABLE "return_to_work" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"absence_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"held_on" date NOT NULL,
	"held_by" uuid NOT NULL,
	"fit_for_usual_duties" boolean NOT NULL,
	"phased_return" boolean DEFAULT false NOT NULL,
	"amended_duties" boolean DEFAULT false NOT NULL,
	"altered_hours" boolean DEFAULT false NOT NULL,
	"workplace_adaptations" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "return_to_work_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "return_to_work_holder" CHECK (held_by IS DISTINCT FROM member_id),
	CONSTRAINT "return_to_work_notes" CHECK (notes IS NULL OR char_length(btrim(notes)) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE TABLE "shift_cover_need" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"shift_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"absence_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "shift_cover_need_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "shift_cover_need_resolution" CHECK ((resolved_at IS NULL) = (resolution IS NULL)
        AND (resolution IS NULL OR resolution IN ('assignment_removed', 'absence_ended')))
);
--> statement-breakpoint
ALTER TABLE "absence" ADD CONSTRAINT "absence_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence" ADD CONSTRAINT "absence_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence" ADD CONSTRAINT "absence_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fit_note" ADD CONSTRAINT "fit_note_absence_fk" FOREIGN KEY ("tenant_id","absence_id") REFERENCES "public"."absence"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fit_note" ADD CONSTRAINT "fit_note_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fit_note" ADD CONSTRAINT "fit_note_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_to_work" ADD CONSTRAINT "return_to_work_absence_fk" FOREIGN KEY ("tenant_id","absence_id") REFERENCES "public"."absence"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_to_work" ADD CONSTRAINT "return_to_work_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_to_work" ADD CONSTRAINT "return_to_work_held_by_fk" FOREIGN KEY ("tenant_id","held_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_to_work" ADD CONSTRAINT "return_to_work_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_cover_need" ADD CONSTRAINT "shift_cover_need_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shift"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_cover_need" ADD CONSTRAINT "shift_cover_need_assignment_fk" FOREIGN KEY ("tenant_id","assignment_id") REFERENCES "public"."shift_assignment"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_cover_need" ADD CONSTRAINT "shift_cover_need_absence_fk" FOREIGN KEY ("tenant_id","absence_id") REFERENCES "public"."absence"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_cover_need" ADD CONSTRAINT "shift_cover_need_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "absence_member_idx" ON "absence" USING btree ("tenant_id","member_id","starts_on");--> statement-breakpoint
CREATE INDEX "absence_location_idx" ON "absence" USING btree ("tenant_id","location_id","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "fit_note_document_key" ON "fit_note" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE INDEX "fit_note_absence_idx" ON "fit_note" USING btree ("tenant_id","absence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_to_work_absence_key" ON "return_to_work" USING btree ("tenant_id","absence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_cover_need_open_key" ON "shift_cover_need" USING btree ("tenant_id","assignment_id","absence_id") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "shift_cover_need_shift_idx" ON "shift_cover_need" USING btree ("tenant_id","shift_id");--> statement-breakpoint

-- Absence and leave (scheduling.md section 15; SCHED-010; hazards HZ-123 and HZ-124).
-- Forced row-level security with the tenant policy on every table (ADR-0002).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['absence', 'fit_note', 'return_to_work', 'shift_cover_need'] LOOP
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

-- An absence: its member reads their own (scheduling.timesheet.self through any role); rota
-- managers and approvers read those at their home; the system reads for the export, never writes.
CREATE POLICY absence_read ON public.absence AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.is_system()
    OR (member_id = app.current_user_id() AND app.holds_self_permission('scheduling.timesheet.self'))
    OR app.holds_permission_at('scheduling.rota.manage', location_id)
    OR app.holds_permission_at('scheduling.rota.approve', location_id));
--> statement-breakpoint
-- A member asks for their own leave; a rota manager records an absence for a member there.
CREATE POLICY absence_insert ON public.absence AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.current_user_id() IS NOT NULL
    AND decided_by IS NULL AND created_by = app.current_user_id()
    AND ((state = 'requested' AND member_id = app.current_user_id()
          AND app.holds_self_permission('scheduling.timesheet.self'))
      OR (state = 'recorded' AND member_id <> app.current_user_id()
          AND app.holds_permission_at('scheduling.rota.manage', location_id))));
--> statement-breakpoint
CREATE POLICY absence_update ON public.absence AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (app.current_user_id() IS NOT NULL AND (
    (member_id = app.current_user_id() AND app.holds_self_permission('scheduling.timesheet.self'))
    OR app.holds_permission_at('scheduling.rota.manage', location_id)
    OR app.holds_permission_at('scheduling.rota.approve', location_id)))
  WITH CHECK (app.current_user_id() IS NOT NULL);
--> statement-breakpoint
-- Who may move an absence, and what never changes (rule 1): member, home and kind are fixed; a
-- decision is made in the decider's own name by a holder of scheduling.rota.approve there, never
-- the member; the member only cancels their own request; nothing moves back.
CREATE OR REPLACE FUNCTION app.absence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  me uuid := app.current_user_id();
BEGIN
  IF NEW.member_id IS DISTINCT FROM OLD.member_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.starts_on IS DISTINCT FROM OLD.starts_on
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'absence_fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state = 'requested' AND NEW.state IN ('approved', 'declined', 'postponed', 'cancelled'))
        OR (OLD.state IN ('approved', 'recorded') AND NEW.state = 'cancelled')) THEN
      RAISE EXCEPTION 'absence_wrong_state' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state IN ('approved', 'declined', 'postponed') THEN
      IF NEW.decided_by IS DISTINCT FROM me THEN
        RAISE EXCEPTION 'absence_decider_not_you' USING ERRCODE = 'check_violation';
      END IF;
      IF me = OLD.member_id OR NOT app.holds_permission_at('scheduling.rota.approve', OLD.location_id) THEN
        RAISE EXCEPTION 'absence_decider_is_member' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.state = 'cancelled' AND me = OLD.member_id AND OLD.state <> 'requested' THEN
      RAISE EXCEPTION 'absence_member_cancels_request_only' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
     OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason THEN
    RAISE EXCEPTION 'absence_decision_fixed' USING ERRCODE = 'check_violation';
  END IF;
  -- Leaving a sickness out of the Bradford factor is HR's, at the home, never for oneself.
  IF NEW.bradford_excluded_reason IS DISTINCT FROM OLD.bradford_excluded_reason
     AND (me IS NULL OR me = OLD.member_id
       OR NOT app.holds_permission_at('workforce.hr_document.read', OLD.location_id)) THEN
    RAISE EXCEPTION 'absence_bradford_not_yours' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('declined', 'postponed', 'cancelled') THEN
    RAISE EXCEPTION 'absence_closed' USING ERRCODE = 'check_violation';
  END IF;
  -- A member changes nothing on an absence but cancelling their own request.
  IF me = OLD.member_id AND NOT app.holds_permission_at('scheduling.rota.manage', OLD.location_id)
     AND (NEW.ends_on IS DISTINCT FROM OLD.ends_on
       OR NEW.self_certified_at IS DISTINCT FROM OLD.self_certified_at
       OR NEW.bradford_excluded_reason IS DISTINCT FROM OLD.bradford_excluded_reason) THEN
    RAISE EXCEPTION 'absence_member_changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER absence_guard BEFORE UPDATE ON public.absence
  FOR EACH ROW EXECUTE FUNCTION app.absence_guard();
--> statement-breakpoint

-- Health data (fit notes, return to work): workforce.hr_document.read at the home, or the member's
-- own; never a rota manager without it. Written only by a holder there, in their own name.
CREATE POLICY absence_health_read ON public.fit_note AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.is_system() OR app.holds_permission_at('workforce.hr_document.read', location_id)
    OR EXISTS (SELECT 1 FROM public.absence a WHERE a.tenant_id = fit_note.tenant_id
      AND a.id = fit_note.absence_id AND a.member_id = app.current_user_id()));
--> statement-breakpoint
CREATE POLICY absence_health_insert ON public.fit_note AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.holds_permission_at('workforce.hr_document.read', location_id)
    AND created_by = app.current_user_id()
    AND EXISTS (SELECT 1 FROM public.absence a WHERE a.tenant_id = fit_note.tenant_id
      AND a.id = fit_note.absence_id AND a.kind = 'sickness' AND a.location_id = fit_note.location_id
      AND a.member_id <> app.current_user_id() AND a.state IN ('recorded', 'approved')));
--> statement-breakpoint
CREATE POLICY absence_health_read ON public.return_to_work AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.is_system() OR app.holds_permission_at('workforce.hr_document.read', location_id)
    OR member_id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY absence_health_insert ON public.return_to_work AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.holds_permission_at('workforce.hr_document.read', location_id)
    AND created_by = app.current_user_id() AND held_by = app.current_user_id()
    AND EXISTS (SELECT 1 FROM public.absence a WHERE a.tenant_id = return_to_work.tenant_id
      AND a.id = return_to_work.absence_id AND a.kind = 'sickness'
      AND a.location_id = return_to_work.location_id AND a.member_id = return_to_work.member_id
      AND a.ends_on IS NOT NULL AND a.state IN ('recorded', 'approved')));
--> statement-breakpoint

-- Cover needs (HZ-123): read by those who read the shift's rota; raised by whoever approves or
-- records the absence (the approver or a rota manager at the absence's home), for an assignment
-- of the absence's own member; resolved once, by a rota manager at the shift's home or the same.
CREATE POLICY cover_read ON public.shift_cover_need AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.reads_rota(location_id)
    OR app.holds_permission_at('scheduling.rota.approve', location_id)
    -- Whoever decides or records the absence sees the needs it raised, at any home (ids only).
    OR EXISTS (SELECT 1 FROM public.absence a WHERE a.tenant_id = shift_cover_need.tenant_id
      AND a.id = shift_cover_need.absence_id
      AND (app.holds_permission_at('scheduling.rota.approve', a.location_id)
        OR app.holds_permission_at('scheduling.rota.manage', a.location_id))));
--> statement-breakpoint
CREATE POLICY cover_insert ON public.shift_cover_need AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.current_user_id() IS NOT NULL AND resolved_at IS NULL
    AND EXISTS (SELECT 1 FROM public.absence a
      JOIN public.shift_assignment sa ON sa.tenant_id = a.tenant_id AND sa.id = shift_cover_need.assignment_id
      WHERE a.tenant_id = shift_cover_need.tenant_id AND a.id = shift_cover_need.absence_id
        AND sa.worker_id = a.member_id AND sa.shift_id = shift_cover_need.shift_id
        AND sa.location_id = shift_cover_need.location_id
        AND a.state IN ('approved', 'recorded')
        AND (app.holds_permission_at('scheduling.rota.approve', a.location_id)
          OR app.holds_permission_at('scheduling.rota.manage', a.location_id))));
--> statement-breakpoint
CREATE POLICY cover_update ON public.shift_cover_need AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (app.current_user_id() IS NOT NULL AND (app.manages_rota(location_id)
    OR app.holds_permission_at('scheduling.rota.approve', location_id)
    OR EXISTS (SELECT 1 FROM public.absence a WHERE a.tenant_id = shift_cover_need.tenant_id
      AND a.id = shift_cover_need.absence_id
      AND (app.holds_permission_at('scheduling.rota.manage', a.location_id)
        OR app.holds_permission_at('scheduling.rota.approve', a.location_id)))))
  WITH CHECK (app.current_user_id() IS NOT NULL);
--> statement-breakpoint
-- A cover need is resolved once and otherwise never changes.
CREATE OR REPLACE FUNCTION app.shift_cover_need_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolved_at IS NOT NULL
     OR NEW.shift_id IS DISTINCT FROM OLD.shift_id OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.absence_id IS DISTINCT FROM OLD.absence_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.raised_at IS DISTINCT FROM OLD.raised_at OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.resolved_at IS NULL THEN
    RAISE EXCEPTION 'cover_need_fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER shift_cover_need_guard BEFORE UPDATE ON public.shift_cover_need
  FOR EACH ROW EXECUTE FUNCTION app.shift_cover_need_guard();
--> statement-breakpoint

-- The absence is mutable (version bump, record_version, never deleted); fit notes and return to
-- work records are append-only; cover needs are resolved once (above) and never deleted.
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.absence
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.absence
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['absence', 'shift_cover_need'] LOOP
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['fit_note', 'return_to_work'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.absence, public.shift_cover_need TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.fit_note, public.return_to_work TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.absence, public.shift_cover_need FROM harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.fit_note, public.return_to_work FROM harbour_app;
--> statement-breakpoint

-- Earlier versions of an absence may hold the Bradford exclusion reason (HR's only): they are read
-- by holders of workforce.hr_document.read at its home, or by the system.
CREATE POLICY record_version_absence ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (table_name <> 'absence' OR app.is_system()
    OR app.holds_permission_at('workforce.hr_document.read', (data->>'location_id')::uuid));
--> statement-breakpoint

-- A fit note is an HR-only staff document (rule 3): added by a holder of
-- workforce.hr_document.read for someone else's absence, never their own, and read as other HR-only
-- documents are (by holders of workforce.hr_document.read, never about themselves). The compliance
-- item case is unchanged from migration 0073.
-- Whose absence a fit note is about, whatever the reader's own view of absences (definer: as
-- app.compliance_item_member answers for staff files).
CREATE OR REPLACE FUNCTION app.absence_member(p_absence_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.member_id FROM public.absence a
  WHERE a.tenant_id = app.current_tenant_id() AND a.id = p_absence_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.absence_member(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.absence_member(uuid) TO harbour_app;
--> statement-breakpoint
DROP POLICY document_hr_only ON public.document;
--> statement-breakpoint
CREATE POLICY document_hr_only ON public.document AS RESTRICTIVE FOR ALL TO harbour_app
  USING (category <> 'staff_hr_document' OR app.is_system()
    OR (app.holds_staff_permission('workforce.hr_document.read')
        AND app.compliance_item_member(subject_id) IS DISTINCT FROM app.current_user_id()
        AND (subject_type <> 'fit_note'
          OR app.absence_member(subject_id) IS DISTINCT FROM app.current_user_id())))
  WITH CHECK (category <> 'staff_hr_document' OR app.is_system()
    OR (app.holds_staff_permission('workforce.hr_document.read')
        AND app.holds_staff_permission('workforce.staff_file.manage')
        AND person_id IS NULL
        AND subject_type = 'compliance_item'
        AND app.compliance_item_member(subject_id) <> app.current_user_id())
    OR (app.holds_staff_permission('workforce.hr_document.read')
        AND person_id IS NULL
        AND subject_type = 'fit_note'
        AND app.absence_member(subject_id) <> app.current_user_id()));
--> statement-breakpoint

-- HZ-123: a cover need on a shift at any home of the organisation, raised by whoever approves or
-- records the absence (who may not read that home's rota). Definer rights only to see the
-- assignment; it checks the caller holds scheduling.rota.approve or .manage at the absence's home,
-- the absence takes the member away, and the assignment is the member's own and live. Returns the
-- new need's id, or null when one is already open.
CREATE OR REPLACE FUNCTION app.raise_cover_need(p_assignment_id uuid, p_absence_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  a public.absence%ROWTYPE;
  sa public.shift_assignment%ROWTYPE;
  made uuid;
  raised integer;
BEGIN
  IF app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'cover_need_not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO a FROM public.absence
    WHERE tenant_id = app.current_tenant_id() AND id = p_absence_id;
  IF NOT FOUND OR a.state NOT IN ('approved', 'recorded')
     OR NOT (app.holds_permission_at('scheduling.rota.approve', a.location_id)
       OR app.holds_permission_at('scheduling.rota.manage', a.location_id)) THEN
    RAISE EXCEPTION 'cover_need_not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO sa FROM public.shift_assignment
    WHERE tenant_id = a.tenant_id AND id = p_assignment_id AND deleted_at IS NULL;
  IF NOT FOUND OR sa.worker_id <> a.member_id THEN
    RAISE EXCEPTION 'cover_need_not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  made := app.uuid_v7();
  INSERT INTO public.shift_cover_need (id, tenant_id, shift_id, assignment_id, absence_id, location_id, created_by)
    VALUES (made, a.tenant_id, sa.shift_id, sa.id, a.id, sa.location_id, app.current_user_id())
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS raised = ROW_COUNT;
  IF raised = 0 THEN
    made := NULL;
  END IF;
  -- A published shift that loses its worker is a change since publication (notice is owed).
  UPDATE public.shift SET changed_after_publish_at = now()
    WHERE tenant_id = a.tenant_id AND id = sa.shift_id AND published_at IS NOT NULL;
  RETURN made;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.raise_cover_need(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.raise_cover_need(uuid, uuid) TO harbour_app;
--> statement-breakpoint

-- One cover task per cover need, whatever the worker's lock does (scheduling.md section 15 rule 7;
-- security review of the cover task, finding 4).
CREATE UNIQUE INDEX task_cover_need_key ON public.task (tenant_id, source_id)
  WHERE kind = 'scheduling.cover_needed' AND source_type = 'shift_cover_need' AND deleted_at IS NULL;
--> statement-breakpoint

-- H-830 (recommended answer applied 31/10/2026; ADR-0099): no override covers a member with no
-- DBS certificate at all (an Adult First check with a signed risk assessment is the lawful
-- supervised start) or a lapsed or missing registration. As migration 0083's guard, with the keys
-- refused here as well as in the domain (`neverOverridable`).
CREATE OR REPLACE FUNCTION app.roster_override_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF 'dbs:no_certificate' = ANY (NEW.blocker_keys) OR 'registration' = ANY (NEW.blocker_keys) THEN
    RAISE EXCEPTION 'roster_override_never_allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.shift_assignment a
    WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.assignment_id AND a.deleted_at IS NULL
      AND a.location_id = NEW.location_id AND a.worker_id = NEW.worker_id
      AND a.created_at = now()) THEN
    RAISE EXCEPTION 'An override is for a live assignment of its worker at its location'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Columns and table for H-692, H-693 and H-835 (generated by Drizzle).
CREATE TABLE "supervision_note" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"supervision_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"held_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"topics" text[] DEFAULT '{}' NOT NULL,
	"actions_agreed" text,
	"next_due_on" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supervision_note_supervision_key" UNIQUE("tenant_id","supervision_id"),
	CONSTRAINT "supervision_note_sizes" CHECK (cardinality(topics) <= 20 AND (actions_agreed IS NULL OR char_length(actions_agreed) <= 2000)
        AND (note IS NULL OR char_length(note) <= 4000))
);
--> statement-breakpoint
ALTER TABLE "compliance_item" DROP CONSTRAINT "compliance_item_kind";
--> statement-breakpoint
ALTER TABLE "revalidation_evidence" ADD COLUMN "review_state" text DEFAULT 'draft' NOT NULL;
--> statement-breakpoint
ALTER TABLE "revalidation_evidence" ADD COLUMN "reviewed_by" uuid;
--> statement-breakpoint
ALTER TABLE "revalidation_evidence" ADD COLUMN "reviewed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "revalidation_evidence" ADD COLUMN "confirmed_by" uuid;
--> statement-breakpoint
ALTER TABLE "revalidation_evidence" ADD COLUMN "confirmed_on" date;
--> statement-breakpoint
ALTER TABLE "supervision_note" ADD CONSTRAINT "supervision_note_supervision_fk" FOREIGN KEY ("tenant_id","supervision_id") REFERENCES "public"."supervision_record"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "supervision_note" ADD CONSTRAINT "supervision_note_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "supervision_note" ADD CONSTRAINT "supervision_note_held_by_fk" FOREIGN KEY ("tenant_id","held_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "revalidation_evidence" ADD CONSTRAINT "revalidation_evidence_reviewed_by_fk" FOREIGN KEY ("tenant_id","reviewed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "revalidation_evidence" ADD CONSTRAINT "revalidation_evidence_confirmed_by_fk" FOREIGN KEY ("tenant_id","confirmed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "compliance_item" ADD CONSTRAINT "compliance_item_kind" CHECK (kind IN ('identity_with_photo', 'dbs_certificate', 'conduct_in_care_work', 'references', 'relevant_qualifications', 'employment_history', 'health_fitness', 'right_to_work', 'professional_registration', 'driving_for_work'));
--> statement-breakpoint
ALTER TABLE "revalidation_evidence" ADD CONSTRAINT "revalidation_evidence_review_state" CHECK (review_state IN ('draft', 'submitted', 'reviewed'));
--> statement-breakpoint
ALTER TABLE "revalidation_evidence" ADD CONSTRAINT "revalidation_evidence_reviewed" CHECK ((review_state = 'reviewed') = (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
        AND reviewed_by IS DISTINCT FROM worker_id);
--> statement-breakpoint
-- An earlier confirmation names no confirmer, so it is cleared, to be confirmed again in the
-- confirmer's own name (H-693; never attributed to whoever last edited the record).
UPDATE public.revalidation_evidence SET confirmation = false WHERE confirmation;
--> statement-breakpoint
ALTER TABLE "revalidation_evidence" ADD CONSTRAINT "revalidation_evidence_confirmed" CHECK (confirmation = (confirmed_by IS NOT NULL AND confirmed_on IS NOT NULL)
        AND confirmed_by IS DISTINCT FROM worker_id);

--> statement-breakpoint

-- Recommended answers applied 31/10/2026 (review at testing): H-692, H-693 and H-835. The
-- columns and table above are Drizzle's; what follows is the security that goes with them.
-- H-692: supervision notes are read only by the supervisor who held the supervision, the
-- supervisee, and holders of workforce.hr_document.read; written once by the supervisor, with the
-- supervision, never for themselves.
ALTER TABLE public.supervision_note ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.supervision_note FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.supervision_note AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY supervision_note_read ON public.supervision_note AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING ((app.is_system() OR held_by = app.current_user_id() OR worker_id = app.current_user_id()
      OR app.holds_staff_permission('workforce.hr_document.read'))
    -- Never once its supervision was removed (recorded in error, the wrong person).
    AND EXISTS (SELECT 1 FROM public.supervision_record r
      WHERE r.tenant_id = supervision_note.tenant_id AND r.id = supervision_note.supervision_id
        AND r.deleted_at IS NULL));
--> statement-breakpoint
CREATE POLICY supervision_note_insert ON public.supervision_note AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (held_by = app.current_user_id() AND worker_id <> app.current_user_id()
    AND EXISTS (SELECT 1 FROM public.supervision_record r
      WHERE r.tenant_id = supervision_note.tenant_id AND r.id = supervision_note.supervision_id
        AND r.held_by = app.current_user_id() AND r.worker_id = supervision_note.worker_id));
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.supervision_note
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.supervision_note
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON public.supervision_note TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.supervision_note FROM harbour_app;
--> statement-breakpoint
-- Earlier versions of a supervision record carry nothing of its note; the note has no versions.

-- H-693: a registered nurse writes their own revalidation evidence (never the confirmation, never
-- the review); HR (workforce.training.manage) writes and reviews it for someone else; the
-- confirmation is recorded only by the confirmer, in their own name, never the nurse (HR or a line
-- manager holding workforce.supervision.manage).
DROP POLICY revalidation_evidence_insert ON public.revalidation_evidence;
--> statement-breakpoint
DROP POLICY revalidation_evidence_update ON public.revalidation_evidence;
--> statement-breakpoint
CREATE POLICY revalidation_evidence_insert ON public.revalidation_evidence AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.is_system()
    OR (app.holds_staff_permission('workforce.training.manage') AND worker_id <> app.current_user_id())
    OR (worker_id = app.current_user_id() AND app.holds_staff_permission('workforce.self.read')
      AND NOT confirmation AND review_state IN ('draft', 'submitted')));
--> statement-breakpoint
CREATE POLICY revalidation_evidence_update ON public.revalidation_evidence AS RESTRICTIVE FOR UPDATE
  TO harbour_app
  USING (app.is_system()
    OR ((app.holds_staff_permission('workforce.training.manage')
        OR app.holds_staff_permission('workforce.supervision.manage'))
      AND worker_id <> app.current_user_id())
    OR (worker_id = app.current_user_id() AND app.holds_staff_permission('workforce.self.read')))
  WITH CHECK (app.is_system()
    OR ((app.holds_staff_permission('workforce.training.manage')
        OR app.holds_staff_permission('workforce.supervision.manage'))
      AND worker_id <> app.current_user_id())
    OR (worker_id = app.current_user_id() AND app.holds_staff_permission('workforce.self.read')));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.revalidation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  me uuid := app.current_user_id();
  hr boolean := app.holds_staff_permission('workforce.training.manage');
  was_confirmed boolean := TG_OP = 'UPDATE' AND OLD.confirmation;
  was_state text := CASE WHEN TG_OP = 'UPDATE' THEN OLD.review_state ELSE 'draft' END;
  confirmation_changed boolean := TG_OP = 'UPDATE' AND (
    NEW.confirmation IS DISTINCT FROM OLD.confirmation
    OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
    OR NEW.confirmed_on IS DISTINCT FROM OLD.confirmed_on);
  counts_changed boolean := TG_OP = 'INSERT' OR (
    NEW.practice_hours, NEW.cpd_hours, NEW.participatory_cpd_hours, NEW.feedback_pieces,
    NEW.reflective_accounts, NEW.reflective_discussion, NEW.health_and_character,
    NEW.professional_indemnity, NEW.cycle_due_on, NEW.review_state, NEW.reviewed_by,
    NEW.reviewed_at)
  IS DISTINCT FROM (
    OLD.practice_hours, OLD.cpd_hours, OLD.participatory_cpd_hours, OLD.feedback_pieces,
    OLD.reflective_accounts, OLD.reflective_discussion, OLD.health_and_character,
    OLD.professional_indemnity, OLD.cycle_due_on, OLD.review_state, OLD.reviewed_by,
    OLD.reviewed_at);
BEGIN
  -- No bypass for the system: nothing writes revalidation evidence without a member (security
  -- review of the recommended answers, finding 5).
  IF me IS NULL THEN
    RAISE EXCEPTION 'revalidation_needs_a_member' USING ERRCODE = 'check_violation';
  END IF;
  -- The nurse never touches the confirmation, nor writes once reviewed.
  IF me = NEW.worker_id THEN
    IF NEW.confirmation OR confirmation_changed OR NEW.review_state = 'reviewed'
        OR was_state = 'reviewed' THEN
      RAISE EXCEPTION 'revalidation_nurse_cannot' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- Someone confirming without HR rights changes the confirmation only (a line manager).
  IF NOT hr AND counts_changed THEN
    RAISE EXCEPTION 'revalidation_confirmer_confirms_only' USING ERRCODE = 'check_violation';
  END IF;
  -- The confirmation is the confirmer's, in their own name, never the nurse's, and follows the
  -- review; only HR takes one back.
  IF NEW.confirmation AND NOT was_confirmed THEN
    IF NEW.confirmed_by IS DISTINCT FROM me OR NEW.review_state <> 'reviewed' THEN
      RAISE EXCEPTION 'revalidation_confirmer_not_you' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF confirmation_changed AND NOT (was_confirmed AND NOT NEW.confirmation AND hr) THEN
    RAISE EXCEPTION 'revalidation_confirmation_fixed' USING ERRCODE = 'check_violation';
  END IF;
  -- HR reviews someone else's evidence, in their own name.
  IF NEW.review_state = 'reviewed' AND was_state <> 'reviewed' THEN
    IF NOT hr OR NEW.reviewed_by IS DISTINCT FROM me THEN
      RAISE EXCEPTION 'revalidation_reviewer_not_you' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Once reviewed, the counts are fixed: only the confirmation may follow.
  IF TG_OP = 'UPDATE' AND OLD.review_state = 'reviewed' AND counts_changed THEN
    RAISE EXCEPTION 'revalidation_reviewed_fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER revalidation_guard BEFORE INSERT OR UPDATE ON public.revalidation_evidence
  FOR EACH ROW EXECUTE FUNCTION app.revalidation_guard();
--> statement-breakpoint

-- H-830: supervised templates, and supervised shifts not yet published, that counted as care by the
-- earlier default stop counting until the organisation says so; published shifts are left for the
-- manager to review (clinical safety review of the recommended answers, finding 2; H-839).
ALTER TABLE public.shift_template NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.shift NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE public.shift_template SET counts_as_care = false WHERE supervised AND counts_as_care;
--> statement-breakpoint
UPDATE public.shift SET counts_as_care = false
  WHERE supervised AND counts_as_care AND published_at IS NULL AND deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE public.shift_template FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.shift FORCE ROW LEVEL SECURITY;
