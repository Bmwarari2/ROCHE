-- The contact key comes first: visit_log and care_plan reference it.
ALTER TABLE "contact" ADD CONSTRAINT "contact_tenant_person_id_key" UNIQUE("tenant_id","person_id","id");--> statement-breakpoint
CREATE TABLE "activity_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_time" timestamp with time zone,
	"device_offset_minutes" integer,
	"created_by" uuid DEFAULT app.current_user_id(),
	"device_id" text,
	"late_entry" boolean DEFAULT false NOT NULL,
	"clock_drift" boolean DEFAULT false NOT NULL,
	"supersedes_id" uuid,
	"correction_reason" text,
	"activity" text NOT NULL,
	"format" text NOT NULL,
	"group_session_id" uuid,
	"attendance" text NOT NULL,
	"engagement" text,
	"duration_minutes" integer,
	"notes" text,
	CONSTRAINT "activity_record_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "activity_record_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "activity_record_format" CHECK (format IN ('group', 'one_to_one')),
	CONSTRAINT "activity_record_attendance" CHECK (attendance IN ('attended', 'partly_attended', 'declined', 'not_able')),
	CONSTRAINT "activity_record_group_session" CHECK ((format = 'group') = (group_session_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "advance_care_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cpr_decision" text,
	"clinician_name" text,
	"clinician_role" text,
	"completed_on" date NOT NULL,
	"review_due_on" date,
	"document_id" uuid,
	"details" text,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	"superseded_by_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "advance_care_record_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "advance_care_record_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "advance_care_record_kind" CHECK (kind IN ('respect', 'dnacpr', 'adrt', 'advance_care_plan')),
	CONSTRAINT "advance_care_record_status" CHECK (status IN ('active', 'withdrawn', 'superseded')),
	CONSTRAINT "advance_care_record_cpr" CHECK (CASE kind
        WHEN 'dnacpr' THEN cpr_decision IS NOT DISTINCT FROM 'do_not_attempt_cpr'
        WHEN 'respect' THEN cpr_decision IS NOT NULL
          AND cpr_decision IN ('attempt_cpr', 'do_not_attempt_cpr')
        ELSE cpr_decision IS NULL
      END),
	CONSTRAINT "advance_care_record_withdrawn" CHECK (status <> 'withdrawn' OR withdrawn_reason IS NOT NULL),
	CONSTRAINT "advance_care_record_review" CHECK (review_due_on IS NULL OR review_due_on >= completed_on)
);
--> statement-breakpoint
CREATE TABLE "assessment" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_time" timestamp with time zone,
	"device_offset_minutes" integer,
	"created_by" uuid DEFAULT app.current_user_id(),
	"device_id" text,
	"late_entry" boolean DEFAULT false NOT NULL,
	"clock_drift" boolean DEFAULT false NOT NULL,
	"supersedes_id" uuid,
	"correction_reason" text,
	"tool_key" text NOT NULL,
	"tool_version" text NOT NULL,
	"answers" jsonb NOT NULL,
	"score" integer,
	"band" text,
	"workings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"triggers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_due_on" date,
	CONSTRAINT "assessment_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "assessment_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "assessment_tool_key" CHECK (tool_key IN ('must', 'waterlow', 'braden', 'ng249_falls')),
	CONSTRAINT "assessment_correction_reason" CHECK (supersedes_id IS NULL OR correction_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "care_plan" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_version" integer,
	"based_on_plan_id" uuid,
	"summary" text,
	"review_due_on" date,
	"review_reason" text,
	"review_requested_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"superseded_at" timestamp with time zone,
	"superseded_by_plan_id" uuid,
	"sign_off_kind" text,
	"sign_off_representative_name" text,
	"sign_off_authority" text,
	"sign_off_contact_id" uuid,
	"sign_off_unable_reason" text,
	"signed_off_at" timestamp with time zone,
	"signed_off_recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "care_plan_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "care_plan_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "care_plan_status" CHECK (status IN ('draft', 'active', 'superseded')),
	CONSTRAINT "care_plan_published" CHECK ((status = 'draft') = (published_version IS NULL)),
	CONSTRAINT "care_plan_sign_off" CHECK (sign_off_kind IS NULL
        OR sign_off_kind = 'person'
        OR (sign_off_kind = 'representative' AND sign_off_representative_name IS NOT NULL
            AND sign_off_authority IS NOT NULL)
        OR (sign_off_kind = 'unable' AND sign_off_unable_reason IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "care_plan_action" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"action" text NOT NULL,
	"role_key" text,
	"recurrence" jsonb,
	"when_text" text,
	"generates_tasks" boolean DEFAULT false NOT NULL,
	"evidence_required" boolean DEFAULT false NOT NULL,
	"risk_assessment_id" uuid,
	"task_series_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "care_plan_action_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "care_plan_action_schedule" CHECK (NOT generates_tasks OR (recurrence IS NOT NULL AND role_key IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "care_plan_section" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"need" text,
	"outcome" text,
	"strengths" text,
	"contingency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "care_plan_section_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "care_plan_section_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "care_plan_section_domain_key" UNIQUE("tenant_id","plan_id","domain"),
	CONSTRAINT "care_plan_section_domain" CHECK (domain IN ('mobility', 'skin', 'nutrition_and_hydration', 'continence', 'communication', 'cognition', 'mood', 'behaviour', 'sleep', 'pain', 'breathing', 'medicines', 'personal_care', 'social_and_spiritual', 'sexuality_and_relationships', 'end_of_life'))
);
--> statement-breakpoint
CREATE TABLE "risk_assessment" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"template_version" text NOT NULL,
	"hazard" text NOT NULL,
	"who_at_risk" text NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"likelihood" integer,
	"severity" integer,
	"risk_rating" integer,
	"risk_band" text,
	"controls" text[] DEFAULT '{}'::text[] NOT NULL,
	"residual_likelihood" integer,
	"residual_severity" integer,
	"residual_rating" integer,
	"residual_band" text,
	"positive_risk_statement" text,
	"person_views" text,
	"assessed_on" date NOT NULL,
	"review_due_on" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"closed_reason" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "risk_assessment_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "risk_assessment_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "risk_assessment_status" CHECK (status IN ('active', 'closed')),
	CONSTRAINT "risk_assessment_closed_reason" CHECK (status = 'active' OR closed_reason IS NOT NULL),
	CONSTRAINT "risk_assessment_scales" CHECK ((likelihood IS NULL OR likelihood BETWEEN 1 AND 5)
        AND (severity IS NULL OR severity BETWEEN 1 AND 5)
        AND (residual_likelihood IS NULL OR residual_likelihood BETWEEN 1 AND 5)
        AND (residual_severity IS NULL OR residual_severity BETWEEN 1 AND 5)),
	CONSTRAINT "risk_assessment_rating" CHECK (risk_rating IS NOT DISTINCT FROM likelihood * severity
        AND residual_rating IS NOT DISTINCT FROM residual_likelihood * residual_severity),
	CONSTRAINT "risk_assessment_review" CHECK (review_due_on >= assessed_on)
);
--> statement-breakpoint
CREATE TABLE "visit_log" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_time" timestamp with time zone,
	"device_offset_minutes" integer,
	"created_by" uuid DEFAULT app.current_user_id(),
	"device_id" text,
	"late_entry" boolean DEFAULT false NOT NULL,
	"clock_drift" boolean DEFAULT false NOT NULL,
	"supersedes_id" uuid,
	"correction_reason" text,
	"kind" text NOT NULL,
	"contact_id" uuid,
	"visitor_name" text,
	"visitor_relationship" text,
	"ended_at" timestamp with time zone,
	"restrictions_applied" boolean DEFAULT false NOT NULL,
	"restriction_reason" text,
	"notes" text,
	CONSTRAINT "visit_log_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "visit_log_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "visit_log_kind" CHECK (kind IN ('facilitated_visit', 'visit_out', 'accompaniment')),
	CONSTRAINT "visit_log_visitor" CHECK (contact_id IS NOT NULL OR visitor_name IS NOT NULL),
	CONSTRAINT "visit_log_restriction_reason" CHECK (restrictions_applied = (restriction_reason IS NOT NULL)),
	CONSTRAINT "visit_log_times" CHECK (ended_at IS NULL OR ended_at >= occurred_at)
);
--> statement-breakpoint
ALTER TABLE "activity_record" ADD CONSTRAINT "activity_record_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_record" ADD CONSTRAINT "activity_record_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_record" ADD CONSTRAINT "activity_record_supersedes_fk" FOREIGN KEY ("tenant_id","person_id","supersedes_id") REFERENCES "public"."activity_record"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advance_care_record" ADD CONSTRAINT "advance_care_record_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advance_care_record" ADD CONSTRAINT "advance_care_record_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advance_care_record" ADD CONSTRAINT "advance_care_record_superseded_by_fk" FOREIGN KEY ("tenant_id","person_id","superseded_by_record_id") REFERENCES "public"."advance_care_record"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_supersedes_fk" FOREIGN KEY ("tenant_id","person_id","supersedes_id") REFERENCES "public"."assessment"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan" ADD CONSTRAINT "care_plan_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan" ADD CONSTRAINT "care_plan_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan" ADD CONSTRAINT "care_plan_based_on_fk" FOREIGN KEY ("tenant_id","person_id","based_on_plan_id") REFERENCES "public"."care_plan"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan" ADD CONSTRAINT "care_plan_superseded_by_fk" FOREIGN KEY ("tenant_id","person_id","superseded_by_plan_id") REFERENCES "public"."care_plan"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan" ADD CONSTRAINT "care_plan_sign_off_contact_fk" FOREIGN KEY ("tenant_id","person_id","sign_off_contact_id") REFERENCES "public"."contact"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_action" ADD CONSTRAINT "care_plan_action_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_action" ADD CONSTRAINT "care_plan_action_plan_fk" FOREIGN KEY ("tenant_id","person_id","plan_id") REFERENCES "public"."care_plan"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_action" ADD CONSTRAINT "care_plan_action_section_fk" FOREIGN KEY ("tenant_id","person_id","section_id") REFERENCES "public"."care_plan_section"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_action" ADD CONSTRAINT "care_plan_action_risk_assessment_fk" FOREIGN KEY ("tenant_id","person_id","risk_assessment_id") REFERENCES "public"."risk_assessment"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_action" ADD CONSTRAINT "care_plan_action_task_series_fk" FOREIGN KEY ("tenant_id","task_series_id") REFERENCES "public"."task_series"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_section" ADD CONSTRAINT "care_plan_section_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_section" ADD CONSTRAINT "care_plan_section_plan_fk" FOREIGN KEY ("tenant_id","person_id","plan_id") REFERENCES "public"."care_plan"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_assessment" ADD CONSTRAINT "risk_assessment_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_log" ADD CONSTRAINT "visit_log_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_log" ADD CONSTRAINT "visit_log_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_log" ADD CONSTRAINT "visit_log_contact_fk" FOREIGN KEY ("tenant_id","person_id","contact_id") REFERENCES "public"."contact"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_log" ADD CONSTRAINT "visit_log_supersedes_fk" FOREIGN KEY ("tenant_id","person_id","supersedes_id") REFERENCES "public"."visit_log"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_record_person_idx" ON "activity_record" USING btree ("tenant_id","person_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activity_record_session_idx" ON "activity_record" USING btree ("tenant_id","group_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "advance_care_record_one_active" ON "advance_care_record" USING btree ("tenant_id","person_id","kind") WHERE status = 'active' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "advance_care_record_person_idx" ON "advance_care_record" USING btree ("tenant_id","person_id","status");--> statement-breakpoint
CREATE INDEX "assessment_person_tool_idx" ON "assessment" USING btree ("tenant_id","person_id","tool_key","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "care_plan_one_active" ON "care_plan" USING btree ("tenant_id","person_id") WHERE status = 'active' AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "care_plan_one_draft" ON "care_plan" USING btree ("tenant_id","person_id") WHERE status = 'draft' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "care_plan_person_idx" ON "care_plan" USING btree ("tenant_id","person_id","status");--> statement-breakpoint
CREATE INDEX "care_plan_review_idx" ON "care_plan" USING btree ("tenant_id","status","review_due_on");--> statement-breakpoint
CREATE INDEX "care_plan_action_plan_idx" ON "care_plan_action" USING btree ("tenant_id","plan_id");--> statement-breakpoint
CREATE INDEX "risk_assessment_person_idx" ON "risk_assessment" USING btree ("tenant_id","person_id","status");--> statement-breakpoint
CREATE INDEX "risk_assessment_review_idx" ON "risk_assessment" USING btree ("tenant_id","status","review_due_on");--> statement-breakpoint
CREATE INDEX "visit_log_person_idx" ON "visit_log" USING btree ("tenant_id","person_id","occurred_at");
