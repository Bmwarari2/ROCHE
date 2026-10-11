CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"series_id" uuid,
	"location_id" uuid,
	"person_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"required_permission" text NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"assignee_tenant_user_id" uuid,
	"assignee_role_key" text,
	"due_at" timestamp with time zone NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"priority" text DEFAULT 'routine' NOT NULL,
	"evidence_required" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"status_reason" text,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"evidence_type" text,
	"evidence_id" uuid,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"escalated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "task_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "task_series" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid,
	"person_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"required_permission" text NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"assignee_tenant_user_id" uuid,
	"assignee_role_key" text,
	"recurrence" jsonb NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"window_before_minutes" integer DEFAULT 0 NOT NULL,
	"window_after_minutes" integer DEFAULT 0 NOT NULL,
	"evidence_required" boolean DEFAULT false NOT NULL,
	"priority" text DEFAULT 'routine' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"materialised_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "task_series_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "workflow_instance" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"definition_key" text NOT NULL,
	"definition_version" integer NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"person_id" uuid,
	"state" text NOT NULL,
	"entered_state_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sla_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workflow_instance_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "workflow_instance_subject_key" UNIQUE("tenant_id","subject_type","subject_id","definition_key")
);
--> statement-breakpoint
CREATE TABLE "workflow_transition" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"instance_id" uuid NOT NULL,
	"person_id" uuid,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"reason" text,
	"step_up" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id()
);
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_series_fk" FOREIGN KEY ("tenant_id","series_id") REFERENCES "public"."task_series"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_assignee_fk" FOREIGN KEY ("tenant_id","assignee_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_series" ADD CONSTRAINT "task_series_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_series" ADD CONSTRAINT "task_series_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_series" ADD CONSTRAINT "task_series_assignee_fk" FOREIGN KEY ("tenant_id","assignee_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instance" ADD CONSTRAINT "workflow_instance_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition" ADD CONSTRAINT "workflow_transition_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."workflow_instance"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition" ADD CONSTRAINT "workflow_transition_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_series_due_key" ON "task" USING btree ("tenant_id","series_id","due_at") WHERE series_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_due_idx" ON "task" USING btree ("tenant_id","status","due_at");--> statement-breakpoint
CREATE INDEX "task_person_idx" ON "task" USING btree ("tenant_id","person_id","due_at");--> statement-breakpoint
CREATE INDEX "task_assignee_idx" ON "task" USING btree ("tenant_id","assignee_tenant_user_id","status");--> statement-breakpoint
CREATE INDEX "task_series_active_idx" ON "task_series" USING btree ("tenant_id","active");--> statement-breakpoint
CREATE INDEX "workflow_instance_sla_idx" ON "workflow_instance" USING btree ("tenant_id","sla_due_at");--> statement-breakpoint
CREATE INDEX "workflow_transition_instance_idx" ON "workflow_transition" USING btree ("tenant_id","instance_id","occurred_at");