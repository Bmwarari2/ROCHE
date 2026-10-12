CREATE TABLE "escalation_policy_link" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"tool_key" text NOT NULL,
	"band" text,
	"location_id" uuid,
	"title" text NOT NULL,
	"reference" text,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "escalation_policy_link_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "escalation_policy_link_band" CHECK ((tool_key = 'news2' AND (band IS NULL OR band IN ('low', 'low_medium', 'medium', 'high'))) OR (tool_key = 'must' AND (band IS NULL OR band IN ('low', 'medium', 'high'))) OR (tool_key = 'waterlow' AND (band IS NULL OR band IN ('not_at_risk', 'at_risk', 'high_risk', 'very_high_risk'))) OR (tool_key = 'braden' AND (band IS NULL OR band IN ('severe_risk', 'high_risk', 'moderate_risk', 'at_risk', 'below_at_risk_threshold'))) OR (tool_key = 'ng249_falls' AND band IS NULL)),
	CONSTRAINT "escalation_policy_link_text" CHECK (char_length(btrim(title)) BETWEEN 3 AND 200 AND (reference IS NULL OR char_length(reference) <= 100))
);
--> statement-breakpoint
CREATE TABLE "device_discard_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"discard_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"kind" text NOT NULL,
	"reason_code" text NOT NULL,
	"owner_tenant_user_id" uuid,
	"deleted_by_tenant_user_id" uuid,
	"sender_tenant_user_id" uuid NOT NULL,
	"device_id" uuid,
	"entry_count" integer,
	"discarded_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "device_discard_record_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "device_discard_record_stage_key" UNIQUE("tenant_id","discard_id","stage"),
	CONSTRAINT "device_discard_record_stage" CHECK (stage IN ('requested', 'deleted', 'failed')),
	CONSTRAINT "device_discard_record_kind" CHECK (kind IN ('held_deleted', 'signed_out_with_unsent', 'refused_removed')),
	CONSTRAINT "device_discard_record_count" CHECK (entry_count IS NULL OR entry_count BETWEEN 0 AND 100000)
);
--> statement-breakpoint
CREATE TABLE "discard_reason" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"label_cy" text,
	"sort_order" integer DEFAULT 50 NOT NULL,
	"seeded" boolean DEFAULT false NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "discard_reason_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "discard_reason_code_key" UNIQUE("tenant_id","code"),
	CONSTRAINT "discard_reason_code" CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
	CONSTRAINT "discard_reason_label" CHECK (char_length(btrim(label)) BETWEEN 3 AND 120 AND (label_cy IS NULL OR char_length(btrim(label_cy)) BETWEEN 3 AND 120)),
	CONSTRAINT "discard_reason_retired" CHECK ((retired_at IS NULL) = (retired_by IS NULL))
);
--> statement-breakpoint
CREATE TABLE "entry_device_deletion_flag" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"record_table" text NOT NULL,
	"entry_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"location_id" uuid,
	"flag" text NOT NULL,
	"discard_id" uuid NOT NULL,
	"owner_tenant_user_id" uuid NOT NULL,
	"review_task_id" uuid,
	"flagged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "entry_device_deletion_flag_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "entry_device_deletion_flag_entry_key" UNIQUE("tenant_id","entry_id"),
	CONSTRAINT "entry_device_deletion_flag_table" CHECK (record_table IN ('care_note', 'observation', 'body_map_mark', 'activity_record', 'visit_log', 'assessment')),
	CONSTRAINT "entry_device_deletion_flag_flag" CHECK (flag IN ('uploaded_after_deletion', 'deleted_after_upload'))
);
--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "drawn_x" double precision;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "drawn_y" double precision;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "drawn_zone" text;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "drawn_side" text;--> statement-breakpoint
ALTER TABLE "escalation_policy_link" ADD CONSTRAINT "escalation_policy_link_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_policy_link" ADD CONSTRAINT "escalation_policy_link_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_discard_record" ADD CONSTRAINT "device_discard_record_reason_fk" FOREIGN KEY ("tenant_id","reason_code") REFERENCES "public"."discard_reason"("tenant_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_discard_record" ADD CONSTRAINT "device_discard_record_owner_fk" FOREIGN KEY ("tenant_id","owner_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_discard_record" ADD CONSTRAINT "device_discard_record_deleter_fk" FOREIGN KEY ("tenant_id","deleted_by_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_discard_record" ADD CONSTRAINT "device_discard_record_sender_fk" FOREIGN KEY ("tenant_id","sender_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discard_reason" ADD CONSTRAINT "discard_reason_retired_by_fk" FOREIGN KEY ("tenant_id","retired_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_device_deletion_flag" ADD CONSTRAINT "entry_device_deletion_flag_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_device_deletion_flag" ADD CONSTRAINT "entry_device_deletion_flag_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_device_deletion_flag" ADD CONSTRAINT "entry_device_deletion_flag_owner_fk" FOREIGN KEY ("tenant_id","owner_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_device_deletion_flag" ADD CONSTRAINT "entry_device_deletion_flag_task_fk" FOREIGN KEY ("tenant_id","review_task_id") REFERENCES "public"."task"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "escalation_policy_link_live_key" ON "escalation_policy_link" USING btree ("tenant_id","tool_key",coalesce("band", ''),coalesce("location_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "device_discard_record_device_idx" ON "device_discard_record" USING btree ("tenant_id","device_id","recorded_at");--> statement-breakpoint
CREATE INDEX "entry_device_deletion_flag_person_idx" ON "entry_device_deletion_flag" USING btree ("tenant_id","person_id","flagged_at");--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD CONSTRAINT "body_map_mark_drawing" CHECK ((drawn_x IS NULL) = (drawn_y IS NULL)
        AND (drawn_x IS NULL OR (drawn_x BETWEEN 0 AND 120 AND drawn_y BETWEEN 0 AND 240))
        AND (drawn_zone IS NULL OR drawn_zone IN ('viewer_left', 'centre', 'viewer_right'))
        AND (drawn_side IS NULL OR drawn_side IN ('left', 'right', 'midline'))
        AND ((drawn_side IS NULL) = (drawn_zone IS NULL))
        AND (drawn_x IS NULL OR drawn_zone IS NOT NULL));