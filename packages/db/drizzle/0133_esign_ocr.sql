CREATE TABLE "ocr_extraction" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text DEFAULT 'mar' NOT NULL,
	"engine" text NOT NULL,
	"location" text NOT NULL,
	"state" text NOT NULL,
	"failure" text,
	"requested_by" uuid NOT NULL,
	"client_ref" uuid,
	"lines_counted" integer,
	"line_statuses" jsonb,
	"chart_from" date,
	"chart_to" date,
	"person_confirmed_by" uuid,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"discarded_by" uuid,
	"discarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ocr_extraction_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "ocr_extraction_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "ocr_extraction_client_ref_key" UNIQUE("tenant_id","client_ref"),
	CONSTRAINT "ocr_extraction_kind" CHECK (kind IN ('mar')),
	CONSTRAINT "ocr_extraction_engine" CHECK ((engine, location) IN (('google_document_ai', 'europe-west2'), ('mock', 'local'))),
	CONSTRAINT "ocr_extraction_state" CHECK (state IN ('blocked', 'failed', 'ready', 'released', 'discarded')),
	CONSTRAINT "ocr_extraction_closed" CHECK ((state = 'released') = (released_at IS NOT NULL AND released_by IS NOT NULL
          AND lines_counted IS NOT NULL AND line_statuses IS NOT NULL AND chart_from IS NOT NULL
          AND chart_to IS NOT NULL AND person_confirmed_by IS NOT NULL)
        AND (state = 'discarded') = (discarded_at IS NOT NULL AND discarded_by IS NOT NULL)
        AND (state IN ('blocked', 'failed')) = (failure IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ocr_field" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"extraction_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"line_group" integer NOT NULL,
	"label" text NOT NULL,
	"read_text" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"state" text DEFAULT 'unconfirmed' NOT NULL,
	"value" text,
	"decided_line_group" integer,
	"decided_label" text,
	"truncated" boolean DEFAULT false NOT NULL,
	"added_by_person" boolean DEFAULT false NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ocr_field_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "ocr_field_position_key" UNIQUE("tenant_id","extraction_id","position"),
	CONSTRAINT "ocr_field_label" CHECK (label IN ('medicine', 'strength', 'dose', 'route', 'directions', 'prescriber', 'text')),
	CONSTRAINT "ocr_field_state" CHECK (state IN ('unconfirmed', 'confirmed', 'corrected', 'rejected')),
	CONSTRAINT "ocr_field_confidence" CHECK (confidence >= 0 AND confidence <= 1),
	CONSTRAINT "ocr_field_text" CHECK (length(read_text) BETWEEN 1 AND 500),
	CONSTRAINT "ocr_field_decided" CHECK ((state = 'unconfirmed') = (decided_by IS NULL AND decided_at IS NULL)
        AND (state IN ('confirmed', 'corrected')) = (value IS NOT NULL)
        AND (state IN ('confirmed', 'corrected')) = (decided_line_group IS NOT NULL AND decided_label IS NOT NULL)
        AND (value IS NULL OR length(value) BETWEEN 1 AND 500)
        AND NOT (state = 'confirmed' AND truncated)
        AND (NOT added_by_person OR state = 'corrected')),
	CONSTRAINT "ocr_field_lines" CHECK (line_group BETWEEN 0 AND 199 AND (decided_line_group IS NULL OR decided_line_group BETWEEN 0 AND 199)),
	CONSTRAINT "ocr_field_decided_label" CHECK (decided_label IS NULL OR decided_label IN ('medicine', 'strength', 'dose', 'route', 'directions', 'prescriber', 'text'))
);
--> statement-breakpoint
CREATE TABLE "signature_request" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"document_id" uuid NOT NULL,
	"document_sha256" text NOT NULL,
	"signer_tenant_user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"envelope_id" text,
	"requested_by" uuid NOT NULL,
	"signature_id" uuid,
	"signed_document_id" uuid,
	"step_up_method" text,
	"signed_at" timestamp with time zone,
	"closed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "signature_request_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "signature_request_state" CHECK (state IN ('requested', 'sent', 'signed', 'declined', 'cancelled', 'failed')),
	CONSTRAINT "signature_request_provider" CHECK (provider IN ('in_app', 'docusign')),
	CONSTRAINT "signature_request_sha256" CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "signature_request_signed" CHECK ((state = 'signed') = (signed_at IS NOT NULL)
        AND (state <> 'signed' OR provider <> 'in_app' OR (signature_id IS NOT NULL AND step_up_method IS NOT NULL))
        AND (state <> 'signed' OR provider <> 'docusign' OR signed_document_id IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "document_signature" ADD CONSTRAINT "document_signature_tenant_document_id_key" UNIQUE("tenant_id","document_id","id");
ALTER TABLE "ocr_extraction" ADD CONSTRAINT "ocr_extraction_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_extraction" ADD CONSTRAINT "ocr_extraction_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_extraction" ADD CONSTRAINT "ocr_extraction_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_extraction" ADD CONSTRAINT "ocr_extraction_released_by_fk" FOREIGN KEY ("tenant_id","released_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_extraction" ADD CONSTRAINT "ocr_extraction_person_confirmed_by_fk" FOREIGN KEY ("tenant_id","person_confirmed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_extraction" ADD CONSTRAINT "ocr_extraction_discarded_by_fk" FOREIGN KEY ("tenant_id","discarded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_field" ADD CONSTRAINT "ocr_field_extraction_fk" FOREIGN KEY ("tenant_id","person_id","extraction_id") REFERENCES "public"."ocr_extraction"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_field" ADD CONSTRAINT "ocr_field_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_signature_fk" FOREIGN KEY ("tenant_id","document_id","signature_id") REFERENCES "public"."document_signature"("tenant_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_signed_document_fk" FOREIGN KEY ("tenant_id","signed_document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_signer_fk" FOREIGN KEY ("tenant_id","signer_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ocr_extraction_person_idx" ON "ocr_extraction" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE INDEX "ocr_field_extraction_idx" ON "ocr_field" USING btree ("tenant_id","extraction_id");--> statement-breakpoint
CREATE INDEX "signature_request_document_idx" ON "signature_request" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE INDEX "signature_request_signer_idx" ON "signature_request" USING btree ("tenant_id","signer_tenant_user_id","state");--> statement-breakpoint
--> statement-breakpoint
-- Slice 79 (INTG-013; ADR-0095; integrations.md section 11). What Drizzle cannot express: forced
-- row-level security; the person scope on OCR extractions and their fields (scanned MAR charts are
-- health data); record history for all three, with OCR history kept to the person's scope too;
-- grants (no DELETE); and the sample data removal list. Signature requests are about organisation
-- documents, visible across the organisation like the documents themselves. Permissions are the
-- API's to check (platform.document.manage, medicines.record.manage where it reaches the person).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['signature_request', 'ocr_extraction', 'ocr_field'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', t);
    EXECUTE format(
      'CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format(
      'CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO harbour_app', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON public.%I FROM harbour_app', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['ocr_extraction', 'ocr_field'] LOOP
    EXECUTE format(
      'CREATE POLICY person_child_scope ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner '
      'USING (app.person_visible(person_id)) WITH CHECK (app.person_visible(person_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- Earlier versions of OCR rows follow the person's scope, as the rows do.
CREATE POLICY record_version_ocr ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (table_name NOT IN ('ocr_extraction', 'ocr_field')
    OR app.person_visible((data ->> 'person_id')::uuid));
--> statement-breakpoint
-- A field's text as read and the engine that read it never change; only a person's decision does.
CREATE FUNCTION app.ocr_field_read_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.extraction_id IS DISTINCT FROM OLD.extraction_id
    OR NEW.person_id IS DISTINCT FROM OLD.person_id
    OR NEW.position IS DISTINCT FROM OLD.position
    OR NEW.line_group IS DISTINCT FROM OLD.line_group
    OR NEW.label IS DISTINCT FROM OLD.label
    OR NEW.read_text IS DISTINCT FROM OLD.read_text
    OR NEW.confidence IS DISTINCT FROM OLD.confidence
    OR NEW.truncated IS DISTINCT FROM OLD.truncated
    OR NEW.added_by_person IS DISTINCT FROM OLD.added_by_person THEN
    RAISE EXCEPTION 'The text as read cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state <> 'unconfirmed' THEN
    RAISE EXCEPTION 'A decided value cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER read_fixed BEFORE UPDATE ON public.ocr_field
  FOR EACH ROW EXECUTE FUNCTION app.ocr_field_read_fixed();
--> statement-breakpoint
-- A released or discarded extraction is finished; its person, image and engine never change.
CREATE FUNCTION app.ocr_extraction_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.person_id IS DISTINCT FROM OLD.person_id
    OR NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.engine IS DISTINCT FROM OLD.engine
    OR NEW.location IS DISTINCT FROM OLD.location
    OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'An extraction''s subject cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('released', 'discarded') THEN
    RAISE EXCEPTION 'A finished extraction cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER extraction_guard BEFORE UPDATE ON public.ocr_extraction
  FOR EACH ROW EXECUTE FUNCTION app.ocr_extraction_guard();
--> statement-breakpoint
-- A signed, declined, cancelled or failed request is finished; its document, hash and signer
-- never change.
CREATE FUNCTION app.signature_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.document_sha256 IS DISTINCT FROM OLD.document_sha256
    OR NEW.signer_tenant_user_id IS DISTINCT FROM OLD.signer_tenant_user_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'A signature request''s subject cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('signed', 'declined', 'cancelled', 'failed') THEN
    RAISE EXCEPTION 'A finished signature request cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER request_guard BEFORE UPDATE ON public.signature_request
  FOR EACH ROW EXECUTE FUNCTION app.signature_request_guard();
--> statement-breakpoint
-- Sample data (migration 0069): OCR rows about a removed sample person go with them, fields
-- before extractions, both before the document they read. Migration 0099's list, redefined whole
-- with these first (the highest migration holds the full list).
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
    'ocr_field', 'ocr_extraction',
    'death_step', 'missing_event', 'death_record', 'missing_episode', 'herbert_profile',
    'outbreak_case', 'dependency_assessment',
    'about_me', 'about_me_share_link', 'activity_record', 'admission_condition',
    'advance_care_record', 'allergy', 'assessment', 'bed_occupancy', 'body_map_mark',
    'break_glass_event', 'candour_record', 'care_note', 'care_plan_action', 'care_plan_change',
    'consent_record', 'document_signature', 'dols_legal_change_review',
    'entry_device_deletion_flag', 'exit_checklist_item', 'family_portal_user',
    'feed_item_withdrawal', 'feed_view', 'handover_note', 'incident_person', 'key_issue',
    'legal_hold', 'letter', 'notification_delivery', 'observation', 'person_assignment',
    'person_care_profile', 'property_item', 'refused_entry', 'sharing_decision_suspension',
    'safeguarding_concern', 'statutory_notification', 'visit_log', 'welcome_checklist_item', 'workflow_transition',
    'care_plan_section', 'dols_authorisation', 'exit_record', 'feed_item', 'handover_item',
    'hospital_transfer', 'notification', 'placement', 'review_record', 'risk_assessment',
    'sharing_decision', 'task', 'admission_decision', 'best_interests_decision', 'care_plan',
    'document', 'task_series', 'workflow_instance', 'capacity_assessment', 'contact',
    'pre_admission_assessment'
  ]::text[]
$$;
--> statement-breakpoint
GRANT SELECT, DELETE ON public.ocr_field, public.ocr_extraction TO harbour_sample_owner;
