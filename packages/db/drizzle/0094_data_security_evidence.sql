CREATE TABLE "dspt_assertion" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"financial_year" text NOT NULL,
	"assertion_ref" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"notes" text,
	"owner_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "dspt_assertion_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "dspt_assertion_ref_key" UNIQUE("tenant_id","financial_year","assertion_ref"),
	CONSTRAINT "dspt_assertion_year" CHECK (financial_year ~ '^[0-9]{4}/[0-9]{2}$'),
	CONSTRAINT "dspt_assertion_ref" CHECK (assertion_ref ~ '^[0-9]{1,2}(\.[0-9]{1,2}){1,3}$'),
	CONSTRAINT "dspt_assertion_status" CHECK (status IN ('not_started', 'in_progress', 'met', 'not_met', 'not_applicable')),
	CONSTRAINT "dspt_assertion_text" CHECK (char_length(btrim(title)) BETWEEN 3 AND 500
        AND (notes IS NULL OR char_length(btrim(notes)) BETWEEN 1 AND 4000)
        AND (status NOT IN ('not_met', 'not_applicable') OR notes IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "dspt_evidence" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"assertion_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"recorded_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dspt_evidence_kind" CHECK (kind IN ('linked', 'unlinked'))
);
--> statement-breakpoint
CREATE TABLE "dspt_submission" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"financial_year" text NOT NULL,
	"submitted_on" date NOT NULL,
	"outcome" text NOT NULL,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "dspt_submission_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "dspt_submission_year_key" UNIQUE("tenant_id","financial_year"),
	CONSTRAINT "dspt_submission_year" CHECK (financial_year ~ '^[0-9]{4}/[0-9]{2}$'),
	CONSTRAINT "dspt_submission_outcome" CHECK (outcome IN ('standards_met', 'approaching_standards', 'standards_not_met')),
	CONSTRAINT "dspt_submission_reference" CHECK (reference IS NULL OR char_length(btrim(reference)) BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "security_certificate" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"kind" text NOT NULL,
	"reference" text NOT NULL,
	"issued_on" date NOT NULL,
	"expires_on" date,
	"issuer" text,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "security_certificate_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "security_certificate_kind" CHECK (kind IN ('cyber_essentials', 'cyber_essentials_plus', 'ico_registration')),
	CONSTRAINT "security_certificate_text" CHECK (char_length(btrim(reference)) BETWEEN 1 AND 100
        AND (issuer IS NULL OR char_length(btrim(issuer)) BETWEEN 1 AND 200)),
	CONSTRAINT "security_certificate_dates" CHECK (expires_on IS NULL OR expires_on > issued_on)
);
--> statement-breakpoint
ALTER TABLE "dspt_assertion" ADD CONSTRAINT "dspt_assertion_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dspt_assertion" ADD CONSTRAINT "dspt_assertion_owner_fk" FOREIGN KEY ("tenant_id","owner_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dspt_evidence" ADD CONSTRAINT "dspt_evidence_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dspt_evidence" ADD CONSTRAINT "dspt_evidence_assertion_fk" FOREIGN KEY ("tenant_id","assertion_id") REFERENCES "public"."dspt_assertion"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dspt_evidence" ADD CONSTRAINT "dspt_evidence_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dspt_evidence" ADD CONSTRAINT "dspt_evidence_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dspt_submission" ADD CONSTRAINT "dspt_submission_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_certificate" ADD CONSTRAINT "security_certificate_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_certificate" ADD CONSTRAINT "security_certificate_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dspt_evidence_assertion_idx" ON "dspt_evidence" USING btree ("tenant_id","assertion_id","recorded_at");--> statement-breakpoint
CREATE INDEX "security_certificate_kind_idx" ON "security_certificate" USING btree ("tenant_id","kind","issued_on");

-- Slice 32 (QUAL-012; quality.md section 18). Forced row-level security on the data security
-- evidence: read and written only by whoever holds quality.dsar.manage across the whole
-- organisation (as the breach register, migration 0082: a manager for one home sees nothing), and
-- read by the system (an hourly job with no member) to raise renewal tasks. Restrictive policies
-- bind harbour_owner as well as harbour_app (ADR-0002). Evidence links are append-only.
-- The creator, the creation time, the organisation and removal never change (history is kept by
-- capture_version; nothing is deleted).
CREATE OR REPLACE FUNCTION app.data_security_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'data_security_fixed_fields' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER TABLE public.dspt_assertion ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.dspt_assertion FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.dspt_assertion AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY dspt_assertion_read ON public.dspt_assertion AS RESTRICTIVE FOR SELECT TO harbour_app, harbour_owner
  USING (app.is_system() OR app.holds_role_permission_at('quality.dsar.manage', NULL));
--> statement-breakpoint
CREATE POLICY dspt_assertion_record ON public.dspt_assertion AS RESTRICTIVE FOR INSERT TO harbour_app, harbour_owner
  WITH CHECK (deleted_at IS NULL AND created_by IS NOT DISTINCT FROM app.current_user_id()
    AND app.holds_role_permission_at('quality.dsar.manage', NULL));
--> statement-breakpoint
CREATE POLICY dspt_assertion_change ON public.dspt_assertion AS RESTRICTIVE FOR UPDATE TO harbour_app, harbour_owner
  USING (app.holds_role_permission_at('quality.dsar.manage', NULL)) WITH CHECK (app.holds_role_permission_at('quality.dsar.manage', NULL));
--> statement-breakpoint
CREATE TRIGGER dspt_assertion_guard BEFORE UPDATE ON public.dspt_assertion
  FOR EACH ROW EXECUTE FUNCTION app.data_security_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.dspt_assertion
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.dspt_assertion
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.dspt_assertion TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.dspt_assertion FROM harbour_app;
--> statement-breakpoint
ALTER TABLE public.dspt_evidence ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.dspt_evidence FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.dspt_evidence AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY dspt_evidence_read ON public.dspt_evidence AS RESTRICTIVE FOR SELECT TO harbour_app, harbour_owner
  USING (app.holds_role_permission_at('quality.dsar.manage', NULL));
--> statement-breakpoint
CREATE POLICY dspt_evidence_record ON public.dspt_evidence AS RESTRICTIVE FOR INSERT TO harbour_app, harbour_owner
  WITH CHECK (recorded_by = app.current_user_id() AND app.holds_role_permission_at('quality.dsar.manage', NULL));
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.dspt_evidence
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.dspt_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON public.dspt_evidence TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.dspt_evidence FROM harbour_app;
--> statement-breakpoint
ALTER TABLE public.dspt_submission ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.dspt_submission FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.dspt_submission AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY dspt_submission_read ON public.dspt_submission AS RESTRICTIVE FOR SELECT TO harbour_app, harbour_owner
  USING (app.is_system() OR app.holds_role_permission_at('quality.dsar.manage', NULL));
--> statement-breakpoint
CREATE POLICY dspt_submission_record ON public.dspt_submission AS RESTRICTIVE FOR INSERT TO harbour_app, harbour_owner
  WITH CHECK (deleted_at IS NULL AND created_by IS NOT DISTINCT FROM app.current_user_id()
    AND app.holds_role_permission_at('quality.dsar.manage', NULL));
--> statement-breakpoint
CREATE POLICY dspt_submission_change ON public.dspt_submission AS RESTRICTIVE FOR UPDATE TO harbour_app, harbour_owner
  USING (app.holds_role_permission_at('quality.dsar.manage', NULL)) WITH CHECK (app.holds_role_permission_at('quality.dsar.manage', NULL));
--> statement-breakpoint
CREATE TRIGGER dspt_submission_guard BEFORE UPDATE ON public.dspt_submission
  FOR EACH ROW EXECUTE FUNCTION app.data_security_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.dspt_submission
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.dspt_submission
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.dspt_submission TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.dspt_submission FROM harbour_app;
--> statement-breakpoint
ALTER TABLE public.security_certificate ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.security_certificate FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.security_certificate AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY security_certificate_read ON public.security_certificate AS RESTRICTIVE FOR SELECT TO harbour_app, harbour_owner
  USING (app.is_system() OR app.holds_role_permission_at('quality.dsar.manage', NULL));
--> statement-breakpoint
CREATE POLICY security_certificate_record ON public.security_certificate AS RESTRICTIVE FOR INSERT TO harbour_app, harbour_owner
  WITH CHECK (deleted_at IS NULL AND created_by IS NOT DISTINCT FROM app.current_user_id()
    AND app.holds_role_permission_at('quality.dsar.manage', NULL));
--> statement-breakpoint
CREATE POLICY security_certificate_change ON public.security_certificate AS RESTRICTIVE FOR UPDATE TO harbour_app, harbour_owner
  USING (app.holds_role_permission_at('quality.dsar.manage', NULL)) WITH CHECK (app.holds_role_permission_at('quality.dsar.manage', NULL));
--> statement-breakpoint
CREATE TRIGGER security_certificate_guard BEFORE UPDATE ON public.security_certificate
  FOR EACH ROW EXECUTE FUNCTION app.data_security_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.security_certificate
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.security_certificate
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.security_certificate TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.security_certificate FROM harbour_app;
