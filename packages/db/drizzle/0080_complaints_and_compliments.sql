CREATE TABLE "complaint" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"person_id" uuid,
	"complainant_name" text NOT NULL,
	"complainant_relationship" text NOT NULL,
	"complainant_contact" text,
	"channel" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"knew_of_matter_on" date NOT NULL,
	"summary" text NOT NULL,
	"state" text DEFAULT 'received' NOT NULL,
	"pauses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"response" jsonb,
	"responded_at" timestamp with time zone,
	"appeal_received_at" timestamp with time zone,
	"appeal_reason" text,
	"appeal_response" jsonb,
	"appeal_responded_at" timestamp with time zone,
	"closed_reason" text,
	"closed_at" timestamp with time zone,
	"recorded_by" uuid NOT NULL,
	"retention_class" text DEFAULT 'complaint' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "complaint_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "complaint_state" CHECK (state IN ('received', 'acknowledged', 'investigating', 'responded', 'appealed', 'appeal_responded', 'closed')),
	CONSTRAINT "complaint_relationship" CHECK (complainant_relationship IN ('person_using_service', 'family_or_friend', 'representative', 'professional', 'member_of_public', 'other')),
	CONSTRAINT "complaint_channel" CHECK (channel IN ('in_person', 'phone', 'email', 'letter', 'other')),
	CONSTRAINT "complaint_retention_class" CHECK (retention_class = 'complaint'),
	CONSTRAINT "complaint_summary" CHECK (length(btrim(summary)) BETWEEN 3 AND 10000),
	CONSTRAINT "complaint_name" CHECK (length(btrim(complainant_name)) BETWEEN 1 AND 200),
	CONSTRAINT "complaint_pauses" CHECK (jsonb_typeof(pauses) = 'array'),
	CONSTRAINT "complaint_closed" CHECK ((state = 'closed') = (closed_at IS NOT NULL AND closed_reason IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "compliment" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"person_id" uuid,
	"from_name" text NOT NULL,
	"from_relationship" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"summary" text NOT NULL,
	"staff_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"evidence_statement_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"document_id" uuid,
	"recorded_by" uuid NOT NULL,
	"retention_class" text DEFAULT 'complaint' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "compliment_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "compliment_relationship" CHECK (from_relationship IN ('person_using_service', 'family_or_friend', 'representative', 'professional', 'member_of_public', 'other')),
	CONSTRAINT "compliment_retention_class" CHECK (retention_class = 'complaint'),
	CONSTRAINT "compliment_summary" CHECK (length(btrim(summary)) BETWEEN 3 AND 10000),
	CONSTRAINT "compliment_name" CHECK (length(btrim(from_name)) BETWEEN 1 AND 200),
	CONSTRAINT "compliment_statements" CHECK (array_position(evidence_statement_ids, NULL) IS NULL AND cardinality(evidence_statement_ids) <= 50)
);
--> statement-breakpoint
ALTER TABLE "complaint" ADD CONSTRAINT "complaint_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint" ADD CONSTRAINT "complaint_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint" ADD CONSTRAINT "complaint_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliment" ADD CONSTRAINT "compliment_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliment" ADD CONSTRAINT "compliment_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliment" ADD CONSTRAINT "compliment_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliment" ADD CONSTRAINT "compliment_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "complaint_location_idx" ON "complaint" USING btree ("tenant_id","location_id","received_at");--> statement-breakpoint
CREATE INDEX "compliment_location_idx" ON "compliment" USING btree ("tenant_id","location_id","received_at");--> statement-breakpoint

-- Complaints and compliments (Phase 2 slice 18; safety.md Phase 2 rule 2; SAFE-011). Forced RLS;
-- seen at the homes the caller's scope reaches, and read, recorded and changed only by a holder of
-- safety.complaint.manage where the record is (a job with no member keeps the organisation's view);
-- recorded in the recorder's own name. A record keeps its identity, home and receipt time; nothing
-- is deleted by the application (retention removes it, as a job). Versions are captured.
ALTER TABLE public.complaint ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.complaint FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.compliment ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.compliment FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.complaint AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.compliment AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.complaint_location_visible(p_location_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE app.current_scope()
    WHEN 'tenant' THEN true
    WHEN 'locations' THEN p_location_id = ANY (app.current_location_ids())
    ELSE false
  END
$$;
--> statement-breakpoint
CREATE POLICY complaint_scope ON public.complaint AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner
  USING (app.complaint_location_visible(location_id))
  WITH CHECK (app.complaint_location_visible(location_id));
--> statement-breakpoint
CREATE POLICY compliment_scope ON public.compliment AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner
  USING (app.complaint_location_visible(location_id))
  WITH CHECK (app.complaint_location_visible(location_id));
--> statement-breakpoint
CREATE POLICY complaint_read ON public.complaint AS RESTRICTIVE FOR SELECT TO harbour_app
  USING ((app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
    OR app.holds_permission_at('safety.complaint.manage', location_id));
--> statement-breakpoint
CREATE POLICY compliment_read ON public.compliment AS RESTRICTIVE FOR SELECT TO harbour_app
  USING ((app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
    OR app.holds_permission_at('safety.complaint.manage', location_id));
--> statement-breakpoint
CREATE POLICY complaint_write ON public.complaint AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (recorded_by = app.current_user_id()
    AND app.holds_permission_at('safety.complaint.manage', location_id));
--> statement-breakpoint
CREATE POLICY compliment_write ON public.compliment AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (recorded_by = app.current_user_id()
    AND app.holds_permission_at('safety.complaint.manage', location_id));
--> statement-breakpoint
CREATE POLICY complaint_change ON public.complaint AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING ((app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
    OR app.holds_permission_at('safety.complaint.manage', location_id))
  WITH CHECK ((app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
    OR app.holds_permission_at('safety.complaint.manage', location_id));
--> statement-breakpoint
CREATE POLICY compliment_change ON public.compliment AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING ((app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
    OR app.holds_permission_at('safety.complaint.manage', location_id))
  WITH CHECK ((app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
    OR app.holds_permission_at('safety.complaint.manage', location_id));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.complaint_record_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.location_id, NEW.received_at, NEW.recorded_by, NEW.created_at,
      NEW.created_by)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.location_id, OLD.received_at, OLD.recorded_by, OLD.created_at,
      OLD.created_by) THEN
    RAISE EXCEPTION 'A complaint or compliment keeps its identity, home, receipt time and recorder'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND app.current_user_id() IS NOT NULL THEN
    RAISE EXCEPTION 'A complaint or compliment is removed only by the retention schedule'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER complaint_guard BEFORE UPDATE ON public.complaint
  FOR EACH ROW EXECUTE FUNCTION app.complaint_record_guard();
--> statement-breakpoint
CREATE TRIGGER compliment_guard BEFORE UPDATE ON public.compliment
  FOR EACH ROW EXECUTE FUNCTION app.complaint_record_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.complaint
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.complaint
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.compliment
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.compliment
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.complaint TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.compliment TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.complaint FROM harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.compliment FROM harbour_app;
