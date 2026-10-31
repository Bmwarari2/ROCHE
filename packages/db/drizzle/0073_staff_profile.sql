CREATE TABLE "compliance_item" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb NOT NULL,
	"verified_on" date,
	"verified_by" uuid,
	"risk_assessment_signed_on" date,
	"risk_assessment_signed_by" uuid,
	"expires_on" date,
	"recheck_due_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "compliance_item_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "compliance_item_kind_key" UNIQUE("tenant_id","staff_profile_id","kind"),
	CONSTRAINT "compliance_item_kind" CHECK (kind IN ('identity_with_photo', 'dbs_certificate', 'conduct_in_care_work', 'references', 'relevant_qualifications', 'employment_history', 'health_fitness', 'right_to_work', 'professional_registration')),
	CONSTRAINT "compliance_item_detail" CHECK (jsonb_typeof(detail) = 'object' AND detail->>'kind' = kind),
	CONSTRAINT "compliance_item_verified" CHECK ((verified_on IS NULL) = (verified_by IS NULL)),
	CONSTRAINT "compliance_item_risk_assessment" CHECK ((risk_assessment_signed_on IS NULL) = (risk_assessment_signed_by IS NULL)
        AND (risk_assessment_signed_on IS NULL OR kind = 'dbs_certificate'))
);
--> statement-breakpoint
CREATE TABLE "staff_profile" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"location_id" uuid,
	"job_title" text NOT NULL,
	"pathway_category" text,
	"registration_body" text,
	"previous_care_work" boolean DEFAULT false NOT NULL,
	"date_of_birth" date,
	"starts_on" date,
	"left_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "staff_profile_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_profile_member_key" UNIQUE("tenant_id","tenant_user_id"),
	CONSTRAINT "staff_profile_registration_body" CHECK (registration_body IS NULL OR registration_body IN ('nmc', 'hcpc', 'swe', 'gmc')),
	CONSTRAINT "staff_profile_job_title" CHECK (length(btrim(job_title)) BETWEEN 2 AND 120),
	CONSTRAINT "staff_profile_left_after_start" CHECK (left_on IS NULL OR starts_on IS NULL OR left_on >= starts_on)
);
--> statement-breakpoint
ALTER TABLE "compliance_item" ADD CONSTRAINT "compliance_item_profile_fk" FOREIGN KEY ("tenant_id","staff_profile_id") REFERENCES "public"."staff_profile"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_item" ADD CONSTRAINT "compliance_item_verified_by_fk" FOREIGN KEY ("tenant_id","verified_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_item" ADD CONSTRAINT "compliance_item_risk_assessment_signed_by_fk" FOREIGN KEY ("tenant_id","risk_assessment_signed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profile" ADD CONSTRAINT "staff_profile_tenant_user_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profile" ADD CONSTRAINT "staff_profile_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compliance_item_reminder_idx" ON "compliance_item" USING btree ("tenant_id","expires_on","recheck_due_on");
--> statement-breakpoint

-- The staff profile and pre-employment file (slice 11; workforce.md sections 2a, 3 and 5; WORK-002,
-- WORK-011): the ADR-0002 patterns; read by holders of workforce.staff_file.read or .manage (or the
-- worker, with workforce.self.read), written by holders of .manage and never by the worker; each
-- verification in the verifier's own name; the DBS risk assessment signed only by a holder of
-- workforce.dbs_risk_assessment.sign who is not the worker; and HR-only documents read and added
-- only by holders of workforce.hr_document.read. Runs as harbour_owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_profile', 'compliance_item'] LOOP
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

-- Whether the session's member holds a staff file permission. Staff files are the organisation's
-- employment records, not people's care records, and HR functions are organisation-wide (master
-- prompt section 4): a tenant or location role or a grant anywhere counts
-- (app.holds_permission_anywhere), and so does a role with no person scope (HR's). A role scoped
-- to assigned people or to the person themselves counts only for workforce.self.read (the
-- worker's own file), so a cloned agency or portal-like role never reads everyone's file (review
-- round 1, finding 5). A role mixing portal and staff permissions gives none, as at sign-in.
CREATE OR REPLACE FUNCTION app.holds_staff_permission(p_permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.current_user_id() IS NOT NULL AND (
    app.holds_permission_anywhere(p_permission)
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
        AND (r.scope_kind::text = 'none' OR p_permission = 'workforce.self.read')
        AND NOT (r.permissions && ARRAY['comms.portal.family', 'comms.portal.self', 'comms.feed.read',
          'comms.notification.subscribe', 'comms.visit_booking.request']::text[])
        AND p_permission = ANY (r.permissions)))
$$;
--> statement-breakpoint

-- Whether the member may sign the DBS risk assessment of a profile: the sign permission where the
-- worker works, or across the organisation; a Registered Manager of another home may not (review
-- round 1, finding 5). Invoker rights: the profile's own policies.
CREATE OR REPLACE FUNCTION app.may_sign_dbs_risk_assessment(p_profile_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.holds_permission_at('workforce.dbs_risk_assessment.sign', NULL)
    OR EXISTS (SELECT 1 FROM public.staff_profile p
               WHERE p.id = p_profile_id AND p.location_id IS NOT NULL
                 AND app.holds_permission_at('workforce.dbs_risk_assessment.sign', p.location_id))
$$;
--> statement-breakpoint

-- The member a staff profile is about, as the caller can see it (invoker rights: the profile's
-- own policies); null when the caller cannot see it.
CREATE OR REPLACE FUNCTION app.staff_profile_member(p_profile_id uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT p.tenant_user_id FROM public.staff_profile p WHERE p.id = p_profile_id
$$;
--> statement-breakpoint
-- The member a compliance item is about, as the caller can see it; null when hidden.
CREATE OR REPLACE FUNCTION app.compliance_item_member(p_item_id uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT p.tenant_user_id FROM public.compliance_item i
  JOIN public.staff_profile p ON p.id = i.staff_profile_id
  WHERE i.id = p_item_id
$$;
--> statement-breakpoint

CREATE POLICY staff_profile_read ON public.staff_profile AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.is_system()
    OR app.holds_staff_permission('workforce.staff_file.read')
    OR app.holds_staff_permission('workforce.staff_file.manage')
    OR (tenant_user_id = app.current_user_id() AND app.holds_staff_permission('workforce.self.read')));
--> statement-breakpoint
CREATE POLICY staff_profile_insert ON public.staff_profile AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.is_system()
    OR (app.holds_staff_permission('workforce.staff_file.manage')
        AND tenant_user_id <> app.current_user_id()));
--> statement-breakpoint
CREATE POLICY staff_profile_update ON public.staff_profile AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.is_system()
    OR (app.holds_staff_permission('workforce.staff_file.manage')
        AND tenant_user_id <> app.current_user_id()))
  WITH CHECK (app.is_system()
    OR (app.holds_staff_permission('workforce.staff_file.manage')
        AND tenant_user_id <> app.current_user_id()));
--> statement-breakpoint

-- Items follow their profile for reading; written by holders of manage who are not the worker.
CREATE POLICY compliance_item_read ON public.compliance_item AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.is_system() OR app.staff_profile_member(staff_profile_id) IS NOT NULL);
--> statement-breakpoint
CREATE POLICY compliance_item_insert ON public.compliance_item AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.is_system()
    OR (app.holds_staff_permission('workforce.staff_file.manage')
        AND app.staff_profile_member(staff_profile_id) <> app.current_user_id()));
--> statement-breakpoint
-- A holder of the sign permission alone may sign a risk assessment (the guard below says what).
CREATE POLICY compliance_item_update ON public.compliance_item AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.is_system()
    OR ((app.holds_staff_permission('workforce.staff_file.manage')
         OR app.holds_staff_permission('workforce.dbs_risk_assessment.sign'))
        AND app.staff_profile_member(staff_profile_id) <> app.current_user_id()))
  WITH CHECK (app.is_system()
    OR ((app.holds_staff_permission('workforce.staff_file.manage')
         OR app.holds_staff_permission('workforce.dbs_risk_assessment.sign'))
        AND app.staff_profile_member(staff_profile_id) <> app.current_user_id()));
--> statement-breakpoint

-- A profile keeps its member.
CREATE OR REPLACE FUNCTION app.staff_profile_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_user_id IS DISTINCT FROM OLD.tenant_user_id THEN
    RAISE EXCEPTION 'A staff profile keeps its member of staff'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER staff_profile_guard BEFORE UPDATE ON public.staff_profile
  FOR EACH ROW EXECUTE FUNCTION app.staff_profile_guard();
--> statement-breakpoint

-- An item keeps its profile and kind. Evidence is verified in the verifier's own name, by a
-- holder of manage, and details changed under a verification are verified again by whoever
-- changed them (review round 1, finding 1); the DBS risk assessment is signed in the signer's own
-- name by a holder of the sign permission where the worker works (workforce.md rule 3), and only
-- the system clears it; a signer without manage changes nothing else.
CREATE OR REPLACE FUNCTION app.compliance_item_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_manage boolean := app.holds_staff_permission('workforce.staff_file.manage');
BEGIN
  IF app.is_system() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.staff_profile_id, NEW.kind) IS DISTINCT FROM (OLD.staff_profile_id, OLD.kind) THEN
    RAISE EXCEPTION 'A compliance item keeps its staff profile and kind'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.verified_by IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND (NEW.verified_on, NEW.verified_by)
           IS DISTINCT FROM (OLD.verified_on, OLD.verified_by) AND NEW.verified_by IS NOT NULL) THEN
    IF NEW.verified_by IS DISTINCT FROM app.current_user_id() OR NOT v_manage THEN
      RAISE EXCEPTION 'Evidence is verified by a holder of workforce.staff_file.manage, in their own name'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.detail IS DISTINCT FROM OLD.detail
     AND NEW.verified_by IS NOT NULL AND NEW.verified_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Changed details are verified again, in the name of whoever changed them'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.risk_assessment_signed_by IS NOT NULL
     AND NEW.risk_assessment_signed_by IS NULL THEN
    RAISE EXCEPTION 'A signed DBS risk assessment is not unsigned'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.risk_assessment_signed_by IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND (NEW.risk_assessment_signed_on, NEW.risk_assessment_signed_by)
           IS DISTINCT FROM (OLD.risk_assessment_signed_on, OLD.risk_assessment_signed_by)) THEN
    IF NOT app.may_sign_dbs_risk_assessment(NEW.staff_profile_id)
       OR (NEW.risk_assessment_signed_by IS NOT NULL
           AND NEW.risk_assessment_signed_by IS DISTINCT FROM app.current_user_id()) THEN
      RAISE EXCEPTION 'A DBS risk assessment is signed by a holder of workforce.dbs_risk_assessment.sign, in their own name'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT v_manage
     AND (NEW.detail, NEW.verified_on, NEW.verified_by, NEW.expires_on, NEW.recheck_due_on,
          NEW.deleted_at)
         IS DISTINCT FROM (OLD.detail, OLD.verified_on, OLD.verified_by, OLD.expires_on,
          OLD.recheck_due_on, OLD.deleted_at) THEN
    RAISE EXCEPTION 'Only a holder of workforce.staff_file.manage changes a compliance item'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER compliance_item_guard BEFORE INSERT OR UPDATE ON public.compliance_item
  FOR EACH ROW EXECUTE FUNCTION app.compliance_item_guard();
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_profile', 'compliance_item'] LOOP
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
GRANT SELECT, INSERT, UPDATE ON public.staff_profile, public.compliance_item TO harbour_app;
--> statement-breakpoint

-- HR-only staff documents (category staff_hr_document): read only by holders of
-- workforce.hr_document.read, added only by holders of it and of workforce.staff_file.manage to a
-- compliance item of someone else's file; everyone else, whatever their document permissions,
-- finds none (workforce.md section 3; section 12.4).
CREATE POLICY document_hr_only ON public.document AS RESTRICTIVE FOR ALL TO harbour_app
  USING (category <> 'staff_hr_document' OR app.is_system()
    OR (app.holds_staff_permission('workforce.hr_document.read')
        AND app.compliance_item_member(subject_id) IS DISTINCT FROM app.current_user_id()))
  WITH CHECK (category <> 'staff_hr_document' OR app.is_system()
    OR (app.holds_staff_permission('workforce.hr_document.read')
        AND app.holds_staff_permission('workforce.staff_file.manage')
        AND person_id IS NULL
        AND subject_type = 'compliance_item'
        AND app.compliance_item_member(subject_id) <> app.current_user_id()));
--> statement-breakpoint

-- Earlier versions of staff files follow the files' own read rule: the versions table is otherwise
-- readable across the organisation (review round 1, finding 7).
CREATE POLICY record_version_staff_file ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (table_name NOT IN ('staff_profile', 'compliance_item') OR app.is_system()
    OR app.holds_staff_permission('workforce.staff_file.read')
    OR app.holds_staff_permission('workforce.staff_file.manage'));
