-- Consent, capacity, best interests and the DoLS register (slice 6), and incidents, statutory
-- notifications, duty of candour and investigations (slice 7). Row-level security, grants and
-- triggers follow in 0019.
CREATE TABLE "best_interests_decision" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"capacity_assessment_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"checklist" jsonb NOT NULL,
	"consultations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"no_consultation_reason" text,
	"serious_medical_treatment" boolean DEFAULT false NOT NULL,
	"accommodation_change" boolean DEFAULT false NOT NULL,
	"imca_prompt" text,
	"review_on" date NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_id" uuid,
	"correction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "best_interests_decision_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "best_interests_decision_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "best_interests_decision_consultation" CHECK (jsonb_typeof(consultations) = 'array'
        AND (jsonb_array_length(consultations) > 0 OR no_consultation_reason IS NOT NULL)),
	CONSTRAINT "best_interests_decision_correction_reason" CHECK (supersedes_id IS NULL OR correction_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "capacity_assessment" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"decision_kind" text,
	"assessed_at" timestamp with time zone NOT NULL,
	"assessor_tenant_user_id" uuid,
	"assessor_name" text,
	"assessor_role" text,
	"practicable_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stage1_impairment" boolean NOT NULL,
	"stage1_description" text,
	"stage2" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"inability_because_of_impairment" boolean,
	"outcome" text NOT NULL,
	"unable_to" text[] DEFAULT '{}'::text[] NOT NULL,
	"reason" text NOT NULL,
	"review_on" date,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_id" uuid,
	"correction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "capacity_assessment_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "capacity_assessment_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "capacity_assessment_outcome" CHECK (outcome IN ('has_capacity', 'lacks_capacity')),
	CONSTRAINT "capacity_assessment_decision_kind" CHECK (decision_kind IS NULL OR decision_kind IN ('care_plan', 'photos', 'social_media', 'sharing', 'marketing', 'ai_processing', 'bed_rails', 'covert_medicines')),
	CONSTRAINT "capacity_assessment_assessor" CHECK (assessor_tenant_user_id IS NOT NULL OR assessor_name IS NOT NULL),
	CONSTRAINT "capacity_assessment_lacks" CHECK (outcome = 'has_capacity' OR (stage1_impairment AND cardinality(unable_to) > 0
        AND inability_because_of_impairment IS TRUE)),
	CONSTRAINT "capacity_assessment_correction_reason" CHECK (supersedes_id IS NULL OR correction_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "consent_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"outcome" text NOT NULL,
	"given_by_kind" text NOT NULL,
	"representative_kind" text,
	"representative_contact_id" uuid,
	"representative_name" text,
	"lpa_registered" boolean,
	"opg_reference" text,
	"excluded_decisions" text[] DEFAULT '{}'::text[] NOT NULL,
	"deputy_scope" text,
	"deputy_decisions" text[] DEFAULT '{}'::text[] NOT NULL,
	"deputy_restraint_authorised" boolean,
	"deputy_order_ends_at" timestamp with time zone,
	"court_reference" text,
	"capacity_status" text NOT NULL,
	"capacity_assessment_id" uuid,
	"given_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	"evidence" text NOT NULL,
	"evidence_document_id" uuid,
	"restraint_necessary" boolean,
	"restraint_proportionate" boolean,
	"best_interests_decision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "consent_record_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "consent_record_decision" CHECK (decision IN ('care_plan', 'photos', 'social_media', 'sharing', 'marketing', 'ai_processing', 'bed_rails', 'covert_medicines')),
	CONSTRAINT "consent_record_outcome" CHECK (outcome IN ('given', 'refused')),
	CONSTRAINT "consent_record_given_by" CHECK (given_by_kind IN ('person', 'representative')
        AND (given_by_kind = 'representative') = (representative_kind IS NOT NULL)),
	CONSTRAINT "consent_record_representative" CHECK (representative_kind IS NULL OR (representative_kind IN ('lpa_health_welfare', 'lpa_property_financial', 'deputy', 'appointee', 'imca', 'advocate', 'family_or_friend')
        AND (representative_contact_id IS NOT NULL OR representative_name IS NOT NULL))),
	CONSTRAINT "consent_record_deputy_scope" CHECK (deputy_scope IS NULL OR deputy_scope IN ('personal_welfare', 'property_and_affairs')),
	CONSTRAINT "consent_record_capacity" CHECK (capacity_status IN ('assumed', 'has_capacity', 'lacks_capacity')
        AND (capacity_status = 'assumed') = (capacity_assessment_id IS NULL)),
	CONSTRAINT "consent_record_evidence" CHECK (length(trim(evidence)) > 0),
	CONSTRAINT "consent_record_expiry" CHECK (expires_at IS NULL OR expires_at > given_at),
	CONSTRAINT "consent_record_withdrawn" CHECK (withdrawn_at IS NULL OR (withdrawn_reason IS NOT NULL AND withdrawn_at >= given_at))
);
--> statement-breakpoint
CREATE TABLE "dols_authorisation" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"type" text NOT NULL,
	"nation" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"outcome_at" timestamp with time zone,
	"granted_from" timestamp with time zone,
	"granted_to" timestamp with time zone,
	"extensions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preceded_by_urgent" boolean DEFAULT false NOT NULL,
	"preceded_by_authorisation_id" uuid,
	"withdrawal_reason" text,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	"conditions" text,
	"rpr_name" text,
	"rpr_contact_id" uuid,
	"supervisory_body" text,
	"supervisory_body_reference" text,
	"objection_evidence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "dols_authorisation_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "dols_authorisation_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "dols_authorisation_type" CHECK (type IN ('urgent', 'standard', 'court_order')),
	CONSTRAINT "dols_authorisation_nation" CHECK (nation IN ('england', 'wales')),
	CONSTRAINT "dols_authorisation_outcome" CHECK (outcome IN ('pending', 'granted', 'not_granted', 'withdrawn')
        AND (outcome = 'pending' OR outcome_at IS NOT NULL)),
	CONSTRAINT "dols_authorisation_withdrawn" CHECK (outcome <> 'withdrawn' OR withdrawal_reason IS NOT NULL),
	CONSTRAINT "dols_authorisation_period" CHECK (granted_to IS NULL OR granted_from IS NULL OR granted_to > granted_from),
	CONSTRAINT "dols_authorisation_ended" CHECK (ended_at IS NULL OR ended_reason IS NOT NULL),
	CONSTRAINT "dols_authorisation_extensions" CHECK (jsonb_typeof(extensions) = 'array')
);
--> statement-breakpoint
CREATE TABLE "dols_legal_change_review" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"dols_authorisation_id" uuid NOT NULL,
	"state" text DEFAULT 'awaiting_review' NOT NULL,
	"factors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"objection" text,
	"objection_forms" text[] DEFAULT '{}'::text[] NOT NULL,
	"consent_signs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decision" text,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"referral_sent_at" timestamp with time zone,
	"referral_reference" text,
	"referral_required" boolean DEFAULT false NOT NULL,
	"prompts" text[] DEFAULT '{}'::text[] NOT NULL,
	"closed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "dols_legal_change_review_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "dols_legal_change_review_state" CHECK (state IN ('awaiting_review', 'reviewed', 'referred', 'closed')),
	CONSTRAINT "dols_legal_change_review_decision" CHECK (decision IS NULL OR decision IN ('still_deprived', 'no_longer_deprived', 'in_doubt')),
	CONSTRAINT "dols_legal_change_review_objection" CHECK (objection IS NULL OR objection IN ('objects', 'does_not_object', 'fluctuates', 'unclear')),
	CONSTRAINT "dols_legal_change_review_reviewed" CHECK (state NOT IN ('reviewed', 'referred') OR (decision IS NOT NULL AND decided_at IS NOT NULL)),
	CONSTRAINT "dols_legal_change_review_referred" CHECK (state <> 'referred' OR referral_sent_at IS NOT NULL),
	CONSTRAINT "dols_legal_change_review_closed" CHECK (state <> 'closed' OR closed_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "candour_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"incident_id" uuid NOT NULL,
	"person_id" uuid,
	"state" text DEFAULT 'threshold_assessment' NOT NULL,
	"threshold_notifiable" boolean,
	"threshold_decided_at" timestamp with time zone,
	"threshold_decided_by" text,
	"verbal" jsonb,
	"contact_attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"written" jsonb,
	"enquiry_results_shared_at" timestamp with time zone,
	"correspondence_document_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "candour_record_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "candour_record_incident_key" UNIQUE("tenant_id","incident_id"),
	CONSTRAINT "candour_record_state" CHECK (state IN ('threshold_assessment', 'not_notifiable', 'verbal_due', 'no_contact', 'written_due', 'enquiries_open', 'closed')),
	CONSTRAINT "candour_record_threshold" CHECK ((threshold_notifiable IS NULL) = (threshold_decided_at IS NULL)
        AND (threshold_notifiable IS NULL OR threshold_decided_by IS NOT NULL)),
	CONSTRAINT "candour_record_attempts" CHECK (jsonb_typeof(contact_attempts) = 'array')
);
--> statement-breakpoint
CREATE TABLE "classifier_answer" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"incident_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"value" jsonb NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_by" uuid DEFAULT app.current_user_id(),
	"device_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "classifier_answer_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "classifier_answer_question_key" CHECK (question_key IN ('harm.impairment_days', 'harm.body_structure_changed', 'harm.pain_days', 'harm.psychological_harm_days', 'harm.life_expectancy_shortened', 'harm.treatment_to_prevent', 'candour.unintended_or_unexpected', 'candour.death_related_to_incident', 'safeguarding.concern', 'safeguarding.types', 'pressure_ulcer.neglect_concern', 'pressure_ulcer.severe_impact', 'police.involved', 'service.threatens_safe_running', 'service.insufficient_staff', 'service.utility_interruption_hours', 'service.premises_damage', 'service.safety_device_failure_hours', 'riddor.work_connected', 'riddor.excluded_cause', 'riddor.worker_specified_injury', 'riddor.worker_incapacity_days', 'riddor.non_worker_to_hospital', 'riddor.dangerous_occurrence', 'falls.head_injury', 'falls.anticoagulant'))
);
--> statement-breakpoint
CREATE TABLE "incident" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"device_time" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" text,
	"late_entry" boolean DEFAULT false NOT NULL,
	"clock_drift" boolean DEFAULT false NOT NULL,
	"found_at" timestamp with time zone,
	"severity" text,
	"harm_grade" text,
	"description" text NOT NULL,
	"immediate_actions" text,
	"emergency_services_called" boolean DEFAULT false NOT NULL,
	"gp_contacted" boolean DEFAULT false NOT NULL,
	"contact_notes" text,
	"family_informed_who" text,
	"family_informed_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"raised_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"person_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"classifier_version" text,
	"classified_at" timestamp with time zone,
	"nation_supported" boolean,
	"classifier_result" jsonb,
	"open_questions" text[] DEFAULT '{}'::text[] NOT NULL,
	"retention_class" text DEFAULT 'care_record' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "incident_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "incident_type" CHECK (type IN ('fall', 'medication', 'skin', 'behaviour', 'missing_person', 'safeguarding_concern', 'injury', 'near_miss', 'environmental', 'ipc', 'staff_injury', 'violence_to_staff', 'self_harm', 'sexual_safety', 'absconding', 'fire_setting', 'substance_use', 'data_breach')),
	CONSTRAINT "incident_severity" CHECK (severity IS NULL OR severity IN ('negligible', 'minor', 'moderate', 'major', 'catastrophic')),
	CONSTRAINT "incident_harm_grade" CHECK (harm_grade IS NULL OR harm_grade IN ('none', 'low', 'moderate', 'severe', 'fatal')),
	CONSTRAINT "incident_status" CHECK (status IN ('open', 'under_review', 'closed')),
	CONSTRAINT "incident_closed" CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL AND closed_reason IS NOT NULL)),
	CONSTRAINT "incident_closed_by_other" CHECK (closed_by IS NULL OR closed_by <> raised_by),
	CONSTRAINT "incident_retention_class" CHECK (retention_class IN ('care_record', 'serious_incident')),
	CONSTRAINT "incident_family_informed" CHECK ((family_informed_at IS NULL) = (family_informed_who IS NULL)),
	CONSTRAINT "incident_found_at" CHECK (found_at IS NULL OR found_at >= occurred_at)
);
--> statement-breakpoint
CREATE TABLE "incident_person" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"incident_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"role" text NOT NULL,
	"person_id" uuid,
	"tenant_user_id" uuid,
	"other_name" text,
	"injury_details" text,
	"died" boolean DEFAULT false NOT NULL,
	"learning_disability" boolean,
	"autistic" boolean,
	"subject_to_mental_health_act" boolean,
	"body_map_mark_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"infection" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "incident_person_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "incident_person_kind" CHECK (kind IN ('service_user', 'worker', 'other_not_at_work')
        AND (kind = 'service_user') = (person_id IS NOT NULL)
        AND (kind <> 'worker' OR tenant_user_id IS NOT NULL OR other_name IS NOT NULL)
        AND (kind <> 'other_not_at_work' OR other_name IS NOT NULL)
        AND (kind = 'worker' OR tenant_user_id IS NULL)),
	CONSTRAINT "incident_person_role" CHECK (role IN ('affected', 'witness', 'involved')),
	CONSTRAINT "incident_person_infection" CHECK (infection IS NULL OR jsonb_typeof(infection) = 'object')
);
--> statement-breakpoint
CREATE TABLE "investigation" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"incident_id" uuid NOT NULL,
	"lead_tenant_user_id" uuid,
	"method" text,
	"findings" text,
	"contributing_factors" text[] DEFAULT '{}'::text[] NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lessons" text,
	"bulletin_published_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "investigation_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "investigation_incident_key" UNIQUE("tenant_id","incident_id"),
	CONSTRAINT "investigation_method" CHECK (method IS NULL OR method IN ('root_cause_analysis', 'five_whys', 'fishbone',
        'after_action_review', 'swarm_huddle', 'other')),
	CONSTRAINT "investigation_status" CHECK (status IN ('open', 'completed')),
	CONSTRAINT "investigation_completed" CHECK ((status = 'completed') = (completed_at IS NOT NULL)
        AND (status = 'open' OR (findings IS NOT NULL AND lessons IS NOT NULL))),
	CONSTRAINT "investigation_actions" CHECK (jsonb_typeof(actions) = 'array')
);
--> statement-breakpoint
CREATE TABLE "statutory_notification" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"incident_id" uuid,
	"person_id" uuid,
	"dols_authorisation_id" uuid,
	"source_key" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"deadlines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provisional" boolean DEFAULT false NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"required_content" text[] DEFAULT '{}'::text[] NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"statement" jsonb,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"no_longer_indicated" boolean DEFAULT false NOT NULL,
	"no_longer_indicated_reason" text,
	"not_required_reason" text,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"external_reference" text,
	"evidence_document_id" uuid,
	"classifier_version" text,
	"retention_class" text NOT NULL,
	"overdue_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "statutory_notification_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "statutory_notification_source_key" UNIQUE("tenant_id","source_key"),
	CONSTRAINT "statutory_notification_kind" CHECK (kind IN ('cqc_reg16_death', 'cqc_reg18_serious_injury', 'cqc_reg18_abuse', 'cqc_reg18_police', 'cqc_reg18_service_disruption', 'cqc_reg18_dols_outcome', 'riddor_death', 'riddor_specified_injury', 'riddor_non_worker_hospital', 'riddor_over_7_day', 'riddor_dangerous_occurrence', 'safeguarding_s42', 'candour', 'leder', 'ukhsa_outbreak', 'medical_examiner', 'police_missing_person')),
	CONSTRAINT "statutory_notification_status" CHECK (status IN ('draft', 'ready', 'submitted', 'not_required')),
	CONSTRAINT "statutory_notification_not_required" CHECK (status <> 'not_required' OR not_required_reason IS NOT NULL),
	CONSTRAINT "statutory_notification_submitted" CHECK (status <> 'submitted' OR (submitted_at IS NOT NULL AND submitted_by IS NOT NULL
        AND (external_reference IS NOT NULL OR evidence_document_id IS NOT NULL))),
	CONSTRAINT "statutory_notification_dols" CHECK ((kind = 'cqc_reg18_dols_outcome') = (dols_authorisation_id IS NOT NULL)
        AND (dols_authorisation_id IS NULL OR person_id IS NOT NULL)),
	CONSTRAINT "statutory_notification_retention_class" CHECK (retention_class IN ('serious_incident', 'riddor_report'))
);
--> statement-breakpoint
ALTER TABLE "best_interests_decision" ADD CONSTRAINT "best_interests_decision_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "best_interests_decision" ADD CONSTRAINT "best_interests_decision_assessment_fk" FOREIGN KEY ("tenant_id","person_id","capacity_assessment_id") REFERENCES "public"."capacity_assessment"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "best_interests_decision" ADD CONSTRAINT "best_interests_decision_supersedes_fk" FOREIGN KEY ("tenant_id","person_id","supersedes_id") REFERENCES "public"."best_interests_decision"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_assessment" ADD CONSTRAINT "capacity_assessment_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_assessment" ADD CONSTRAINT "capacity_assessment_assessor_fk" FOREIGN KEY ("tenant_id","assessor_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_assessment" ADD CONSTRAINT "capacity_assessment_supersedes_fk" FOREIGN KEY ("tenant_id","person_id","supersedes_id") REFERENCES "public"."capacity_assessment"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_contact_fk" FOREIGN KEY ("tenant_id","person_id","representative_contact_id") REFERENCES "public"."contact"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_assessment_fk" FOREIGN KEY ("tenant_id","person_id","capacity_assessment_id") REFERENCES "public"."capacity_assessment"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_best_interests_fk" FOREIGN KEY ("tenant_id","person_id","best_interests_decision_id") REFERENCES "public"."best_interests_decision"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_evidence_document_fk" FOREIGN KEY ("tenant_id","evidence_document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dols_authorisation" ADD CONSTRAINT "dols_authorisation_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dols_authorisation" ADD CONSTRAINT "dols_authorisation_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dols_authorisation" ADD CONSTRAINT "dols_authorisation_rpr_fk" FOREIGN KEY ("tenant_id","person_id","rpr_contact_id") REFERENCES "public"."contact"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dols_authorisation" ADD CONSTRAINT "dols_authorisation_preceded_by_fk" FOREIGN KEY ("tenant_id","person_id","preceded_by_authorisation_id") REFERENCES "public"."dols_authorisation"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dols_legal_change_review" ADD CONSTRAINT "dols_legal_change_review_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dols_legal_change_review" ADD CONSTRAINT "dols_legal_change_review_authorisation_fk" FOREIGN KEY ("tenant_id","person_id","dols_authorisation_id") REFERENCES "public"."dols_authorisation"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dols_legal_change_review" ADD CONSTRAINT "dols_legal_change_review_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candour_record" ADD CONSTRAINT "candour_record_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incident"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candour_record" ADD CONSTRAINT "candour_record_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifier_answer" ADD CONSTRAINT "classifier_answer_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incident"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifier_answer" ADD CONSTRAINT "classifier_answer_answered_by_fk" FOREIGN KEY ("tenant_id","answered_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_raised_by_fk" FOREIGN KEY ("tenant_id","raised_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_person" ADD CONSTRAINT "incident_person_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incident"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_person" ADD CONSTRAINT "incident_person_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_person" ADD CONSTRAINT "incident_person_tenant_user_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation" ADD CONSTRAINT "investigation_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incident"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation" ADD CONSTRAINT "investigation_lead_fk" FOREIGN KEY ("tenant_id","lead_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_notification" ADD CONSTRAINT "statutory_notification_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_notification" ADD CONSTRAINT "statutory_notification_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incident"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_notification" ADD CONSTRAINT "statutory_notification_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_notification" ADD CONSTRAINT "statutory_notification_dols_fk" FOREIGN KEY ("tenant_id","person_id","dols_authorisation_id") REFERENCES "public"."dols_authorisation"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_notification" ADD CONSTRAINT "statutory_notification_submitted_by_fk" FOREIGN KEY ("tenant_id","submitted_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_notification" ADD CONSTRAINT "statutory_notification_evidence_document_fk" FOREIGN KEY ("tenant_id","evidence_document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "best_interests_decision_person_idx" ON "best_interests_decision" USING btree ("tenant_id","person_id","decided_at");--> statement-breakpoint
CREATE INDEX "capacity_assessment_person_idx" ON "capacity_assessment" USING btree ("tenant_id","person_id","assessed_at");--> statement-breakpoint
CREATE INDEX "consent_record_person_idx" ON "consent_record" USING btree ("tenant_id","person_id","decision","given_at");--> statement-breakpoint
CREATE INDEX "dols_authorisation_person_idx" ON "dols_authorisation" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE INDEX "dols_authorisation_end_idx" ON "dols_authorisation" USING btree ("tenant_id","outcome","granted_to");--> statement-breakpoint
CREATE UNIQUE INDEX "dols_legal_change_review_one_per_authorisation" ON "dols_legal_change_review" USING btree ("tenant_id","dols_authorisation_id");--> statement-breakpoint
CREATE INDEX "classifier_answer_incident_idx" ON "classifier_answer" USING btree ("tenant_id","incident_id","answered_at");--> statement-breakpoint
CREATE INDEX "incident_location_idx" ON "incident" USING btree ("tenant_id","location_id","occurred_at");--> statement-breakpoint
CREATE INDEX "incident_status_idx" ON "incident" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "incident_person_ids_idx" ON "incident" USING gin ("person_ids");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_person_one_person" ON "incident_person" USING btree ("tenant_id","incident_id","person_id") WHERE person_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_person_one_user" ON "incident_person" USING btree ("tenant_id","incident_id","tenant_user_id") WHERE tenant_user_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "incident_person_incident_idx" ON "incident_person" USING btree ("tenant_id","incident_id");--> statement-breakpoint
CREATE INDEX "incident_person_person_idx" ON "incident_person" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE INDEX "statutory_notification_clock_idx" ON "statutory_notification" USING btree ("tenant_id","status","due_at");--> statement-breakpoint
CREATE INDEX "statutory_notification_incident_idx" ON "statutory_notification" USING btree ("tenant_id","incident_id");--> statement-breakpoint
CREATE INDEX "statutory_notification_person_idx" ON "statutory_notification" USING btree ("tenant_id","person_id");--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD CONSTRAINT "body_map_mark_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incident"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "body_map_mark_incident_idx" ON "body_map_mark" USING btree ("tenant_id","incident_id");