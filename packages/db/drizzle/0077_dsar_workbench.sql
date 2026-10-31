CREATE TABLE "dsar_case" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"request_kind" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_person_id" uuid,
	"subject_contact_id" uuid,
	"subject_staff_id" uuid,
	"requester_kind" text NOT NULL,
	"requester_name" text,
	"requester_address" text,
	"authority" text,
	"channel" text NOT NULL,
	"received_on" date NOT NULL,
	"identity_required" boolean DEFAULT true NOT NULL,
	"identity_verified_on" date,
	"identity_method" text,
	"pauses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extension_months" integer,
	"extension_grounds" text,
	"extension_reason" text,
	"extension_decided_on" date,
	"responded_on" date,
	"status" text DEFAULT 'open' NOT NULL,
	"outcome" text,
	"outcome_reason" text,
	"not_searched" text[] DEFAULT '{}'::text[] NOT NULL,
	"collected_at" timestamp with time zone,
	"rectification" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"erasure" jsonb,
	"bundle_sha256" text,
	"bundle_issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "dsar_case_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "dsar_case_request_kind" CHECK (request_kind IN ('access', 'rectification', 'erasure', 'portability')),
	CONSTRAINT "dsar_case_subject" CHECK ((subject_kind = 'person' AND subject_person_id IS NOT NULL AND subject_contact_id IS NULL AND subject_staff_id IS NULL)
        OR (subject_kind = 'contact' AND subject_person_id IS NOT NULL AND subject_contact_id IS NOT NULL AND subject_staff_id IS NULL)
        OR (subject_kind = 'staff' AND subject_person_id IS NULL AND subject_contact_id IS NULL AND subject_staff_id IS NOT NULL)),
	CONSTRAINT "dsar_case_requester" CHECK ((requester_kind = 'subject' AND authority IS NULL)
        OR (requester_kind = 'representative' AND requester_name IS NOT NULL
          AND authority IS NOT NULL AND authority IN ('lpa_health_welfare', 'lpa_property_finance', 'deputy', 'written_authority', 'other'))),
	CONSTRAINT "dsar_case_channel" CHECK (channel IN ('email', 'post', 'phone', 'in_person', 'portal')),
	CONSTRAINT "dsar_case_identity" CHECK ((identity_verified_on IS NULL) = (identity_method IS NULL)
        AND (identity_method IS NULL OR identity_method IN ('document_seen', 'known_to_staff', 'authority_checked', 'portal_account'))),
	CONSTRAINT "dsar_case_extension" CHECK ((extension_months IS NULL AND extension_grounds IS NULL AND extension_reason IS NULL AND extension_decided_on IS NULL)
        OR (extension_months BETWEEN 1 AND 2 AND extension_grounds IS NOT NULL AND extension_grounds IN ('complex', 'multiple_requests')
          AND extension_reason IS NOT NULL AND extension_decided_on IS NOT NULL)),
	CONSTRAINT "dsar_case_pauses" CHECK (jsonb_typeof(pauses) = 'array'),
	CONSTRAINT "dsar_case_rectification" CHECK (jsonb_typeof(rectification) = 'array'),
	CONSTRAINT "dsar_case_status" CHECK (status IN ('open', 'closed', 'withdrawn')),
	CONSTRAINT "dsar_case_outcome" CHECK ((status = 'open' AND outcome IS NULL)
        OR (status = 'closed' AND outcome IS NOT NULL AND outcome IN ('fulfilled', 'partly_fulfilled', 'refused') AND responded_on IS NOT NULL)
        OR (status = 'withdrawn' AND outcome = 'withdrawn')),
	CONSTRAINT "dsar_case_outcome_reason" CHECK (outcome IS NULL OR outcome IN ('fulfilled', 'withdrawn') OR outcome_reason IS NOT NULL),
	CONSTRAINT "dsar_case_bundle" CHECK ((bundle_sha256 IS NULL) = (bundle_issued_at IS NULL)
        AND (bundle_sha256 IS NULL OR bundle_sha256 ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "dsar_item" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"case_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"record_id" text NOT NULL,
	"decision" text DEFAULT 'pending' NOT NULL,
	"redacted_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "dsar_item_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "dsar_item_case_record_key" UNIQUE("tenant_id","case_id","table_name","record_id"),
	CONSTRAINT "dsar_item_decision" CHECK (decision IN ('pending', 'disclose', 'redact', 'withhold')),
	CONSTRAINT "dsar_item_reviewed" CHECK ((decision = 'pending') = (reviewed_by IS NULL AND reviewed_at IS NULL)),
	CONSTRAINT "dsar_item_redaction" CHECK ((decision = 'redact') = (cardinality(redacted_fields) > 0)
        AND (decision IN ('pending', 'disclose') OR reason IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "dsar_case" ADD CONSTRAINT "dsar_case_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsar_case" ADD CONSTRAINT "dsar_case_person_fk" FOREIGN KEY ("tenant_id","subject_person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsar_case" ADD CONSTRAINT "dsar_case_contact_fk" FOREIGN KEY ("tenant_id","subject_person_id","subject_contact_id") REFERENCES "public"."contact"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsar_case" ADD CONSTRAINT "dsar_case_staff_fk" FOREIGN KEY ("tenant_id","subject_staff_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsar_item" ADD CONSTRAINT "dsar_item_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsar_item" ADD CONSTRAINT "dsar_item_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."dsar_case"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsar_item" ADD CONSTRAINT "dsar_item_reviewed_by_fk" FOREIGN KEY ("tenant_id","reviewed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dsar_case_tenant_status_idx" ON "dsar_case" USING btree ("tenant_id","status","received_on");--> statement-breakpoint
CREATE INDEX "dsar_item_case_decision_idx" ON "dsar_item" USING btree ("tenant_id","case_id","decision");--> statement-breakpoint
-- Security (ADR-0002, ADR-0090): forced RLS, the tenant policy, and only holders of
-- quality.dsar.manage read or write a case or its items. No DELETE grant for harbour_app (default
-- privileges); a case is closed or withdrawn, never deleted, and destroyed by the retention engine.
ALTER TABLE public.dsar_case ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.dsar_case FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.dsar_case AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY dsar_case_manage ON public.dsar_case AS RESTRICTIVE FOR ALL TO harbour_app
  USING (app.holds_role_permission_somewhere('quality.dsar.manage'))
  WITH CHECK (app.holds_role_permission_somewhere('quality.dsar.manage'));
--> statement-breakpoint
ALTER TABLE public.dsar_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.dsar_item FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.dsar_item AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY dsar_item_manage ON public.dsar_item AS RESTRICTIVE FOR ALL TO harbour_app
  USING (app.holds_role_permission_somewhere('quality.dsar.manage'))
  WITH CHECK (app.holds_role_permission_somewhere('quality.dsar.manage'));
--> statement-breakpoint
-- A closed or withdrawn case is the record of what was done: it never reopens or changes, and an
-- issued bundle's hash never changes.
CREATE OR REPLACE FUNCTION app.dsar_case_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status <> 'open' AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN
    RAISE EXCEPTION 'dsar case % is %, and cannot change', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.bundle_sha256 IS NOT NULL AND NEW.bundle_sha256 IS DISTINCT FROM OLD.bundle_sha256 THEN
    RAISE EXCEPTION 'dsar case % bundle hash cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER dsar_case_guard BEFORE UPDATE ON public.dsar_case
  FOR EACH ROW EXECUTE FUNCTION app.dsar_case_guard();
--> statement-breakpoint
-- Items are added and decided only while their case is open.
CREATE OR REPLACE FUNCTION app.dsar_item_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  case_status text;
BEGIN
  SELECT status INTO case_status FROM public.dsar_case
    WHERE tenant_id = NEW.tenant_id AND id = NEW.case_id;
  IF case_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'dsar case % is not open', NEW.case_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER dsar_item_guard BEFORE INSERT OR UPDATE ON public.dsar_item
  FOR EACH ROW EXECUTE FUNCTION app.dsar_item_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.dsar_case
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.dsar_case
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.dsar_item
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.dsar_item
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
