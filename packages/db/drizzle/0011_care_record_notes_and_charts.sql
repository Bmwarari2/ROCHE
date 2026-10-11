CREATE TABLE "body_map_mark" (
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
	"view" text NOT NULL,
	"region" text NOT NULL,
	"side" text NOT NULL,
	"mark_type" text NOT NULL,
	"pressure_category" text,
	"length_mm" numeric(6, 1),
	"width_mm" numeric(6, 1),
	"depth_mm" numeric(6, 1),
	"description" text,
	"photo_document_id" uuid,
	"incident_id" uuid,
	"status" text DEFAULT 'present' NOT NULL,
	CONSTRAINT "body_map_mark_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "care_note" (
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
	"category" text NOT NULL,
	"body" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"attachment_document_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "care_note_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "observation" (
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
	"chart" text NOT NULL,
	"values" jsonb NOT NULL,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "observation_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "person_care_profile" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"iddsi_food_level" text,
	"iddsi_drink_level" text,
	"iddsi_advised_by" text,
	"iddsi_changed_at" timestamp with time zone,
	"fluid_target_ml" integer,
	"spo2_scale2" boolean DEFAULT false NOT NULL,
	"spo2_scale2_clinician" text,
	"spo2_scale2_recorded_on" date,
	"skin_risk" text DEFAULT 'not_at_risk' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "person_care_profile_person_key" UNIQUE("tenant_id","person_id")
);
--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD CONSTRAINT "body_map_mark_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD CONSTRAINT "body_map_mark_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD CONSTRAINT "body_map_mark_photo_fk" FOREIGN KEY ("tenant_id","photo_document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_note" ADD CONSTRAINT "care_note_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_note" ADD CONSTRAINT "care_note_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_care_profile" ADD CONSTRAINT "person_care_profile_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "body_map_mark_person_idx" ON "body_map_mark" USING btree ("tenant_id","person_id","occurred_at");--> statement-breakpoint
CREATE INDEX "care_note_person_idx" ON "care_note" USING btree ("tenant_id","person_id","occurred_at");--> statement-breakpoint
CREATE INDEX "care_note_location_idx" ON "care_note" USING btree ("tenant_id","location_id","occurred_at");--> statement-breakpoint
CREATE INDEX "observation_person_chart_idx" ON "observation" USING btree ("tenant_id","person_id","chart","occurred_at");--> statement-breakpoint
CREATE INDEX "observation_location_idx" ON "observation" USING btree ("tenant_id","location_id","occurred_at");