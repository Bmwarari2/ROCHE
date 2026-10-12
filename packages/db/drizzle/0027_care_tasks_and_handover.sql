CREATE TABLE "handover" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"shift_name" text NOT NULL,
	"shift_start" timestamp with time zone NOT NULL,
	"shift_end" timestamp with time zone NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compiled_at" timestamp with time zone NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "handover_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "handover_location_shift_key" UNIQUE("tenant_id","location_id","shift_start"),
	CONSTRAINT "handover_shift" CHECK (shift_end > shift_start),
	CONSTRAINT "handover_items_array" CHECK (jsonb_typeof(items) = 'array'),
	CONSTRAINT "handover_refreshed" CHECK (refreshed_at >= compiled_at)
);
--> statement-breakpoint
CREATE TABLE "handover_acknowledgement" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"handover_id" uuid NOT NULL,
	"tenant_user_id" uuid DEFAULT app.current_user_id() NOT NULL,
	"items_seen" integer NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "handover_acknowledgement_items_seen" CHECK (items_seen >= 0)
);
--> statement-breakpoint
CREATE TABLE "handover_note" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"handover_id" uuid NOT NULL,
	"item_key" text,
	"person_id" uuid,
	"body" text NOT NULL,
	"device_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "handover_note_body" CHECK (length(trim(body)) BETWEEN 1 AND 2000),
	CONSTRAINT "handover_note_person" CHECK (person_id IS NULL OR item_key IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "care_plan_action" ADD COLUMN "based_on_action_id" uuid;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "handover" ADD CONSTRAINT "handover_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_acknowledgement" ADD CONSTRAINT "handover_acknowledgement_handover_fk" FOREIGN KEY ("tenant_id","handover_id") REFERENCES "public"."handover"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_acknowledgement" ADD CONSTRAINT "handover_acknowledgement_user_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_note" ADD CONSTRAINT "handover_note_handover_fk" FOREIGN KEY ("tenant_id","handover_id") REFERENCES "public"."handover"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_note" ADD CONSTRAINT "handover_note_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handover_location_idx" ON "handover" USING btree ("tenant_id","location_id","shift_end");--> statement-breakpoint
CREATE INDEX "handover_acknowledgement_handover_idx" ON "handover_acknowledgement" USING btree ("tenant_id","handover_id","tenant_user_id");--> statement-breakpoint
CREATE INDEX "handover_note_handover_idx" ON "handover_note" USING btree ("tenant_id","handover_id","created_at");--> statement-breakpoint
ALTER TABLE "care_plan_action" ADD CONSTRAINT "care_plan_action_based_on_fk" FOREIGN KEY ("tenant_id","based_on_action_id") REFERENCES "public"."care_plan_action"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_location_urgent_idx" ON "notification" USING btree ("tenant_id","location_id","created_at") WHERE severity = 'urgent';--> statement-breakpoint
CREATE UNIQUE INDEX "task_series_care_plan_action_key" ON "task_series" USING btree ("tenant_id","source_id") WHERE source_type = 'care_plan_action' AND deleted_at IS NULL AND (active OR inactive_code IS NOT NULL);