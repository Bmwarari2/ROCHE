CREATE TABLE "employee_case" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"case_type" text NOT NULL,
	"subject_tenant_user_id" uuid NOT NULL,
	"subject_registered" boolean DEFAULT false NOT NULL,
	"summary" text NOT NULL,
	"opened_on" date NOT NULL,
	"stage" text DEFAULT 'open' NOT NULL,
	"stage_since" date NOT NULL,
	"outcome" text,
	"outcome_decided_on" date,
	"warning_expires_on" date,
	"appeal_outcome" text,
	"appeal_decided_on" date,
	"suspended_on" date,
	"suspension_review_on" date,
	"closed_reason" text,
	"closed_on" date,
	"dbs_referral" text,
	"dbs_referral_on" date,
	"dbs_referral_reason" text,
	"regulator_referral" text,
	"regulator_referral_on" date,
	"regulator_referral_reason" text,
	"safeguarding_incident_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "employee_case_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "employee_case_type" CHECK (case_type IN ('grievance', 'disciplinary', 'capability', 'sickness_absence', 'probation')),
	CONSTRAINT "employee_case_stage" CHECK (stage IN ('open', 'investigation', 'hearing', 'outcome', 'appeal', 'closed')),
	CONSTRAINT "employee_case_summary" CHECK (length(btrim(summary)) BETWEEN 3 AND 10000),
	CONSTRAINT "employee_case_outcome" CHECK ((outcome IS NULL AND outcome_decided_on IS NULL)
        OR (outcome IN ('upheld', 'partly_upheld', 'not_upheld', 'no_action', 'first_written_warning', 'final_written_warning', 'action_short_of_dismissal', 'dismissal', 'improvement_plan', 'redeployment', 'support_plan', 'reasonable_adjustments', 'passed', 'extended', 'not_passed') AND outcome_decided_on IS NOT NULL)),
	CONSTRAINT "employee_case_warning" CHECK ((warning_expires_on IS NULL) = (outcome IS NULL OR outcome NOT IN ('first_written_warning', 'final_written_warning'))
        AND (warning_expires_on IS NULL OR warning_expires_on > outcome_decided_on)),
	CONSTRAINT "employee_case_appeal" CHECK ((appeal_outcome IS NULL AND appeal_decided_on IS NULL)
        OR (appeal_outcome IN ('upheld', 'partly_upheld', 'not_upheld') AND appeal_decided_on IS NOT NULL AND outcome IS NOT NULL)),
	CONSTRAINT "employee_case_suspension" CHECK ((suspended_on IS NULL) = (suspension_review_on IS NULL)
        AND (suspended_on IS NULL OR (case_type = 'disciplinary' AND suspension_review_on > suspended_on))),
	CONSTRAINT "employee_case_closed" CHECK ((stage = 'closed') = (closed_on IS NOT NULL AND closed_reason IS NOT NULL)
        AND (closed_reason IS NULL OR closed_reason IN ('outcome_accepted', 'appeal_decided', 'resolved_informally', 'no_case_to_answer', 'withdrawn', 'left_employment'))
        AND (stage <> 'closed' OR suspended_on IS NULL)),
	CONSTRAINT "employee_case_dbs_referral" CHECK ((dbs_referral IS NULL AND dbs_referral_on IS NULL AND dbs_referral_reason IS NULL)
    OR (dbs_referral = 'referred' AND dbs_referral_on IS NOT NULL AND dbs_referral_reason IS NULL)
    OR (dbs_referral = 'not_required' AND dbs_referral_on IS NULL
        AND dbs_referral_reason IN ('harm_test_not_met', 'not_regulated_activity', 'referred_by_another_body', 'other_recorded_in_case'))),
	CONSTRAINT "employee_case_regulator_referral" CHECK ((regulator_referral IS NULL AND regulator_referral_on IS NULL AND regulator_referral_reason IS NULL)
    OR (regulator_referral = 'referred' AND regulator_referral_on IS NOT NULL AND regulator_referral_reason IS NULL)
    OR (regulator_referral = 'not_required' AND regulator_referral_on IS NULL
        AND regulator_referral_reason IN ('harm_test_not_met', 'not_regulated_activity', 'referred_by_another_body', 'other_recorded_in_case')))
);
--> statement-breakpoint
CREATE TABLE "employee_case_event" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_stage" text,
	"to_stage" text,
	"occurred_on" date NOT NULL,
	"body" text,
	"recorded_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_case_event_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "employee_case_event_kind" CHECK (kind IN ('opened', 'stage_changed', 'member_added', 'member_removed', 'hearing_arranged', 'hearing_updated', 'suspension_started', 'suspension_reviewed', 'suspension_ended', 'referral_recorded', 'safeguarding_linked', 'appeal_grounds', 'note')),
	CONSTRAINT "employee_case_event_stages" CHECK ((from_stage IS NULL OR from_stage IN ('open', 'investigation', 'hearing', 'outcome', 'appeal', 'closed'))
        AND (to_stage IS NULL OR to_stage IN ('open', 'investigation', 'hearing', 'outcome', 'appeal', 'closed'))),
	CONSTRAINT "employee_case_event_body" CHECK ((kind IN ('note', 'appeal_grounds')) = (body IS NOT NULL) AND (body IS NULL OR length(btrim(body)) BETWEEN 1 AND 10000))
);
--> statement-breakpoint
CREATE TABLE "employee_case_hearing" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"led_by" uuid NOT NULL,
	"invited_on" date NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"issue_set_out" boolean NOT NULL,
	"evidence_shared" boolean NOT NULL,
	"companion_right_given" boolean NOT NULL,
	"state" text DEFAULT 'scheduled' NOT NULL,
	"held_on" date,
	"accompanied" boolean,
	"postponed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "employee_case_hearing_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "employee_case_hearing_kind" CHECK (kind IN ('investigation_meeting', 'hearing', 'appeal_hearing')),
	CONSTRAINT "employee_case_hearing_state" CHECK (state IN ('scheduled', 'held', 'not_attended', 'postponed', 'cancelled')),
	CONSTRAINT "employee_case_hearing_held" CHECK ((state = 'held') = (held_on IS NOT NULL) AND (accompanied IS NULL OR state = 'held')),
	CONSTRAINT "employee_case_hearing_postponed" CHECK ((postponed_reason IS NULL) = (state <> 'postponed')
        AND (postponed_reason IS NULL OR postponed_reason IN ('companion_unavailable', 'employee_unwell', 'employer_request', 'other')))
);
--> statement-breakpoint
CREATE TABLE "employee_case_member" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"case_id" uuid NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"member_role" text NOT NULL,
	"independence_exception" text,
	"added_by" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "employee_case_member_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "employee_case_member_role" CHECK (member_role IN ('case_manager', 'investigator', 'hearing_chair', 'appeal_chair', 'note_taker', 'hr_adviser')),
	CONSTRAINT "employee_case_member_exception" CHECK (independence_exception IS NULL OR independence_exception IN ('no_other_manager_available')),
	CONSTRAINT "employee_case_member_removed" CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
--> statement-breakpoint
ALTER TABLE "employee_case" ADD CONSTRAINT "employee_case_subject_fk" FOREIGN KEY ("tenant_id","subject_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_case" ADD CONSTRAINT "employee_case_incident_fk" FOREIGN KEY ("tenant_id","safeguarding_incident_id") REFERENCES "public"."incident"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_case_event" ADD CONSTRAINT "employee_case_event_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."employee_case"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_case_event" ADD CONSTRAINT "employee_case_event_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_case_hearing" ADD CONSTRAINT "employee_case_hearing_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."employee_case"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_case_hearing" ADD CONSTRAINT "employee_case_hearing_led_by_fk" FOREIGN KEY ("tenant_id","led_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_case_member" ADD CONSTRAINT "employee_case_member_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."employee_case"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_case_member" ADD CONSTRAINT "employee_case_member_member_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_case_member" ADD CONSTRAINT "employee_case_member_added_by_fk" FOREIGN KEY ("tenant_id","added_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_case_member" ADD CONSTRAINT "employee_case_member_removed_by_fk" FOREIGN KEY ("tenant_id","removed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_case_subject_idx" ON "employee_case" USING btree ("tenant_id","subject_tenant_user_id");--> statement-breakpoint
CREATE INDEX "employee_case_event_case_idx" ON "employee_case_event" USING btree ("tenant_id","case_id","created_at");--> statement-breakpoint
CREATE INDEX "employee_case_hearing_case_idx" ON "employee_case_hearing" USING btree ("tenant_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_case_member_active_key" ON "employee_case_member" USING btree ("tenant_id","case_id","tenant_user_id","member_role") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE INDEX "employee_case_member_user_idx" ON "employee_case_member" USING btree ("tenant_id","tenant_user_id");--> statement-breakpoint

-- Employee relations casework: a restricted silo (Phase 2 slice 39; WORK-010; ADR-0089;
-- workforce.md section 2c). Forced RLS. Only the members named on a case read it or anything on
-- it: no role, grant or break-glass reaches it, the owner and the Registered Manager included.
-- A holder of the silo permission workforce.casework.manage opens a case and, in the same
-- transaction, names themselves its first case manager; a case manager names the others. Nobody
-- names themselves, and the member of staff a case is about is never a member of it. The silo
-- guards below keep the permission in a role of its own (this migration carries its own guards
-- for workforce.casework.manage, so it needs no other silo migration).
-- Whether the session's member holds the silo permission through a role of their own in force
-- (never a grant: no grant carries it). The caseworker role has no person scope, so this does not
-- use app.holds_role_permission_somewhere, which counts only organisation and location roles.
CREATE OR REPLACE FUNCTION app.casework_silo_holder() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.current_user_id() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.role_assignment ra
    JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
    WHERE ra.tenant_id = app.current_tenant_id()
      AND ra.tenant_user_id = app.current_user_id()
      AND ra.deleted_at IS NULL AND r.deleted_at IS NULL AND r.archived_at IS NULL
      AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
      AND r.scope_kind::text <> 'self'
      AND 'workforce.casework.manage' = ANY (r.permissions))
$$;
--> statement-breakpoint
-- Whether the session's member is named (and not removed) on a case, in one of the roles given
-- (any role when null). A definer function, so the member table's own policy, which calls it,
-- does not recurse; it answers only for the session's own member.
CREATE OR REPLACE FUNCTION app.casework_member(p_case uuid, p_roles text[] DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT app.current_user_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.employee_case_member m
     WHERE m.tenant_id = app.current_tenant_id() AND m.case_id = p_case
       AND m.tenant_user_id = app.current_user_id() AND m.removed_at IS NULL
       AND m.deleted_at IS NULL
       AND (p_roles IS NULL OR m.member_role = ANY (p_roles)))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.casework_member(uuid, text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.casework_member(uuid, text[]) TO harbour_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_case', 'employee_case_member', 'employee_case_hearing',
                           'employee_case_event'] LOOP
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
-- Cases: read only by their members. Opened only through app.open_employee_case (below), which
-- names the opener its first case manager in the same statement; the application role has no
-- INSERT on cases. Changed by its case managers and chairs, each within their part (the guard).
CREATE POLICY employee_case_read ON public.employee_case AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.casework_member(id));
--> statement-breakpoint
CREATE POLICY employee_case_open ON public.employee_case AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.casework_silo_holder() AND created_by = app.current_user_id()
    AND subject_tenant_user_id <> app.current_user_id());
--> statement-breakpoint
CREATE POLICY employee_case_change ON public.employee_case AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.casework_member(id, ARRAY['case_manager', 'hearing_chair', 'appeal_chair']))
  WITH CHECK (app.casework_member(id, ARRAY['case_manager', 'hearing_chair', 'appeal_chair']));
--> statement-breakpoint
-- Members: every member sees who is on their case. A case manager names others, never
-- themselves (the opener is named by app.open_employee_case).
CREATE POLICY employee_case_member_read ON public.employee_case_member AS RESTRICTIVE FOR SELECT
  TO harbour_app USING (app.casework_member(case_id));
--> statement-breakpoint
CREATE POLICY employee_case_member_add ON public.employee_case_member AS RESTRICTIVE FOR INSERT
  TO harbour_app WITH CHECK (added_by = app.current_user_id() AND removed_at IS NULL
    AND tenant_user_id <> app.current_user_id()
    AND app.casework_member(case_id, ARRAY['case_manager']));
--> statement-breakpoint
CREATE POLICY employee_case_member_change ON public.employee_case_member AS RESTRICTIVE FOR UPDATE
  TO harbour_app USING (app.casework_member(case_id, ARRAY['case_manager']))
  WITH CHECK (removed_by = app.current_user_id());
--> statement-breakpoint
-- Hearings: read by the case's members; arranged by its case managers; updated by them or by the
-- member leading the hearing.
CREATE POLICY employee_case_hearing_read ON public.employee_case_hearing AS RESTRICTIVE FOR SELECT
  TO harbour_app USING (app.casework_member(case_id));
--> statement-breakpoint
CREATE POLICY employee_case_hearing_arrange ON public.employee_case_hearing AS RESTRICTIVE FOR INSERT
  TO harbour_app WITH CHECK (app.casework_member(case_id, ARRAY['case_manager']));
--> statement-breakpoint
CREATE POLICY employee_case_hearing_change ON public.employee_case_hearing AS RESTRICTIVE FOR UPDATE
  TO harbour_app
  USING (app.casework_member(case_id, ARRAY['case_manager'])
    OR (led_by = app.current_user_id() AND app.casework_member(case_id)))
  WITH CHECK (app.casework_member(case_id, ARRAY['case_manager'])
    OR (led_by = app.current_user_id() AND app.casework_member(case_id)));
--> statement-breakpoint
-- The timeline: read by the case's members; written in one's own name. Any member adds a note; the
-- member leading a hearing records it; every other kind is a case manager's or a chair's; the
-- opening is written only by app.open_employee_case. Nothing after the case has closed but its
-- one closing event.
CREATE POLICY employee_case_event_read ON public.employee_case_event AS RESTRICTIVE FOR SELECT
  TO harbour_app USING (app.casework_member(case_id));
--> statement-breakpoint
CREATE POLICY employee_case_event_write ON public.employee_case_event AS RESTRICTIVE FOR INSERT
  TO harbour_app WITH CHECK (recorded_by = app.current_user_id() AND kind <> 'opened'
    AND (kind = 'note' OR app.casework_member(case_id,
           CASE WHEN kind = 'hearing_updated'
                THEN ARRAY['case_manager', 'investigator', 'hearing_chair', 'appeal_chair']
                ELSE ARRAY['case_manager', 'hearing_chair', 'appeal_chair'] END))
    AND EXISTS (
    SELECT 1 FROM public.employee_case c
     WHERE c.id = case_id
       AND (c.stage <> 'closed' OR (kind = 'stage_changed' AND to_stage = 'closed'
            AND NOT EXISTS (SELECT 1 FROM public.employee_case_event e
                             WHERE e.case_id = c.id AND e.to_stage = 'closed')))));
--> statement-breakpoint
-- Opening a case: it starts open, with nothing decided, and the database notes from the staff
-- profile whether the member of staff is on a professional register (rule 17). A definer
-- trigger, as the opener reads no staff files.
CREATE OR REPLACE FUNCTION app.employee_case_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.stage <> 'open' OR NEW.stage_since <> NEW.opened_on OR NEW.outcome IS NOT NULL
     OR NEW.appeal_outcome IS NOT NULL OR NEW.closed_on IS NOT NULL OR NEW.suspended_on IS NOT NULL
     OR NEW.dbs_referral IS NOT NULL OR NEW.regulator_referral IS NOT NULL
     OR NEW.safeguarding_incident_id IS NOT NULL OR NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'A case is opened open, with nothing decided'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.subject_registered := EXISTS (
    SELECT 1 FROM public.staff_profile p
     WHERE p.tenant_id = NEW.tenant_id AND p.tenant_user_id = NEW.subject_tenant_user_id
       AND p.registration_body IS NOT NULL AND p.deleted_at IS NULL);
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employee_case_open() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER employee_case_open BEFORE INSERT ON public.employee_case
  FOR EACH ROW EXECUTE FUNCTION app.employee_case_open();
--> statement-breakpoint
-- Opening a case: only a holder of the silo permission, never about themselves. The case, its
-- first case manager (the opener) and the opening event are written together, so no policy has
-- to recognise "the row I have just inserted". Returns the case's id.
CREATE OR REPLACE FUNCTION app.open_employee_case(p_type text, p_subject uuid, p_summary text,
  p_opened_on date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_me uuid := app.current_user_id();
  v_case uuid;
BEGIN
  IF v_me IS NULL OR app.current_tenant_id() IS NULL OR NOT app.casework_silo_holder() THEN
    RAISE EXCEPTION 'Opening a case needs workforce.casework.manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_subject = v_me THEN
    RAISE EXCEPTION 'Nobody opens a case about themselves'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.employee_case (tenant_id, case_type, subject_tenant_user_id, summary,
      opened_on, stage_since, created_by, updated_by)
    VALUES (app.current_tenant_id(), p_type, p_subject, p_summary, p_opened_on, p_opened_on,
      v_me, v_me)
    RETURNING id INTO v_case;
  INSERT INTO public.employee_case_member (tenant_id, case_id, tenant_user_id, member_role,
      added_by, created_by, updated_by)
    VALUES (app.current_tenant_id(), v_case, v_me, 'case_manager', v_me, v_me, v_me);
  INSERT INTO public.employee_case_event (tenant_id, case_id, kind, to_stage, occurred_on,
      recorded_by)
    VALUES (app.current_tenant_id(), v_case, 'opened', 'open', p_opened_on, v_me);
  RETURN v_case;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.open_employee_case(text, uuid, text, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.open_employee_case(text, uuid, text, date) TO harbour_app;
--> statement-breakpoint
-- Changing a case (rule 15, the database's part): it keeps who and what it is about; it moves only
-- forward; an outcome once decided stays; a closed case never changes; the safeguarding link is
-- set once, to a concern the member can see; it is removed only by the retention schedule.
CREATE OR REPLACE FUNCTION app.employee_case_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.case_type, NEW.subject_tenant_user_id, NEW.subject_registered,
      NEW.summary, NEW.opened_on, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.case_type, OLD.subject_tenant_user_id, OLD.subject_registered,
      OLD.summary, OLD.opened_on, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'A case keeps its type, the member of staff it is about, its summary and its opening'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- A chair who is not a case manager changes only their own decision: the hearing chair the
  -- outcome (hearing to outcome), the appeal chair the appeal (appeal to closed, appeal decided).
  IF app.current_user_id() IS NOT NULL
     AND NOT app.casework_member(OLD.id, ARRAY['case_manager']) THEN
    IF (NEW.suspended_on, NEW.suspension_review_on, NEW.dbs_referral, NEW.dbs_referral_on,
        NEW.dbs_referral_reason, NEW.regulator_referral, NEW.regulator_referral_on,
        NEW.regulator_referral_reason, NEW.safeguarding_incident_id, NEW.deleted_at)
       IS DISTINCT FROM
       (OLD.suspended_on, OLD.suspension_review_on, OLD.dbs_referral, OLD.dbs_referral_on,
        OLD.dbs_referral_reason, OLD.regulator_referral, OLD.regulator_referral_on,
        OLD.regulator_referral_reason, OLD.safeguarding_incident_id, OLD.deleted_at)
       OR NOT (
         (app.casework_member(OLD.id, ARRAY['hearing_chair'])
          AND OLD.stage = 'hearing' AND NEW.stage = 'outcome'
          AND (NEW.appeal_outcome, NEW.appeal_decided_on, NEW.closed_on, NEW.closed_reason)
              IS NOT DISTINCT FROM (OLD.appeal_outcome, OLD.appeal_decided_on, OLD.closed_on, OLD.closed_reason))
         OR (app.casework_member(OLD.id, ARRAY['appeal_chair'])
          AND OLD.stage = 'appeal' AND NEW.stage = 'closed' AND NEW.closed_reason = 'appeal_decided'
          AND (NEW.outcome, NEW.outcome_decided_on, NEW.warning_expires_on)
              IS NOT DISTINCT FROM (OLD.outcome, OLD.outcome_decided_on, OLD.warning_expires_on))) THEN
      RAISE EXCEPTION 'A chair records only their own decision on a case'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    IF app.current_user_id() IS NOT NULL THEN
      RAISE EXCEPTION 'A case is removed only by the retention schedule'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.stage = 'closed' THEN
    RAISE EXCEPTION 'A closed case never changes; open a new one'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.stage IS DISTINCT FROM OLD.stage AND NOT (
       (OLD.stage, NEW.stage) IN (('open', 'investigation'), ('open', 'hearing'),
         ('investigation', 'hearing'), ('hearing', 'outcome'), ('outcome', 'appeal'))
       OR NEW.stage = 'closed') THEN
    RAISE EXCEPTION 'A case moves only as rule 15 allows'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.outcome IS NOT NULL AND (NEW.outcome, NEW.outcome_decided_on, NEW.warning_expires_on)
       IS DISTINCT FROM (OLD.outcome, OLD.outcome_decided_on, OLD.warning_expires_on) THEN
    RAISE EXCEPTION 'An outcome once decided stays; an appeal records its own'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.outcome IS NOT NULL AND OLD.outcome IS NULL AND NEW.stage <> 'outcome' THEN
    RAISE EXCEPTION 'An outcome is decided as the case moves to its outcome'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.appeal_outcome IS NOT NULL AND OLD.appeal_outcome IS NULL
     AND NOT (OLD.stage = 'appeal' AND NEW.stage = 'closed') THEN
    RAISE EXCEPTION 'An appeal is decided as the case closes from its appeal'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.safeguarding_incident_id IS DISTINCT FROM OLD.safeguarding_incident_id THEN
    IF OLD.safeguarding_incident_id IS NOT NULL THEN
      RAISE EXCEPTION 'A safeguarding link once made stays'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.incident i WHERE i.id = NEW.safeguarding_incident_id) THEN
      RAISE EXCEPTION 'A case is linked only to a safeguarding concern the member can see'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employee_case_guard BEFORE UPDATE ON public.employee_case
  FOR EACH ROW EXECUTE FUNCTION app.employee_case_guard();
--> statement-breakpoint
-- Naming and removing members (rule 16, the database's part): never the member of staff the case
-- is about; where practicable the investigator does not chair the hearing and the appeal is heard
-- by someone involved in neither, counting parts they were removed from (else the exception is
-- recorded); a membership keeps its case,
-- member and role, is only removed (in the remover's name), and the last case manager stays.
CREATE OR REPLACE FUNCTION app.employee_case_member_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_roles text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM public.employee_case c
                WHERE c.id = NEW.case_id AND c.subject_tenant_user_id = NEW.tenant_user_id) THEN
      RAISE EXCEPTION 'The member of staff a case is about is never a member of it'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.independence_exception IS NULL THEN
      SELECT coalesce(array_agg(m.member_role), '{}') INTO v_roles
        FROM public.employee_case_member m
       WHERE m.case_id = NEW.case_id AND m.tenant_user_id = NEW.tenant_user_id;
      IF (NEW.member_role = 'hearing_chair' AND v_roles && ARRAY['investigator', 'appeal_chair'])
         OR (NEW.member_role = 'investigator' AND v_roles && ARRAY['hearing_chair', 'appeal_chair'])
         OR (NEW.member_role = 'appeal_chair' AND v_roles && ARRAY['investigator', 'hearing_chair'])
      THEN
        RAISE EXCEPTION 'The investigation, hearing and appeal are taken by different people where practicable'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.case_id, NEW.tenant_user_id, NEW.member_role,
      NEW.independence_exception, NEW.added_by, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.case_id, OLD.tenant_user_id, OLD.member_role,
      OLD.independence_exception, OLD.added_by, OLD.created_at, OLD.created_by)
     OR OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'A case membership is only ever removed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.member_role = 'case_manager' AND NOT EXISTS (
       SELECT 1 FROM public.employee_case_member m
        WHERE m.case_id = OLD.case_id AND m.member_role = 'case_manager'
          AND m.removed_at IS NULL AND m.id <> OLD.id) THEN
    RAISE EXCEPTION 'A case keeps a case manager'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employee_case_member_guard BEFORE INSERT OR UPDATE ON public.employee_case_member
  FOR EACH ROW EXECUTE FUNCTION app.employee_case_member_guard();
--> statement-breakpoint
-- Hearings (rule 18, the database's part): led by the member in the matching role, never the
-- member of staff; a hearing keeps its case, kind and invitation; a held, unattended or cancelled
-- one is final.
CREATE OR REPLACE FUNCTION app.employee_case_hearing_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.tenant_id, NEW.case_id, NEW.kind, NEW.led_by, NEW.invited_on,
        NEW.issue_set_out, NEW.evidence_shared, NEW.companion_right_given, NEW.created_at,
        NEW.created_by, NEW.deleted_at)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.case_id, OLD.kind, OLD.led_by, OLD.invited_on,
        OLD.issue_set_out, OLD.evidence_shared, OLD.companion_right_given, OLD.created_at,
        OLD.created_by, OLD.deleted_at) THEN
      RAISE EXCEPTION 'A hearing keeps its case, kind, lead and invitation'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.state NOT IN ('scheduled', 'postponed')
       OR (NEW.state = OLD.state AND NEW.scheduled_at = OLD.scheduled_at) THEN
      RAISE EXCEPTION 'A held, unattended or cancelled hearing is final'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state <> 'scheduled' OR NEW.scheduled_at::date <= NEW.invited_on
     OR NOT EXISTS (
       SELECT 1 FROM public.employee_case_member m
        WHERE m.case_id = NEW.case_id AND m.tenant_user_id = NEW.led_by AND m.removed_at IS NULL
          AND m.member_role = CASE NEW.kind WHEN 'investigation_meeting' THEN 'investigator'
                                            WHEN 'hearing' THEN 'hearing_chair'
                                            ELSE 'appeal_chair' END) THEN
    RAISE EXCEPTION 'A hearing is arranged ahead, led by the case member in the matching role'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employee_case_hearing_guard BEFORE INSERT OR UPDATE ON public.employee_case_hearing
  FOR EACH ROW EXECUTE FUNCTION app.employee_case_hearing_guard();
--> statement-breakpoint
-- No capture_version on the silo tables: it copies the whole row into record_version, which every
-- member of the organisation reads (ADR-0089). Each change is audited by id instead.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_case', 'employee_case_member', 'employee_case_hearing'] LOOP
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
  EXECUTE 'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.employee_case_event '
    'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()';
  EXECUTE 'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.employee_case_event '
    'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()';
END
$$;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.employee_case TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.employee_case_member, public.employee_case_hearing
  TO harbour_app;
--> statement-breakpoint
REVOKE INSERT ON public.employee_case FROM harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.employee_case_event TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.employee_case, public.employee_case_member,
  public.employee_case_hearing, public.employee_case_event FROM harbour_app;
--> statement-breakpoint
REVOKE UPDATE ON public.employee_case_event FROM harbour_app;
--> statement-breakpoint

-- The casework silo guards (ADR-0089). A role carrying workforce.casework.manage carries nothing
-- else; no access grant carries it; nobody appoints themselves to a role carrying it; and nobody
-- holds such a role together with one that manages users or roles, whichever comes first.
CREATE OR REPLACE FUNCTION app.casework_role_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_admin text[] := ARRAY['platform.user.manage', 'platform.role.manage']::text[];
  v_silo text[] := ARRAY['workforce.casework.manage']::text[];
BEGIN
  IF 'workforce.casework.manage' = ANY (NEW.permissions)
     AND cardinality(array_remove(NEW.permissions, 'workforce.casework.manage')) > 0 THEN
    RAISE EXCEPTION 'A role carrying a silo permission carries nothing else (ADR-0089)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- A role already held never becomes a silo role (its holders would be appointed by an edit,
    -- perhaps their own, past the assignment guard); a role becoming one of user or role
    -- management never reaches a holder of a silo role.
    IF NEW.permissions && v_silo AND NOT (OLD.permissions && v_silo) AND EXISTS (
         SELECT 1 FROM public.role_assignment ra
          WHERE ra.tenant_id = NEW.tenant_id AND ra.role_id = NEW.id AND ra.deleted_at IS NULL
            AND (ra.valid_to IS NULL OR ra.valid_to > now())) THEN
      RAISE EXCEPTION 'A role already held never becomes a silo role (ADR-0089)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.permissions && v_admin AND NOT (OLD.permissions && v_admin) AND EXISTS (
         SELECT 1 FROM public.role_assignment ra
           JOIN public.role_assignment rs ON rs.tenant_id = ra.tenant_id
                                         AND rs.tenant_user_id = ra.tenant_user_id
           JOIN public.role r ON r.tenant_id = rs.tenant_id AND r.id = rs.role_id
          WHERE ra.tenant_id = NEW.tenant_id AND ra.role_id = NEW.id AND ra.deleted_at IS NULL
            AND (ra.valid_to IS NULL OR ra.valid_to > now())
            AND rs.deleted_at IS NULL AND (rs.valid_to IS NULL OR rs.valid_to > now())
            AND r.permissions && v_silo) THEN
      RAISE EXCEPTION 'A silo role is never held with user or role management (ADR-0089)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.casework_grant_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF 'workforce.casework.manage' = ANY (NEW.permissions) THEN
    RAISE EXCEPTION 'A silo permission is never given by an access grant (ADR-0089)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.casework_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_permissions text[];
  v_admin text[] := ARRAY['platform.user.manage', 'platform.role.manage']::text[];
  v_silo text[] := ARRAY['workforce.casework.manage']::text[];
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT r.permissions INTO v_permissions FROM public.role r
   WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.role_id;
  IF v_permissions && v_silo THEN
    IF NEW.tenant_user_id = app.current_user_id() THEN
      RAISE EXCEPTION 'Nobody appoints themselves to a silo role (ADR-0089)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.role_assignment ra
                 JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
                WHERE ra.tenant_id = NEW.tenant_id AND ra.tenant_user_id = NEW.tenant_user_id
                  AND ra.id IS DISTINCT FROM NEW.id AND ra.deleted_at IS NULL
                  AND (ra.valid_to IS NULL OR ra.valid_to > now())
                  AND r.permissions && v_admin) THEN
      RAISE EXCEPTION 'A silo role is never held with user or role management (ADR-0089)'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF v_permissions && v_admin THEN
    IF EXISTS (SELECT 1 FROM public.role_assignment ra
                 JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
                WHERE ra.tenant_id = NEW.tenant_id AND ra.tenant_user_id = NEW.tenant_user_id
                  AND ra.id IS DISTINCT FROM NEW.id AND ra.deleted_at IS NULL
                  AND (ra.valid_to IS NULL OR ra.valid_to > now())
                  AND r.permissions && v_silo) THEN
      RAISE EXCEPTION 'A silo role is never held with user or role management (ADR-0089)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- Existing organisations' roles: the owner, manager and HR roles carried the permission alongside
-- others; it leaves them (the organisation gives the caseworker role to the people who run cases).
-- FORCE is lifted on tenant only to list the tenants and restored at the end. Idempotent.
ALTER TABLE public.tenant NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM public.tenant ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE public.role
       SET permissions = array_remove(permissions, 'workforce.casework.manage')
     WHERE 'workforce.casework.manage' = ANY (permissions)
       AND cardinality(array_remove(permissions, 'workforce.casework.manage')) > 0;
    UPDATE public.access_grant
       SET permissions = array_remove(permissions, 'workforce.casework.manage')
     WHERE 'workforce.casework.manage' = ANY (permissions);
    -- Nobody may already hold a silo role together with user or role management: stop here so
    -- the organisation decides which to end, rather than this migration choosing.
    IF EXISTS (
      SELECT 1 FROM public.role_assignment a
        JOIN public.role ra ON ra.tenant_id = a.tenant_id AND ra.id = a.role_id
        JOIN public.role_assignment b ON b.tenant_id = a.tenant_id
                                     AND b.tenant_user_id = a.tenant_user_id
        JOIN public.role rb ON rb.tenant_id = b.tenant_id AND rb.id = b.role_id
       WHERE a.deleted_at IS NULL AND (a.valid_to IS NULL OR a.valid_to > now())
         AND b.deleted_at IS NULL AND (b.valid_to IS NULL OR b.valid_to > now())
         AND 'workforce.casework.manage' = ANY (ra.permissions)
         AND rb.permissions && ARRAY['platform.user.manage', 'platform.role.manage']::text[]) THEN
      RAISE EXCEPTION 'Tenant % has a member holding a silo role with user or role management (ADR-0089)', t
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.tenant FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER casework_role_guard BEFORE INSERT OR UPDATE OF permissions ON public.role
  FOR EACH ROW EXECUTE FUNCTION app.casework_role_guard();
--> statement-breakpoint
CREATE TRIGGER casework_grant_guard BEFORE INSERT OR UPDATE OF permissions ON public.access_grant
  FOR EACH ROW EXECUTE FUNCTION app.casework_grant_guard();
--> statement-breakpoint
CREATE TRIGGER casework_assignment_guard BEFORE INSERT OR UPDATE ON public.role_assignment
  FOR EACH ROW EXECUTE FUNCTION app.casework_assignment_guard();
