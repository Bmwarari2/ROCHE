CREATE TABLE "dcb0160_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"safety_case_version" text NOT NULL,
	"recorded_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "dcb0160_record_version" CHECK (char_length(btrim(safety_case_version)) BETWEEN 1 AND 40)
);
--> statement-breakpoint
CREATE TABLE "retention_decision" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"record_class" text NOT NULL,
	"kind" text NOT NULL,
	"decided_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "retention_decision_kind" CHECK (kind IN ('accepted', 'lengthened', 'period_set', 'not_used'))
);
--> statement-breakpoint
CREATE TABLE "tenant_setting_decision" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"rate_key" text NOT NULL,
	"kind" text NOT NULL,
	"decided_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "tenant_setting_decision_kind" CHECK (kind IN ('accepted', 'set'))
);
--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "staff_file_option" text;--> statement-breakpoint
ALTER TABLE "dcb0160_record" ADD CONSTRAINT "dcb0160_record_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dcb0160_record" ADD CONSTRAINT "dcb0160_record_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_decision" ADD CONSTRAINT "retention_decision_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_decision" ADD CONSTRAINT "retention_decision_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_setting_decision" ADD CONSTRAINT "tenant_setting_decision_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_setting_decision" ADD CONSTRAINT "tenant_setting_decision_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dcb0160_record_recorded_idx" ON "dcb0160_record" USING btree ("tenant_id","recorded_at");--> statement-breakpoint
CREATE INDEX "retention_decision_class_idx" ON "retention_decision" USING btree ("tenant_id","record_class","decided_at");--> statement-breakpoint
CREATE INDEX "tenant_setting_decision_key_idx" ON "tenant_setting_decision" USING btree ("tenant_id","rate_key","decided_at");--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_staff_file_option" CHECK (staff_file_option IS NULL OR staff_file_option IN ('staff_file.after_leaving', 'staff_file.to_75th_birthday'));--> statement-breakpoint

-- Onboarding decisions (platform-completions.md rules 26 and 27; depends on 0063). Each is an
-- append-only record of who decided what and when: a later decision is a new row, and a change
-- by Harbour reopens it because the checklist compares times. Read with the onboarding
-- permissions; written only by a holder of platform.onboarding.manage, in their own name.
DO $$
DECLARE
  t text;
  actor text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_setting_decision', 'retention_decision', 'dcb0160_record'] LOOP
    actor := CASE t WHEN 'dcb0160_record' THEN 'recorded_by' ELSE 'decided_by' END;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO harbour_app '
      'USING (app.holds_permission_anywhere(''platform.onboarding.read'') '
      'OR app.holds_permission_anywhere(''platform.onboarding.manage''))', t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO harbour_app '
      'WITH CHECK (%I = app.current_user_id() AND created_by = app.current_user_id() '
      'AND app.holds_permission_anywhere(''platform.onboarding.manage''))', t || '_write', t, actor);
    EXECUTE format(
      'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format(
      'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO harbour_app', t);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM harbour_app', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- The staff file option is part of the organisation's retention decisions: only a holder of
-- platform.onboarding.manage changes it (the application role; the operator and owner roles
-- provision and seed).
CREATE OR REPLACE FUNCTION app.tenant_staff_file_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user = 'harbour_app'
     AND NEW.staff_file_option IS DISTINCT FROM OLD.staff_file_option
     AND NOT app.holds_permission_anywhere('platform.onboarding.manage') THEN
    RAISE EXCEPTION 'The staff file option changes only with platform.onboarding.manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_staff_file_guard BEFORE UPDATE ON public.tenant
  FOR EACH ROW EXECUTE FUNCTION app.tenant_staff_file_guard();
