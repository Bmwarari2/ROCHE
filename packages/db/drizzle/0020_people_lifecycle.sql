ALTER TYPE "public"."person_status" ADD VALUE 'pre_admission' BEFORE 'active';--> statement-breakpoint
ALTER TYPE "public"."person_status" ADD VALUE 'not_admitted';--> statement-breakpoint
CREATE TABLE "about_me_share_link" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"sharing_decision_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"last_opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "about_me_share_link_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "about_me_share_link_token_hash" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "about_me_share_link_revoked" CHECK (revoked_at IS NULL OR revoked_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "admission_condition" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"condition" text NOT NULL,
	"met_by" uuid,
	"met_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "admission_condition_position_key" UNIQUE("tenant_id","decision_id","position"),
	CONSTRAINT "admission_condition_text" CHECK (length(trim(condition)) > 0),
	CONSTRAINT "admission_condition_met" CHECK ((met_by IS NULL) = (met_at IS NULL)),
	CONSTRAINT "admission_condition_position" CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE "admission_decision" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"can_meet_needs" text NOT NULL,
	"reasons" text NOT NULL,
	"planned_admission_on" date,
	"trial_ends_on" date,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"told_who" text,
	"told_at" timestamp with time zone,
	"supersedes_id" uuid,
	"correction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "admission_decision_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "admission_decision_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "admission_decision_can_meet_needs" CHECK (can_meet_needs IN ('yes', 'yes_with_conditions', 'no')),
	CONSTRAINT "admission_decision_reasons" CHECK (length(trim(reasons)) > 0),
	CONSTRAINT "admission_decision_trial" CHECK (trial_ends_on IS NULL OR planned_admission_on IS NULL OR trial_ends_on > planned_admission_on),
	CONSTRAINT "admission_decision_told" CHECK ((told_who IS NULL) = (told_at IS NULL)),
	CONSTRAINT "admission_decision_correction_reason" CHECK (supersedes_id IS NULL OR correction_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "bed_occupancy" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"bed" integer DEFAULT 1 NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date,
	"reason" text NOT NULL,
	"backdated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "bed_occupancy_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "bed_occupancy_bed" CHECK (bed >= 1),
	CONSTRAINT "bed_occupancy_range" CHECK (to_date IS NULL OR to_date > from_date),
	CONSTRAINT "bed_occupancy_reason" CHECK (length(trim(reason)) > 0)
);
--> statement-breakpoint
CREATE TABLE "break_glass_weekly_report" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"week_start" timestamp with time zone NOT NULL,
	"week_end" timestamp with time zone NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"repeat_threshold" integer NOT NULL,
	"summary" jsonb NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"actions_taken" text,
	"supersedes_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "break_glass_weekly_report_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "break_glass_weekly_report_week" CHECK (week_end > week_start),
	CONSTRAINT "break_glass_weekly_report_threshold" CHECK (repeat_threshold >= 2),
	CONSTRAINT "break_glass_weekly_report_summary" CHECK (jsonb_typeof(summary) = 'object'),
	CONSTRAINT "break_glass_weekly_report_review" CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)
        AND (supersedes_id IS NULL) = (reviewed_by IS NULL))
);
--> statement-breakpoint
CREATE TABLE "care_plan_change" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"occurred_on" date NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"reviewed_on" date,
	"review_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "care_plan_change_kind" CHECK (kind IN ('return_from_hospital', 'fall', 'change_in_needs', 'new_diagnosis', 'safeguarding', 'end_of_life', 'other')),
	CONSTRAINT "care_plan_change_source" CHECK ((source_type IS NULL) = (source_id IS NULL) AND (source_type IS NULL
        OR source_type IN ('incident', 'hospital_transfer', 'care_note', 'assessment', 'other'))),
	CONSTRAINT "care_plan_change_reviewed" CHECK (review_record_id IS NULL OR reviewed_on IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "exit_checklist_item" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"exit_record_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"title" text NOT NULL,
	"owner" text NOT NULL,
	"return_item" boolean DEFAULT false NOT NULL,
	"allow_not_required" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"done_by" uuid,
	"done_at" timestamp with time zone,
	"evidence_type" text,
	"evidence_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "exit_checklist_item_key" UNIQUE("tenant_id","exit_record_id","item_key"),
	CONSTRAINT "exit_checklist_item_owner" CHECK (owner IN ('people', 'care', 'medicines', 'safety', 'finance')),
	CONSTRAINT "exit_checklist_item_status" CHECK (status IN ('pending', 'done', 'not_required')),
	CONSTRAINT "exit_checklist_item_done" CHECK (status = 'pending' OR (done_by IS NOT NULL AND done_at IS NOT NULL)),
	CONSTRAINT "exit_checklist_item_not_required" CHECK (status <> 'not_required' OR (allow_not_required AND reason IS NOT NULL)),
	CONSTRAINT "exit_checklist_item_evidence" CHECK ((evidence_type IS NULL) = (evidence_id IS NULL) AND (evidence_type IS NULL
        OR evidence_type IN ('statutory_notification', 'document', 'ledger_entry', 'note')))
);
--> statement-breakpoint
CREATE TABLE "exit_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"workflow_instance_id" uuid,
	"left_at" timestamp with time zone,
	"regulator" text NOT NULL,
	"local_authority_funded" boolean DEFAULT false NOT NULL,
	"nhs_funded" boolean DEFAULT false NOT NULL,
	"place_of_death" text,
	"death_expected" boolean,
	"learning_disability_or_autism" boolean DEFAULT false NOT NULL,
	"dols_in_place" boolean DEFAULT false NOT NULL,
	"home_is_dwp_appointee" boolean DEFAULT false NOT NULL,
	"holds_residents_money" boolean DEFAULT false NOT NULL,
	"holds_deposit" boolean DEFAULT false NOT NULL,
	"has_loan_equipment" boolean DEFAULT false NOT NULL,
	"destination_type" text,
	"receiving_provider_name" text,
	"receiving_provider_cqc_location_id" text,
	"receiving_provider_ods_code" text,
	"reason" text,
	"verified_by_name" text,
	"verified_by_role" text,
	"verified_at" timestamp with time zone,
	"present_at_death" text,
	"funeral_director" text,
	"collection_at" timestamp with time zone,
	"coroner_referred_by" text,
	"coroner_reference" text,
	"money_and_property_due_at" timestamp with time zone,
	"deposit_due_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "exit_record_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "exit_record_kind" CHECK (kind IN ('discharge', 'transfer', 'death')),
	CONSTRAINT "exit_record_state" CHECK (state IN ('planned', 'left', 'recorded', 'awaiting_return', 'closed', 'cancelled') AND CASE WHEN kind = 'death'
        THEN state NOT IN ('planned', 'left') ELSE state <> 'recorded' END),
	CONSTRAINT "exit_record_regulator" CHECK (regulator IN ('cqc', 'ciw', 'care_inspectorate', 'rqia')),
	CONSTRAINT "exit_record_death" CHECK (CASE WHEN kind = 'death'
        THEN place_of_death IN ('care_home', 'hospital', 'elsewhere') AND left_at IS NOT NULL
        ELSE place_of_death IS NULL AND death_expected IS NULL END),
	CONSTRAINT "exit_record_destination" CHECK (destination_type IS NULL OR destination_type IN ('own_home', 'family_home', 'care_home',
        'hospital', 'hospice', 'supported_living', 'other')),
	CONSTRAINT "exit_record_left" CHECK (state IN ('planned', 'cancelled') OR left_at IS NOT NULL),
	CONSTRAINT "exit_record_cancelled" CHECK (state <> 'cancelled' OR cancelled_reason IS NOT NULL),
	CONSTRAINT "exit_record_closed" CHECK (state <> 'closed' OR closed_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "hospital_transfer" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"left_at" timestamp with time zone NOT NULL,
	"hospital_name" text NOT NULL,
	"hospital_ods_code" text,
	"reason" text,
	"pack" jsonb NOT NULL,
	"missing_critical" text[] DEFAULT '{}'::text[] NOT NULL,
	"missing_expected" text[] DEFAULT '{}'::text[] NOT NULL,
	"items_sent" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"handed_over_at" timestamp with time zone,
	"handed_over_by" uuid,
	"ack_by" uuid,
	"ack_at" timestamp with time zone,
	"ack_reason" text,
	"returned_at" timestamp with time zone,
	"return_checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hospital_transfer_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "hospital_transfer_hospital" CHECK (length(trim(hospital_name)) > 0),
	CONSTRAINT "hospital_transfer_returned" CHECK (returned_at IS NULL OR returned_at >= left_at),
	CONSTRAINT "hospital_transfer_handed_over" CHECK ((handed_over_at IS NULL) = (handed_over_by IS NULL)),
	CONSTRAINT "hospital_transfer_acknowledgement" CHECK ((ack_by IS NULL) = (ack_at IS NULL) AND (ack_by IS NULL) = (ack_reason IS NULL)),
	CONSTRAINT "hospital_transfer_pack" CHECK (jsonb_typeof(pack) = 'object'),
	CONSTRAINT "hospital_transfer_return_checks" CHECK (jsonb_typeof(return_checks) = 'object')
);
--> statement-breakpoint
CREATE TABLE "key_issue" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"label" text NOT NULL,
	"issued_on" date NOT NULL,
	"issued_to" text NOT NULL,
	"returned_on" date,
	"reported_lost_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "key_issue_issued_to" CHECK (issued_to IN ('person', 'representative')),
	CONSTRAINT "key_issue_label" CHECK (length(trim(label)) > 0),
	CONSTRAINT "key_issue_returned" CHECK (returned_on IS NULL OR returned_on >= issued_on),
	CONSTRAINT "key_issue_lost" CHECK (reported_lost_on IS NULL OR reported_lost_on >= issued_on),
	CONSTRAINT "key_issue_once" CHECK (returned_on IS NULL OR reported_lost_on IS NULL)
);
--> statement-breakpoint
CREATE TABLE "pre_admission_assessment" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"service_id" uuid,
	"placement_type_sought" "placement_type",
	"status" text DEFAULT 'in_progress' NOT NULL,
	"sections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"information_sources" text[] DEFAULT '{}'::text[] NOT NULL,
	"person_involved" boolean,
	"involvement_reason" text,
	"assessor_tenant_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "pre_admission_assessment_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pre_admission_assessment_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "pre_admission_assessment_status" CHECK (status IN ('in_progress', 'complete', 'decided')),
	CONSTRAINT "pre_admission_assessment_sections" CHECK (jsonb_typeof(sections) = 'object'),
	CONSTRAINT "pre_admission_assessment_sources" CHECK (information_sources <@ ARRAY['person', 'family_or_representative', 'hospital', 'gp', 'social_worker', 'previous_provider', 'other']::text[]),
	CONSTRAINT "pre_admission_assessment_involvement" CHECK (person_involved IS NOT FALSE OR involvement_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "property_item" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"valuable" boolean DEFAULT false NOT NULL,
	"photo_document_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"received_on" date NOT NULL,
	"recorded_by" uuid NOT NULL,
	"ack_signer" text NOT NULL,
	"ack_name" text,
	"ack_unable_reason" text,
	"ack_signed_at" timestamp with time zone NOT NULL,
	"witnessed_by" uuid,
	"status" text DEFAULT 'held' NOT NULL,
	"hospital_transfer_id" uuid,
	"returned_on" date,
	"return_recipient_name" text,
	"return_recipient_capacity" text,
	"return_signer" text,
	"return_signer_name" text,
	"return_unable_reason" text,
	"return_signed_at" timestamp with time zone,
	"returned_by" uuid,
	"return_witnessed_by" uuid,
	"disposed_on" date,
	"disposal_reason" text,
	"disposed_by" uuid,
	"disposal_witnessed_by" uuid,
	"lost_on" date,
	"loss_incident_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "property_item_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "property_item_category" CHECK (category IN ('clothing', 'jewellery', 'watch', 'electronics', 'mobility_aid', 'sensory_aid', 'dentures', 'documents', 'furniture', 'ornament_or_picture', 'toiletries', 'other')),
	CONSTRAINT "property_item_quantity" CHECK (quantity >= 1),
	CONSTRAINT "property_item_status" CHECK (status IN ('held', 'sent_with_person', 'returned', 'disposed', 'lost')),
	CONSTRAINT "property_item_description" CHECK (length(trim(description)) > 0),
	CONSTRAINT "property_item_acknowledgement" CHECK (ack_signer IN ('person', 'representative', 'unable_to_sign') AND CASE WHEN ack_signer = 'unable_to_sign'
        THEN ack_unable_reason IS NOT NULL ELSE ack_name IS NOT NULL END),
	CONSTRAINT "property_item_witness" CHECK (witnessed_by IS NULL OR witnessed_by <> recorded_by),
	CONSTRAINT "property_item_returned" CHECK (status <> 'returned' OR (returned_on IS NOT NULL AND return_recipient_name IS NOT NULL
        AND return_recipient_capacity IN ('person', 'representative', 'personal_representative', 'receiving_provider') AND returned_by IS NOT NULL
        AND return_signer IN ('person', 'representative', 'unable_to_sign'))),
	CONSTRAINT "property_item_disposed" CHECK (status <> 'disposed' OR (disposed_on IS NOT NULL AND disposal_reason IS NOT NULL
        AND disposed_by IS NOT NULL AND disposal_witnessed_by IS NOT NULL
        AND disposal_witnessed_by <> disposed_by)),
	CONSTRAINT "property_item_lost" CHECK (status <> 'lost' OR (lost_on IS NOT NULL AND loss_incident_id IS NOT NULL)),
	CONSTRAINT "property_item_away" CHECK ((status = 'sent_with_person') = (hospital_transfer_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "review_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"held_on" date NOT NULL,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"family_involvement_kind" text,
	"la_reference" text,
	"changes_covered" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"outcome" text,
	"document_id" uuid,
	"supersedes_id" uuid,
	"correction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "review_record_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "review_record_kind" CHECK (kind IN ('care_plan', 'la_review', 'family_involvement', 'trial_review')),
	CONSTRAINT "review_record_family" CHECK ((kind = 'family_involvement') = (family_involvement_kind IS NOT NULL)
        AND (family_involvement_kind IS NULL OR family_involvement_kind IN ('attended_review', 'contributed', 'invited_declined', 'person_declines_involvement', 'no_family_or_representative'))),
	CONSTRAINT "review_record_participants" CHECK (jsonb_typeof(participants) = 'array'),
	CONSTRAINT "review_record_correction_reason" CHECK (supersedes_id IS NULL OR correction_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "sharing_decision" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"recipient_kind" text NOT NULL,
	"recipient_contact_id" uuid,
	"recipient_tenant_user_id" uuid,
	"sections" text[] NOT NULL,
	"care_plan_domains" text[],
	"basis" text NOT NULL,
	"consent_given_by" text,
	"capacity" text DEFAULT 'presumed' NOT NULL,
	"capacity_assessment_id" uuid,
	"best_interests_decision_id" uuid,
	"authority_role" text,
	"authority_contact_id" uuid,
	"authority_reference" text,
	"authority_evidence_document_id" uuid,
	"authority_valid_until" date,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	"suspended_at" timestamp with time zone,
	"suspended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sharing_decision_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "sharing_decision_recipient" CHECK (CASE recipient_kind
        WHEN 'family' THEN recipient_contact_id IS NOT NULL AND recipient_tenant_user_id IS NULL
        WHEN 'professional' THEN recipient_tenant_user_id IS NOT NULL AND recipient_contact_id IS NULL
        WHEN 'link' THEN recipient_contact_id IS NULL AND recipient_tenant_user_id IS NULL
        ELSE false END),
	CONSTRAINT "sharing_decision_sections" CHECK (cardinality(sections) > 0 AND sections <@ ARRAY['about_me', 'daily_updates', 'photos', 'activities_and_visits', 'care_plan', 'health_summary', 'medicines', 'appointments', 'finance', 'documents']::text[]),
	CONSTRAINT "sharing_decision_basis" CHECK (basis IN ('consent', 'legal_authority', 'best_interests', 'direct_care')),
	CONSTRAINT "sharing_decision_capacity_value" CHECK (capacity IN ('presumed', 'assessed_has_capacity', 'assessed_lacks_capacity')),
	CONSTRAINT "sharing_decision_consent_given_by" CHECK (consent_given_by IS NULL OR consent_given_by IN ('person', 'authority_holder')),
	CONSTRAINT "sharing_decision_authority_role" CHECK (authority_role IS NULL OR authority_role IN ('lpa_health_welfare', 'lpa_property_finance', 'deputy_personal_welfare', 'deputy_property_affairs', 'appointee')),
	CONSTRAINT "sharing_decision_period" CHECK (valid_to > valid_from),
	CONSTRAINT "sharing_decision_withdrawn" CHECK (withdrawn_at IS NULL OR withdrawn_reason IS NOT NULL),
	CONSTRAINT "sharing_decision_suspended" CHECK (suspended_at IS NULL OR suspended_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "welcome_checklist_item" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"placement_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"title" text NOT NULL,
	"required" boolean NOT NULL,
	"safety_critical" boolean NOT NULL,
	"allow_not_applicable" boolean NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"done_by" uuid,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "welcome_checklist_item_key" UNIQUE("tenant_id","placement_id","item_key"),
	CONSTRAINT "welcome_checklist_item_status" CHECK (status IN ('pending', 'done', 'not_applicable')),
	CONSTRAINT "welcome_checklist_item_done" CHECK (status = 'pending' OR (done_by IS NOT NULL AND done_at IS NOT NULL)),
	CONSTRAINT "welcome_checklist_item_not_applicable" CHECK (status <> 'not_applicable' OR (allow_not_applicable AND reason IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "welcome_checklist_template" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "welcome_checklist_template_items" CHECK (jsonb_typeof(items) = 'array')
);
--> statement-breakpoint
ALTER TABLE "activity_record" ADD COLUMN "recorded_after_exit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment" ADD COLUMN "recorded_after_exit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "recorded_after_exit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "care_note" ADD COLUMN "recorded_after_exit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "recorded_after_exit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "visit_log" ADD COLUMN "recorded_after_exit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "break_glass_event" ADD COLUMN "reason_code" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "authority_scope" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "communication_needs_status" text DEFAULT 'not_recorded' NOT NULL;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "communication_needs_confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "communication_needs_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "placement" ADD COLUMN "trial_ends_on" date;--> statement-breakpoint
ALTER TABLE "placement" ADD COLUMN "trial_reviewed_on" date;--> statement-breakpoint
ALTER TABLE "placement" ADD COLUMN "local_authority_funded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "placement" ADD COLUMN "nhs_funded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "placement" ADD COLUMN "admission_decision_id" uuid;--> statement-breakpoint
-- The composite key the welcome checklist references must exist before its foreign key.
ALTER TABLE "placement" ADD CONSTRAINT "placement_tenant_person_id_key" UNIQUE("tenant_id","person_id","id");--> statement-breakpoint
ALTER TABLE "about_me_share_link" ADD CONSTRAINT "about_me_share_link_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "about_me_share_link" ADD CONSTRAINT "about_me_share_link_decision_fk" FOREIGN KEY ("tenant_id","person_id","sharing_decision_id") REFERENCES "public"."sharing_decision"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admission_condition" ADD CONSTRAINT "admission_condition_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admission_condition" ADD CONSTRAINT "admission_condition_decision_fk" FOREIGN KEY ("tenant_id","person_id","decision_id") REFERENCES "public"."admission_decision"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admission_condition" ADD CONSTRAINT "admission_condition_met_by_fk" FOREIGN KEY ("tenant_id","met_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admission_decision" ADD CONSTRAINT "admission_decision_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admission_decision" ADD CONSTRAINT "admission_decision_assessment_fk" FOREIGN KEY ("tenant_id","person_id","assessment_id") REFERENCES "public"."pre_admission_assessment"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admission_decision" ADD CONSTRAINT "admission_decision_supersedes_fk" FOREIGN KEY ("tenant_id","person_id","supersedes_id") REFERENCES "public"."admission_decision"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admission_decision" ADD CONSTRAINT "admission_decision_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_occupancy" ADD CONSTRAINT "bed_occupancy_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_occupancy" ADD CONSTRAINT "bed_occupancy_room_fk" FOREIGN KEY ("tenant_id","room_id") REFERENCES "public"."room"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_weekly_report" ADD CONSTRAINT "break_glass_weekly_report_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_weekly_report" ADD CONSTRAINT "break_glass_weekly_report_supersedes_fk" FOREIGN KEY ("tenant_id","supersedes_id") REFERENCES "public"."break_glass_weekly_report"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_weekly_report" ADD CONSTRAINT "break_glass_weekly_report_reviewed_by_fk" FOREIGN KEY ("tenant_id","reviewed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_change" ADD CONSTRAINT "care_plan_change_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_change" ADD CONSTRAINT "care_plan_change_review_fk" FOREIGN KEY ("tenant_id","person_id","review_record_id") REFERENCES "public"."review_record"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_checklist_item" ADD CONSTRAINT "exit_checklist_item_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_checklist_item" ADD CONSTRAINT "exit_checklist_item_exit_fk" FOREIGN KEY ("tenant_id","person_id","exit_record_id") REFERENCES "public"."exit_record"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_checklist_item" ADD CONSTRAINT "exit_checklist_item_done_by_fk" FOREIGN KEY ("tenant_id","done_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_record" ADD CONSTRAINT "exit_record_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_record" ADD CONSTRAINT "exit_record_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_record" ADD CONSTRAINT "exit_record_workflow_fk" FOREIGN KEY ("tenant_id","workflow_instance_id") REFERENCES "public"."workflow_instance"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hospital_transfer" ADD CONSTRAINT "hospital_transfer_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hospital_transfer" ADD CONSTRAINT "hospital_transfer_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hospital_transfer" ADD CONSTRAINT "hospital_transfer_handed_over_by_fk" FOREIGN KEY ("tenant_id","handed_over_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hospital_transfer" ADD CONSTRAINT "hospital_transfer_ack_by_fk" FOREIGN KEY ("tenant_id","ack_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_issue" ADD CONSTRAINT "key_issue_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_admission_assessment" ADD CONSTRAINT "pre_admission_assessment_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_admission_assessment" ADD CONSTRAINT "pre_admission_assessment_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."service"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_admission_assessment" ADD CONSTRAINT "pre_admission_assessment_assessor_fk" FOREIGN KEY ("tenant_id","assessor_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_item" ADD CONSTRAINT "property_item_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_item" ADD CONSTRAINT "property_item_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_item" ADD CONSTRAINT "property_item_witnessed_by_fk" FOREIGN KEY ("tenant_id","witnessed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_item" ADD CONSTRAINT "property_item_returned_by_fk" FOREIGN KEY ("tenant_id","returned_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_item" ADD CONSTRAINT "property_item_return_witness_fk" FOREIGN KEY ("tenant_id","return_witnessed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_item" ADD CONSTRAINT "property_item_disposed_by_fk" FOREIGN KEY ("tenant_id","disposed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_item" ADD CONSTRAINT "property_item_disposal_witness_fk" FOREIGN KEY ("tenant_id","disposal_witnessed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_item" ADD CONSTRAINT "property_item_loss_incident_fk" FOREIGN KEY ("tenant_id","loss_incident_id") REFERENCES "public"."incident"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_item" ADD CONSTRAINT "property_item_hospital_transfer_fk" FOREIGN KEY ("tenant_id","person_id","hospital_transfer_id") REFERENCES "public"."hospital_transfer"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_record" ADD CONSTRAINT "review_record_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_record" ADD CONSTRAINT "review_record_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_record" ADD CONSTRAINT "review_record_supersedes_fk" FOREIGN KEY ("tenant_id","person_id","supersedes_id") REFERENCES "public"."review_record"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharing_decision" ADD CONSTRAINT "sharing_decision_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharing_decision" ADD CONSTRAINT "sharing_decision_recipient_contact_fk" FOREIGN KEY ("tenant_id","person_id","recipient_contact_id") REFERENCES "public"."contact"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharing_decision" ADD CONSTRAINT "sharing_decision_recipient_user_fk" FOREIGN KEY ("tenant_id","recipient_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharing_decision" ADD CONSTRAINT "sharing_decision_authority_contact_fk" FOREIGN KEY ("tenant_id","person_id","authority_contact_id") REFERENCES "public"."contact"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharing_decision" ADD CONSTRAINT "sharing_decision_capacity_fk" FOREIGN KEY ("tenant_id","person_id","capacity_assessment_id") REFERENCES "public"."capacity_assessment"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharing_decision" ADD CONSTRAINT "sharing_decision_best_interests_fk" FOREIGN KEY ("tenant_id","person_id","best_interests_decision_id") REFERENCES "public"."best_interests_decision"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharing_decision" ADD CONSTRAINT "sharing_decision_evidence_fk" FOREIGN KEY ("tenant_id","authority_evidence_document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "welcome_checklist_item" ADD CONSTRAINT "welcome_checklist_item_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "welcome_checklist_item" ADD CONSTRAINT "welcome_checklist_item_placement_fk" FOREIGN KEY ("tenant_id","person_id","placement_id") REFERENCES "public"."placement"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "welcome_checklist_item" ADD CONSTRAINT "welcome_checklist_item_done_by_fk" FOREIGN KEY ("tenant_id","done_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "about_me_share_link_person_idx" ON "about_me_share_link" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admission_decision_superseded_once" ON "admission_decision" USING btree ("tenant_id","supersedes_id") WHERE supersedes_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "admission_decision_person_idx" ON "admission_decision" USING btree ("tenant_id","person_id","decided_at");--> statement-breakpoint
CREATE INDEX "bed_occupancy_room_idx" ON "bed_occupancy" USING btree ("tenant_id","room_id","from_date");--> statement-breakpoint
CREATE INDEX "bed_occupancy_person_idx" ON "bed_occupancy" USING btree ("tenant_id","person_id","from_date");--> statement-breakpoint
CREATE UNIQUE INDEX "break_glass_weekly_report_once" ON "break_glass_weekly_report" USING btree ("tenant_id","location_id","week_start") WHERE supersedes_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "break_glass_weekly_report_reviewed_once" ON "break_glass_weekly_report" USING btree ("tenant_id","supersedes_id") WHERE supersedes_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "care_plan_change_source_once" ON "care_plan_change" USING btree ("tenant_id","source_type","source_id","kind") WHERE source_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "care_plan_change_person_idx" ON "care_plan_change" USING btree ("tenant_id","person_id","occurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "exit_record_one_open" ON "exit_record" USING btree ("tenant_id","person_id") WHERE state NOT IN ('closed', 'cancelled') AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "exit_record_person_idx" ON "exit_record" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hospital_transfer_one_open" ON "hospital_transfer" USING btree ("tenant_id","person_id") WHERE returned_at IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "key_issue_person_idx" ON "key_issue" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pre_admission_assessment_one_open" ON "pre_admission_assessment" USING btree ("tenant_id","person_id") WHERE status <> 'decided' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "property_item_person_idx" ON "property_item" USING btree ("tenant_id","person_id","status");--> statement-breakpoint
CREATE INDEX "review_record_person_idx" ON "review_record" USING btree ("tenant_id","person_id","kind","held_on");--> statement-breakpoint
CREATE INDEX "sharing_decision_person_idx" ON "sharing_decision" USING btree ("tenant_id","person_id","valid_to");--> statement-breakpoint
CREATE UNIQUE INDEX "welcome_checklist_template_one_per_tenant" ON "welcome_checklist_template" USING btree ("tenant_id") WHERE deleted_at IS NULL;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_communication_confirmed_by_fk" FOREIGN KEY ("tenant_id","communication_needs_confirmed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_admission_decision_fk" FOREIGN KEY ("tenant_id","person_id","admission_decision_id") REFERENCES "public"."admission_decision"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_event" ADD CONSTRAINT "break_glass_reason_code" CHECK (reason_code IS NULL OR reason_code IN ('emergency_care', 'covering_another_area', 'safeguarding', 'incident_or_complaint', 'request_from_professional', 'other'));--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_authority_scope" CHECK (authority_scope IS NULL OR authority_scope IN ('personal_welfare', 'property_affairs', 'both'));--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_communication_needs_status" CHECK (communication_needs_status IN ('not_recorded', 'none_identified', 'recorded'));--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_communication_none_identified" CHECK (communication_needs_status <> 'none_identified' OR (communication_needs = '[]'::jsonb
        AND communication_needs_confirmed_by IS NOT NULL AND communication_needs_confirmed_at IS NOT NULL));--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_trial_end" CHECK (trial_ends_on IS NULL OR trial_ends_on > start_date);--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_status" CHECK (status IN ('available', 'out_of_service', 'awaiting_clearance'));--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_beds" CHECK (beds >= 1);