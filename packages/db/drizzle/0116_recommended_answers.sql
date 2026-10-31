CREATE TABLE "casework_support_ticket" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"case_id" uuid NOT NULL,
	"new_manager_id" uuid NOT NULL,
	"requested_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"reason" text NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"used_by_operator" uuid,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "casework_support_ticket_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "casework_support_ticket_reason" CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
	CONSTRAINT "casework_support_ticket_people" CHECK (new_manager_id <> requested_by AND (approved_by IS NULL OR (approved_by <> requested_by AND approved_by <> new_manager_id))),
	CONSTRAINT "casework_support_ticket_steps" CHECK ((approved_by IS NULL) = (approved_at IS NULL) AND (used_at IS NULL) = (used_by_operator IS NULL)
        AND (used_at IS NULL OR approved_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "reference_request" DROP CONSTRAINT "reference_request_state";--> statement-breakpoint
ALTER TABLE "employee_case" ADD COLUMN "removes_from_regulated_activity" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "employee_case" ADD COLUMN "retention_class" text DEFAULT 'staff_file' NOT NULL;--> statement-breakpoint
ALTER TABLE "casework_support_ticket" ADD CONSTRAINT "casework_support_ticket_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."employee_case"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "casework_support_ticket" ADD CONSTRAINT "casework_support_ticket_new_manager_fk" FOREIGN KEY ("tenant_id","new_manager_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "casework_support_ticket" ADD CONSTRAINT "casework_support_ticket_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "casework_support_ticket" ADD CONSTRAINT "casework_support_ticket_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_case" ADD CONSTRAINT "employee_case_regulated_activity" CHECK (NOT removes_from_regulated_activity OR outcome = 'action_short_of_dismissal');--> statement-breakpoint
ALTER TABLE "employee_case" ADD CONSTRAINT "employee_case_retention_class" CHECK (retention_class IN ('staff_file', 'casework_no_sanction'));--> statement-breakpoint
ALTER TABLE "reference_request" ADD CONSTRAINT "reference_request_state" CHECK (state IN ('requested', 'sent', 'declined')
        AND (state = 'sent') = (sent_on IS NOT NULL AND sent_by IS NOT NULL)
        AND (state = 'declined') = (declined_reason IS NOT NULL)
        AND (declined_reason IS NULL OR declined_reason IN ('no_consent_to_share', 'not_employed_here', 'duplicate_request', 'requester_not_verified')));--> statement-breakpoint

-- Recommended answers applied 31/10/2026 (review at testing): H-802, H-804, H-806 and H-876
-- (workforce.md sections 2c, 2d and 11; retention.md). Runs as harbour_owner.

-- H-802 and H-806 on cases: the removal-from-regulated-activity flag is part of the outcome (set
-- with it, never changed after); the retention class is set by the database as the case closes,
-- never by a client: with the staff file when the case ended in a sanction, a dismissal or a
-- referral, or concerned safeguarding; casework_no_sanction (6 years after closure) for a
-- grievance, no case to answer or a withdrawn case (caseRetentionClass in packages/domain).
CREATE OR REPLACE FUNCTION app.employee_case_closing_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.removes_from_regulated_activity IS DISTINCT FROM OLD.removes_from_regulated_activity
     AND NOT (OLD.outcome IS NULL AND NEW.outcome IS NOT NULL) THEN
    RAISE EXCEPTION 'Whether the outcome removes the member from regulated activity is decided with the outcome'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.stage = 'closed' AND OLD.stage <> 'closed' THEN
    NEW.retention_class := CASE
      WHEN NEW.safeguarding_incident_id IS NOT NULL THEN 'staff_file'
      WHEN NEW.dbs_referral = 'referred' OR NEW.regulator_referral = 'referred' THEN 'staff_file'
      WHEN NEW.outcome IN ('first_written_warning', 'final_written_warning',
        'action_short_of_dismissal', 'dismissal', 'redeployment', 'not_passed') THEN 'staff_file'
      WHEN NEW.case_type = 'grievance' THEN 'casework_no_sanction'
      WHEN NEW.closed_reason IN ('no_case_to_answer', 'withdrawn') THEN 'casework_no_sanction'
      ELSE 'staff_file' END;
  ELSE
    NEW.retention_class := OLD.retention_class;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employee_case_closing_guard BEFORE UPDATE ON public.employee_case
  FOR EACH ROW EXECUTE FUNCTION app.employee_case_closing_guard();
--> statement-breakpoint

-- H-804: casework support tickets. Raised by a holder of platform.user.manage for a case whose
-- case managers have all left (the requester never reads the case, only names it by id), approved
-- by the data protection lead (platform.dpia.sign), someone else; read by the requester, the
-- approver and holders of either permission; used once, only by Thapsus support through
-- app.operator_appoint_case_manager. Mutable with history; never deleted.
ALTER TABLE public.casework_support_ticket ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.casework_support_ticket FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.casework_support_ticket AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY casework_support_ticket_read ON public.casework_support_ticket AS RESTRICTIVE
  FOR SELECT TO harbour_app
  USING (app.is_system() OR requested_by = app.current_user_id()
    OR approved_by = app.current_user_id()
    OR app.holds_permission_anywhere('platform.user.manage')
    OR app.holds_permission_anywhere('platform.dpia.sign'));
--> statement-breakpoint
CREATE POLICY casework_support_ticket_raise ON public.casework_support_ticket AS RESTRICTIVE
  FOR INSERT TO harbour_app
  WITH CHECK (app.holds_permission_anywhere('platform.user.manage')
    AND requested_by = app.current_user_id() AND approved_by IS NULL AND used_at IS NULL);
--> statement-breakpoint
CREATE POLICY casework_support_ticket_approve ON public.casework_support_ticket AS RESTRICTIVE
  FOR UPDATE TO harbour_app
  USING (app.holds_permission_anywhere('platform.dpia.sign'))
  WITH CHECK (approved_by = app.current_user_id());
--> statement-breakpoint
-- A ticket keeps what it asks for; it is approved once, by someone other than the requester and the
-- new case manager; and it is used once, only by the definer (no member in the session).
CREATE OR REPLACE FUNCTION app.casework_support_ticket_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.case_id, NEW.new_manager_id, NEW.requested_by, NEW.reason,
      NEW.created_at, NEW.created_by, NEW.deleted_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.case_id, OLD.new_manager_id, OLD.requested_by, OLD.reason,
      OLD.created_at, OLD.created_by, OLD.deleted_at) THEN
    RAISE EXCEPTION 'A casework support ticket keeps what it asks for'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.approved_by, NEW.approved_at) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at)
     AND OLD.approved_by IS NOT NULL THEN
    RAISE EXCEPTION 'A casework support ticket is approved once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.used_by_operator, NEW.used_at) IS DISTINCT FROM (OLD.used_by_operator, OLD.used_at)
     AND (OLD.used_at IS NOT NULL OR app.current_user_id() IS NOT NULL) THEN
    RAISE EXCEPTION 'A casework support ticket is used once, only by Thapsus support'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER casework_support_ticket_guard BEFORE UPDATE ON public.casework_support_ticket
  FOR EACH ROW EXECUTE FUNCTION app.casework_support_ticket_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.casework_support_ticket
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.casework_support_ticket
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.casework_support_ticket
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.casework_support_ticket TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.casework_support_ticket FROM harbour_app;
--> statement-breakpoint

-- H-804: Thapsus support appoints the case manager an approved ticket names, without reading the
-- case: the case must have no case manager still employed (every case manager has left or been
-- removed), and the new one must be an active member who is not the member of staff the case is
-- about, the requester or the approver. The appointment is recorded as the approver's (who
-- authorised it), the ticket records the operator, and the caller audits it to the organisation.
-- Returns the case's id; refuses with a reason code otherwise. Called by harbour_operator only,
-- with app.tenant_id set to the ticket's organisation.
CREATE OR REPLACE FUNCTION app.operator_appoint_case_manager(p_ticket_id uuid, p_operator_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_ticket public.casework_support_ticket%ROWTYPE;
  v_subject uuid;
  v_today date := (now() AT TIME ZONE 'Europe/London')::date;
BEGIN
  IF app.current_tenant_id() IS NULL OR p_operator_id IS NULL THEN
    RAISE EXCEPTION 'ticket_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO v_ticket FROM public.casework_support_ticket t
   WHERE t.tenant_id = app.current_tenant_id() AND t.id = p_ticket_id AND t.deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ticket_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_ticket.approved_by IS NULL THEN
    RAISE EXCEPTION 'ticket_not_approved' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_ticket.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'ticket_used' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT c.subject_tenant_user_id INTO v_subject FROM public.employee_case c
   WHERE c.tenant_id = v_ticket.tenant_id AND c.id = v_ticket.case_id AND c.stage <> 'closed'
     AND c.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case_not_open' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.employee_case_member m
         JOIN public.tenant_user u ON u.tenant_id = m.tenant_id AND u.id = m.tenant_user_id
        WHERE m.tenant_id = v_ticket.tenant_id AND m.case_id = v_ticket.case_id
          AND m.member_role = 'case_manager' AND m.removed_at IS NULL
          AND u.status IN ('invited', 'active') AND u.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'case_has_manager' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_ticket.new_manager_id = v_subject OR NOT EXISTS (
       SELECT 1 FROM public.tenant_user u
        WHERE u.tenant_id = v_ticket.tenant_id AND u.id = v_ticket.new_manager_id
          AND u.status = 'active' AND u.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'manager_not_allowed' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.employee_case_member (tenant_id, case_id, tenant_user_id, member_role,
      added_by, created_by, updated_by)
    VALUES (v_ticket.tenant_id, v_ticket.case_id, v_ticket.new_manager_id, 'case_manager',
      v_ticket.approved_by, v_ticket.approved_by, v_ticket.approved_by);
  INSERT INTO public.employee_case_event (tenant_id, case_id, kind, occurred_on, recorded_by)
    VALUES (v_ticket.tenant_id, v_ticket.case_id, 'member_added', v_today, v_ticket.approved_by);
  UPDATE public.casework_support_ticket SET used_by_operator = p_operator_id, used_at = now()
   WHERE tenant_id = v_ticket.tenant_id AND id = v_ticket.id;
  RETURN v_ticket.case_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.operator_appoint_case_manager(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.operator_appoint_case_manager(uuid, uuid) TO harbour_operator;
