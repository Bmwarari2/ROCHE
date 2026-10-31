CREATE TABLE "vetting_check" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"consent_id" uuid,
	"requested_by" uuid NOT NULL,
	"checked" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"external_reference" text,
	"result" jsonb,
	"error" text,
	"completed_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"applied_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "vetting_check_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "vetting_check_kind" CHECK (kind IN ('idsp_right_to_work', 'dbs_application', 'dbs_status_check', 'nmc_register_check')),
	CONSTRAINT "vetting_check_state" CHECK (state IN ('pending', 'completed', 'failed')),
	CONSTRAINT "vetting_check_consent" CHECK ((consent_id IS NOT NULL) = (kind IN ('dbs_application', 'dbs_status_check'))),
	CONSTRAINT "vetting_check_checked" CHECK (jsonb_typeof(checked) = 'object'),
	CONSTRAINT "vetting_check_completed" CHECK ((state = 'completed') = (result IS NOT NULL) AND (state = 'pending') = (completed_at IS NULL)
        AND (state <> 'failed' OR error IS NOT NULL)),
	CONSTRAINT "vetting_check_error" CHECK (error IS NULL OR length(error) <= 200),
	CONSTRAINT "vetting_check_applied" CHECK ((applied_at IS NULL) = (applied_by IS NULL) AND (applied_at IS NULL OR state = 'completed'))
);
--> statement-breakpoint
CREATE TABLE "vetting_consent" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"given_on" date NOT NULL,
	"recorded_by" uuid NOT NULL,
	"withdrawn_on" date,
	"withdrawn_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "vetting_consent_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "vetting_consent_purpose" CHECK (purpose IN ('dbs_application', 'dbs_update_service')),
	CONSTRAINT "vetting_consent_withdrawn" CHECK ((withdrawn_on IS NULL) = (withdrawn_by IS NULL) AND (withdrawn_on IS NULL OR withdrawn_on >= given_on))
);
--> statement-breakpoint
ALTER TABLE "compliance_item" ADD COLUMN "evidence_source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "compliance_item" ADD COLUMN "vetting_check_id" uuid;--> statement-breakpoint
ALTER TABLE "vetting_check" ADD CONSTRAINT "vetting_check_profile_fk" FOREIGN KEY ("tenant_id","staff_profile_id") REFERENCES "public"."staff_profile"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vetting_check" ADD CONSTRAINT "vetting_check_consent_fk" FOREIGN KEY ("tenant_id","consent_id") REFERENCES "public"."vetting_consent"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vetting_check" ADD CONSTRAINT "vetting_check_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vetting_check" ADD CONSTRAINT "vetting_check_applied_by_fk" FOREIGN KEY ("tenant_id","applied_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vetting_consent" ADD CONSTRAINT "vetting_consent_profile_fk" FOREIGN KEY ("tenant_id","staff_profile_id") REFERENCES "public"."staff_profile"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vetting_consent" ADD CONSTRAINT "vetting_consent_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vetting_consent" ADD CONSTRAINT "vetting_consent_withdrawn_by_fk" FOREIGN KEY ("tenant_id","withdrawn_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vetting_check_profile_idx" ON "vetting_check" USING btree ("tenant_id","staff_profile_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vetting_check_pending_key" ON "vetting_check" USING btree ("tenant_id","staff_profile_id","kind") WHERE state = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "vetting_consent_in_force_key" ON "vetting_consent" USING btree ("tenant_id","staff_profile_id","purpose") WHERE withdrawn_on IS NULL;--> statement-breakpoint
ALTER TABLE "compliance_item" ADD CONSTRAINT "compliance_item_vetting_check_fk" FOREIGN KEY ("tenant_id","vetting_check_id") REFERENCES "public"."vetting_check"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_item" ADD CONSTRAINT "compliance_item_evidence_source" CHECK (evidence_source IN ('manual', 'idsp_right_to_work', 'dbs_application', 'dbs_status_check', 'nmc_register_check') AND (evidence_source = 'manual') = (vetting_check_id IS NULL));--> statement-breakpoint

-- Identity and vetting adapters (slice 77; workforce.md section 2e and rule 24; ADR-0094): the
-- ADR-0002 patterns. Consents and checks follow their staff file for reading (as compliance items
-- do: holders of workforce.staff_file.read or .manage, and the worker their own) and are written
-- only by holders of workforce.staff_file.manage who are not the worker, each in the writer's own
-- name. A check moves forward only and is applied once; a compliance item names a check as its
-- source only once that check is applied, by the same member, to the same file and item. Runs as
-- harbour_owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vetting_consent', 'vetting_check'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO harbour_app '
      'USING (app.is_system() OR app.staff_profile_member(staff_profile_id) IS NOT NULL)',
      t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO harbour_app '
      'WITH CHECK (app.is_system() OR (app.holds_staff_permission(''workforce.staff_file.manage'') '
      'AND app.staff_profile_member(staff_profile_id) <> app.current_user_id()))',
      t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO harbour_app '
      'USING (app.is_system() OR (app.holds_staff_permission(''workforce.staff_file.manage'') '
      'AND app.staff_profile_member(staff_profile_id) <> app.current_user_id())) '
      'WITH CHECK (app.is_system() OR (app.holds_staff_permission(''workforce.staff_file.manage'') '
      'AND app.staff_profile_member(staff_profile_id) <> app.current_user_id()))',
      t || '_update', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- A consent is recorded in the recorder's own name, keeps everything it said, and is withdrawn
-- once, in the withdrawer's own name.
CREATE OR REPLACE FUNCTION app.vetting_consent_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.is_system() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() OR NEW.withdrawn_on IS NOT NULL THEN
      RAISE EXCEPTION 'A consent is recorded in the recorder''s own name, in force'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.staff_profile_id, NEW.purpose, NEW.given_on, NEW.recorded_by, NEW.deleted_at)
     IS DISTINCT FROM (OLD.staff_profile_id, OLD.purpose, OLD.given_on, OLD.recorded_by, OLD.deleted_at) THEN
    RAISE EXCEPTION 'A consent keeps what it recorded'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.withdrawn_on, NEW.withdrawn_by) IS DISTINCT FROM (OLD.withdrawn_on, OLD.withdrawn_by) THEN
    IF OLD.withdrawn_on IS NOT NULL THEN
      RAISE EXCEPTION 'A consent is withdrawn once'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.withdrawn_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A withdrawal is recorded in the recorder''s own name'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER vetting_consent_guard BEFORE INSERT OR UPDATE ON public.vetting_consent
  FOR EACH ROW EXECUTE FUNCTION app.vetting_consent_guard();
--> statement-breakpoint

-- A check is requested in the requester's own name, pending, with the DBS checks' consent in force
-- on the UK day for the right purpose and file. It keeps what it checked; pending moves to completed
-- or failed and nowhere else, and a completed check is applied once, in the applier's own name.
CREATE OR REPLACE FUNCTION app.vetting_check_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Europe/London')::date;
BEGIN
  IF app.is_system() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.requested_by IS DISTINCT FROM app.current_user_id() OR NEW.state <> 'pending'
       OR NEW.applied_at IS NOT NULL THEN
      RAISE EXCEPTION 'A check is requested in the requester''s own name, pending'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.consent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.vetting_consent c
      WHERE c.id = NEW.consent_id AND c.staff_profile_id = NEW.staff_profile_id
        AND c.purpose = CASE NEW.kind WHEN 'dbs_application' THEN 'dbs_application'
                                      ELSE 'dbs_update_service' END
        AND c.given_on <= v_today AND (c.withdrawn_on IS NULL OR c.withdrawn_on > v_today)) THEN
      RAISE EXCEPTION 'A DBS check needs the worker''s consent in force today'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.staff_profile_id, NEW.kind, NEW.provider, NEW.consent_id, NEW.requested_by, NEW.checked,
      NEW.deleted_at)
     IS DISTINCT FROM (OLD.staff_profile_id, OLD.kind, OLD.provider, OLD.consent_id,
      OLD.requested_by, OLD.checked, OLD.deleted_at) THEN
    RAISE EXCEPTION 'A check keeps its file, kind, provider, consent and what it checked'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state <> 'pending' AND (NEW.state, NEW.result, NEW.error, NEW.completed_at,
      NEW.external_reference)
     IS DISTINCT FROM (OLD.state, OLD.result, OLD.error, OLD.completed_at, OLD.external_reference) THEN
    RAISE EXCEPTION 'A completed or failed check keeps its answer'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.applied_at, NEW.applied_by) IS DISTINCT FROM (OLD.applied_at, OLD.applied_by) THEN
    IF OLD.applied_at IS NOT NULL THEN
      RAISE EXCEPTION 'A check is applied once'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.applied_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A check is applied in the applier''s own name'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER vetting_check_guard BEFORE INSERT OR UPDATE ON public.vetting_check
  FOR EACH ROW EXECUTE FUNCTION app.vetting_check_guard();
--> statement-breakpoint

-- A compliance item names a check as its source only when that check, of the item's file and of a
-- kind that is evidence for the item, was applied by the member writing the item. Recorded by hand
-- it goes back to manual (the CHECK keeps the source and the check together).
CREATE OR REPLACE FUNCTION app.compliance_item_source_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.is_system() OR NEW.vetting_check_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.vetting_check_id IS NOT DISTINCT FROM OLD.vetting_check_id THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.vetting_check v
    WHERE v.id = NEW.vetting_check_id AND v.staff_profile_id = NEW.staff_profile_id
      AND v.kind = NEW.evidence_source AND v.state = 'completed'
      AND v.applied_by = app.current_user_id()
      AND NEW.kind = CASE v.kind WHEN 'idsp_right_to_work' THEN 'right_to_work'
                                 WHEN 'nmc_register_check' THEN 'professional_registration'
                                 ELSE 'dbs_certificate' END) THEN
    RAISE EXCEPTION 'An item''s source is a check of its file and kind, applied by its writer'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER compliance_item_source_guard BEFORE INSERT OR UPDATE ON public.compliance_item
  FOR EACH ROW EXECUTE FUNCTION app.compliance_item_source_guard();
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vetting_consent', 'vetting_check'] LOOP
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
GRANT SELECT, INSERT, UPDATE ON public.vetting_consent, public.vetting_check TO harbour_app;
--> statement-breakpoint
-- Earlier versions follow the staff file's read rule (as migration 0073 does for the file).
CREATE POLICY record_version_vetting ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (table_name NOT IN ('vetting_consent', 'vetting_check')
    OR app.is_system()
    OR app.holds_staff_permission('workforce.staff_file.read')
    OR app.holds_staff_permission('workforce.staff_file.manage'));
