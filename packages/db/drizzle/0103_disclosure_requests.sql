CREATE TABLE "disclosure_item" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"request_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"record_id" text NOT NULL,
	"decision" text DEFAULT 'pending' NOT NULL,
	"redacted_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"content_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "disclosure_item_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "disclosure_item_record_key" UNIQUE("tenant_id","request_id","table_name","record_id"),
	CONSTRAINT "disclosure_item_decision" CHECK (decision IN ('pending', 'disclose', 'redact', 'withhold')),
	CONSTRAINT "disclosure_item_reviewed" CHECK ((decision = 'pending') = (reviewed_by IS NULL AND reviewed_at IS NULL AND content_sha256 IS NULL)
        AND (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "disclosure_item_redaction" CHECK ((decision = 'redact') = (cardinality(redacted_fields) > 0)
        AND (decision IN ('pending', 'disclose') OR reason IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "disclosure_request" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"type" text NOT NULL,
	"legal_basis" text NOT NULL,
	"requester_name" text NOT NULL,
	"requester_organisation" text NOT NULL,
	"requester_reference" text,
	"stated_purpose" text,
	"received_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"state" text DEFAULT 'requested' NOT NULL,
	"prepared_by" uuid,
	"prepared_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"pack_sha256" text,
	"pack_storage_key" text,
	"not_searched" text[] DEFAULT '{}'::text[] NOT NULL,
	"collected_at" timestamp with time zone,
	"prevention_report_on" date,
	"prevention_responded_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "disclosure_request_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "disclosure_request_type" CHECK (type IN ('coroner', 'safeguarding_adults_review', 'domestic_homicide_review', 'police', 'solicitor', 'access_to_health_records')),
	CONSTRAINT "disclosure_request_state" CHECK (state IN ('requested', 'prepared', 'approved', 'released', 'refused', 'withdrawn')),
	CONSTRAINT "disclosure_request_text" CHECK (char_length(btrim(legal_basis)) BETWEEN 10 AND 500
        AND char_length(btrim(requester_name)) BETWEEN 1 AND 200
        AND char_length(btrim(requester_organisation)) BETWEEN 1 AND 200
        AND (requester_reference IS NULL OR char_length(btrim(requester_reference)) BETWEEN 1 AND 100)
        AND (stated_purpose IS NULL OR char_length(btrim(stated_purpose)) BETWEEN 3 AND 2000)
        AND (reason IS NULL OR char_length(btrim(reason)) BETWEEN 3 AND 2000)),
	CONSTRAINT "disclosure_request_purpose" CHECK (type NOT IN ('police', 'solicitor') OR state IN ('requested', 'withdrawn') OR stated_purpose IS NOT NULL),
	CONSTRAINT "disclosure_request_steps" CHECK ((state = 'requested' OR state = 'withdrawn' OR state = 'refused' OR (prepared_by IS NOT NULL AND prepared_at IS NOT NULL))
        AND (state NOT IN ('approved', 'released', 'refused') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
        AND (state NOT IN ('refused', 'withdrawn') OR reason IS NOT NULL)
        AND (state = 'released') = (released_by IS NOT NULL AND released_at IS NOT NULL)),
	CONSTRAINT "disclosure_request_approver" CHECK (decided_by IS NULL OR decided_by IS DISTINCT FROM created_by),
	CONSTRAINT "disclosure_request_pack" CHECK ((pack_sha256 IS NULL) = (pack_storage_key IS NULL)
        AND (pack_sha256 IS NULL) = (state <> 'released')
        AND (pack_sha256 IS NULL OR pack_sha256 ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "disclosure_request_prevention" CHECK ((prevention_report_on IS NULL OR type = 'coroner')
        AND (prevention_responded_on IS NULL OR (prevention_report_on IS NOT NULL AND prevention_responded_on >= prevention_report_on)))
);
--> statement-breakpoint
ALTER TABLE "disclosure_item" ADD CONSTRAINT "disclosure_item_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosure_item" ADD CONSTRAINT "disclosure_item_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."disclosure_request"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosure_item" ADD CONSTRAINT "disclosure_item_reviewed_by_fk" FOREIGN KEY ("tenant_id","reviewed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD CONSTRAINT "disclosure_request_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD CONSTRAINT "disclosure_request_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD CONSTRAINT "disclosure_request_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD CONSTRAINT "disclosure_request_prepared_by_fk" FOREIGN KEY ("tenant_id","prepared_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD CONSTRAINT "disclosure_request_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD CONSTRAINT "disclosure_request_released_by_fk" FOREIGN KEY ("tenant_id","released_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disclosure_item_request_idx" ON "disclosure_item" USING btree ("tenant_id","request_id","decision");--> statement-breakpoint
CREATE INDEX "disclosure_request_state_idx" ON "disclosure_request" USING btree ("tenant_id","state","received_at");

-- Slice 41 (SAFE-016; safety.md section 11). A disclosure request concerns one person: holders of
-- safety.incident.manage or safety.disclosure.approve across the organisation, or at the location
-- stored with the request, read it; managers log and work it; approvers decide it, never the person
-- who logged it. The organisation's own system context (no member, the whole organisation) reads
-- both tables for the full export and the collector, never writes. Restrictive policies bind
-- harbour_owner as well as harbour_app (ADR-0002). No DELETE.
ALTER TABLE public.disclosure_request ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.disclosure_request FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.disclosure_request AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY disclosure_request_read ON public.disclosure_request AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING ((app.current_user_id() IS NULL AND app.current_scope() = 'tenant') OR app.holds_role_permission_at('safety.incident.manage', location_id) OR app.holds_role_permission_at('safety.disclosure.approve', location_id));
--> statement-breakpoint
CREATE POLICY disclosure_request_log ON public.disclosure_request AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (state = 'requested' AND prepared_by IS NULL AND decided_by IS NULL
    AND released_by IS NULL AND pack_sha256 IS NULL AND deleted_at IS NULL
    AND created_by IS NOT DISTINCT FROM app.current_user_id() AND app.holds_role_permission_at('safety.incident.manage', location_id));
--> statement-breakpoint
CREATE POLICY disclosure_request_change ON public.disclosure_request AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (app.holds_role_permission_at('safety.incident.manage', location_id) OR app.holds_role_permission_at('safety.disclosure.approve', location_id)) WITH CHECK (app.holds_role_permission_at('safety.incident.manage', location_id) OR app.holds_role_permission_at('safety.disclosure.approve', location_id));
--> statement-breakpoint
-- Rules 38 to 43: who, where, what and when it was asked never change; each step is taken by the
-- person recording it, approval only with safety.disclosure.approve; once released, refused or
-- withdrawn only a coroner's Regulation 28 dates may still be recorded.
CREATE OR REPLACE FUNCTION app.disclosure_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_me uuid := app.current_user_id();
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.legal_basis IS DISTINCT FROM OLD.legal_basis
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'disclosure_fixed_fields' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('released', 'refused', 'withdrawn')
     AND (to_jsonb(NEW) - ARRAY['prevention_report_on', 'prevention_responded_on', 'updated_at',
            'updated_by', 'version'])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['prevention_report_on', 'prevention_responded_on', 'updated_at',
            'updated_by', 'version']) THEN
    RAISE EXCEPTION 'disclosure_closed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.prepared_at IS DISTINCT FROM OLD.prepared_at AND NEW.prepared_by IS DISTINCT FROM v_me THEN
    RAISE EXCEPTION 'disclosure_preparer_not_you' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decided_at IS DISTINCT FROM OLD.decided_at AND (NEW.decided_by IS DISTINCT FROM v_me
       OR NOT app.holds_role_permission_at('safety.disclosure.approve', NEW.location_id)) THEN
    RAISE EXCEPTION 'disclosure_approver_not_you' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.released_at IS DISTINCT FROM OLD.released_at AND NEW.released_by IS DISTINCT FROM v_me THEN
    RAISE EXCEPTION 'disclosure_releaser_not_you' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER disclosure_request_guard BEFORE UPDATE ON public.disclosure_request
  FOR EACH ROW EXECUTE FUNCTION app.disclosure_request_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.disclosure_request
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.disclosure_request
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.disclosure_request TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.disclosure_request FROM harbour_app;
--> statement-breakpoint

-- Items follow their request: read with it, written by a manager of it, decided by the reviewer in
-- their own name, and only while the request is still being worked (requested).
ALTER TABLE public.disclosure_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.disclosure_item FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.disclosure_item AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY disclosure_item_read ON public.disclosure_item AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (EXISTS (SELECT 1 FROM public.disclosure_request r
                  WHERE r.tenant_id = disclosure_item.tenant_id AND r.id = disclosure_item.request_id));
--> statement-breakpoint
CREATE POLICY disclosure_item_write ON public.disclosure_item AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (decision = 'pending' AND deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM public.disclosure_request r
     WHERE r.tenant_id = disclosure_item.tenant_id AND r.id = disclosure_item.request_id
       AND r.state = 'requested'
       AND app.holds_role_permission_at('safety.incident.manage', r.location_id)));
--> statement-breakpoint
CREATE POLICY disclosure_item_change ON public.disclosure_item AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (EXISTS (
    SELECT 1 FROM public.disclosure_request r
     WHERE r.tenant_id = disclosure_item.tenant_id AND r.id = disclosure_item.request_id
       AND r.state = 'requested'
       AND app.holds_role_permission_at('safety.incident.manage', r.location_id)))
  WITH CHECK (reviewed_by IS NULL OR reviewed_by = app.current_user_id());
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.disclosure_item_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.table_name IS DISTINCT FROM OLD.table_name OR NEW.record_id IS DISTINCT FROM OLD.record_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'disclosure_item_fixed_fields' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER disclosure_item_guard BEFORE UPDATE ON public.disclosure_item
  FOR EACH ROW EXECUTE FUNCTION app.disclosure_item_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.disclosure_item
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.disclosure_item
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.disclosure_item TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.disclosure_item FROM harbour_app;
