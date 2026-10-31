CREATE TABLE "safeguarding_concern" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"incident_id" uuid,
	"notification_id" uuid,
	"decision_guide_task_id" uuid,
	"abuse_types" text[] NOT NULL,
	"description" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"raised_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"referral_due_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'concern' NOT NULL,
	"no_referral_reason" text,
	"no_referral_decided_by" uuid,
	"referral_local_authority" text,
	"referral_method" text,
	"referred_at" timestamp with time zone,
	"referral_reference" text,
	"enquiry_kind" text,
	"enquiry_opened_at" timestamp with time zone,
	"finding" text,
	"finding_recorded_at" timestamp with time zone,
	"msp_asked" boolean,
	"msp_not_asked_reason" text,
	"msp_desired_outcomes" text,
	"msp_achieved" text,
	"staff_removed_for_harm" boolean DEFAULT false NOT NULL,
	"dbs_decision" text,
	"dbs_reason" text,
	"dbs_decided_at" timestamp with time zone,
	"protective_measures" text,
	"protective_measures_updated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_reason" text,
	"overdue_notified_at" timestamp with time zone,
	"retention_class" text DEFAULT 'serious_incident' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "safeguarding_concern_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "safeguarding_concern_notification_key" UNIQUE("tenant_id","notification_id"),
	CONSTRAINT "safeguarding_concern_abuse_types" CHECK (cardinality(abuse_types) > 0 AND abuse_types <@ ARRAY['physical', 'domestic', 'sexual', 'psychological', 'financial_or_material', 'modern_slavery', 'discriminatory', 'organisational', 'neglect', 'self_neglect']::text[]),
	CONSTRAINT "safeguarding_concern_state" CHECK (state IN ('concern', 'no_referral', 'referred', 'enquiry', 'outcome', 'closed')),
	CONSTRAINT "safeguarding_concern_no_referral" CHECK (state <> 'no_referral' OR (no_referral_reason IS NOT NULL AND no_referral_decided_by IS NOT NULL)),
	CONSTRAINT "safeguarding_concern_referral" CHECK (state NOT IN ('referred', 'enquiry') OR (referred_at IS NOT NULL AND referral_local_authority IS NOT NULL)),
	CONSTRAINT "safeguarding_concern_referral_method" CHECK (referral_method IS NULL OR referral_method IN ('phone', 'online_form', 'email', 'in_person')),
	CONSTRAINT "safeguarding_concern_enquiry_kind" CHECK (enquiry_kind IS NULL OR enquiry_kind IN ('s42_local_authority', 's42_caused_to_provider')),
	CONSTRAINT "safeguarding_concern_enquiry" CHECK (state <> 'enquiry' OR (enquiry_kind IS NOT NULL AND enquiry_opened_at IS NOT NULL)),
	CONSTRAINT "safeguarding_concern_finding" CHECK (finding IS NULL OR finding IN ('substantiated', 'partly_substantiated', 'not_substantiated', 'inconclusive', 'no_s42_enquiry')),
	CONSTRAINT "safeguarding_concern_outcome" CHECK (state NOT IN ('outcome', 'closed') OR finding IS NOT NULL),
	CONSTRAINT "safeguarding_concern_msp_achieved" CHECK (msp_achieved IS NULL OR msp_achieved IN ('fully', 'partly', 'not')),
	CONSTRAINT "safeguarding_concern_dbs_decision" CHECK (dbs_decision IS NULL OR dbs_decision IN ('referred', 'not_required')),
	CONSTRAINT "safeguarding_concern_dbs" CHECK ((dbs_decision IS NULL) = (dbs_decided_at IS NULL)
        AND (dbs_decision IS DISTINCT FROM 'not_required' OR dbs_reason IS NOT NULL)),
	CONSTRAINT "safeguarding_concern_dbs_before_end" CHECK (state NOT IN ('no_referral', 'closed') OR NOT staff_removed_for_harm OR dbs_decision IS NOT NULL),
	CONSTRAINT "safeguarding_concern_closed" CHECK ((state = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL AND closed_reason IS NOT NULL)),
	CONSTRAINT "safeguarding_concern_msp_before_close" CHECK (state <> 'closed' OR (msp_asked IS NOT NULL
        AND (msp_asked OR msp_not_asked_reason IS NOT NULL)
        AND (NOT msp_asked OR (msp_desired_outcomes IS NOT NULL AND msp_achieved IS NOT NULL)))),
	CONSTRAINT "safeguarding_concern_measures" CHECK ((protective_measures IS NULL) = (protective_measures_updated_at IS NULL)),
	CONSTRAINT "safeguarding_concern_due" CHECK (referral_due_at >= raised_at),
	CONSTRAINT "safeguarding_concern_retention_class" CHECK (retention_class IN ('serious_incident'))
);
--> statement-breakpoint
ALTER TABLE "safeguarding_concern" ADD CONSTRAINT "safeguarding_concern_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_concern" ADD CONSTRAINT "safeguarding_concern_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_concern" ADD CONSTRAINT "safeguarding_concern_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incident"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_concern" ADD CONSTRAINT "safeguarding_concern_notification_fk" FOREIGN KEY ("tenant_id","notification_id") REFERENCES "public"."statutory_notification"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_concern" ADD CONSTRAINT "safeguarding_concern_decision_guide_fk" FOREIGN KEY ("tenant_id","decision_guide_task_id") REFERENCES "public"."task"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_concern" ADD CONSTRAINT "safeguarding_concern_raised_by_fk" FOREIGN KEY ("tenant_id","raised_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_concern" ADD CONSTRAINT "safeguarding_concern_no_referral_by_fk" FOREIGN KEY ("tenant_id","no_referral_decided_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_concern" ADD CONSTRAINT "safeguarding_concern_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "safeguarding_concern_person_idx" ON "safeguarding_concern" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE INDEX "safeguarding_concern_clock_idx" ON "safeguarding_concern" USING btree ("tenant_id","state","referral_due_at");--> statement-breakpoint
CREATE INDEX "safeguarding_concern_location_idx" ON "safeguarding_concern" USING btree ("tenant_id","location_id","raised_at");--> statement-breakpoint

-- Security (ADR-0002, the pattern since migration 0054: one self-contained file). Runs as
-- harbour_owner.
ALTER TABLE public.safeguarding_concern ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.safeguarding_concern FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.safeguarding_concern AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());--> statement-breakpoint

-- Scope as incidents (ADR-0033): tenant-wide roles, the member of staff who raised the concern,
-- and anyone who can see the person it is about. app.incident_in_scope runs with the caller's
-- rights, so it can never widen access. The API decides what each reader sees (safety.md).
CREATE POLICY safeguarding_scope ON public.safeguarding_concern AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.incident_in_scope(location_id, raised_by, ARRAY[person_id]))
  WITH CHECK (app.incident_in_scope(location_id, raised_by, ARRAY[person_id]));--> statement-breakpoint

-- A mutable aggregate: version bump on every change and a record_version row (history view).
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.safeguarding_concern
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.safeguarding_concern
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();--> statement-breakpoint

-- No DELETE for the application: a concern is closed, never removed (retention decides its end;
-- only sample data removal, below, deletes, and only for invented people).
GRANT SELECT, INSERT, UPDATE ON public.safeguarding_concern TO harbour_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.safeguarding_concern FROM harbour_app;
-- The safeguarding log stays on the server: it is not published to devices.
--> statement-breakpoint

-- Sample data mode (migration 0069, HZ-072): a concern about a sample person goes with it. The one
-- list is redefined with the new table before its parents (statutory_notification, task), and
-- harbour_sample_owner may delete from it, as from every table on the list.
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
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
$$;--> statement-breakpoint
GRANT SELECT, DELETE ON public.safeguarding_concern TO harbour_sample_owner;
