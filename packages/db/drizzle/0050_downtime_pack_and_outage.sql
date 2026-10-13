CREATE TABLE "downtime_pack" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"source" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"as_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"generated_by" uuid,
	"person_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"content" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "downtime_pack_source" CHECK (source IN ('server_nightly', 'server_on_demand', 'kiosk_cache')),
	CONSTRAINT "downtime_pack_generated_by" CHECK ((source = 'server_nightly') = (generated_by IS NULL)),
	CONSTRAINT "downtime_pack_times" CHECK (as_at <= generated_at AND valid_until > as_at),
	CONSTRAINT "downtime_pack_json" CHECK (jsonb_typeof(content) = 'object' AND jsonb_typeof(warnings) = 'object')
);
--> statement-breakpoint
CREATE TABLE "outage" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"state" text DEFAULT 'declared' NOT NULL,
	"workflow_instance_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"declared_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"declared_late" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"back_entry_due_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"reconciled_by" uuid,
	"reconciliation_statement" text,
	"reviewed_entry_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"forms_entered" integer,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancellation_reason" text,
	"correction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "outage_kind" CHECK (kind IN ('power', 'network', 'harbour_unavailable', 'device_failure', 'planned_maintenance', 'other')),
	CONSTRAINT "outage_state" CHECK (state IN ('declared', 'closed', 'reconciled', 'cancelled')),
	CONSTRAINT "outage_description" CHECK (char_length(btrim(description)) > 0),
	CONSTRAINT "outage_window" CHECK (ended_at IS NULL OR ended_at >= started_at),
	CONSTRAINT "outage_closed" CHECK ((state IN ('closed', 'reconciled')) = (closed_at IS NOT NULL AND closed_by IS NOT NULL
        AND ended_at IS NOT NULL AND back_entry_due_at IS NOT NULL)),
	CONSTRAINT "outage_reconciled" CHECK ((state = 'reconciled') = (reconciled_at IS NOT NULL AND reconciled_by IS NOT NULL
        AND reconciliation_statement IS NOT NULL AND forms_entered IS NOT NULL)),
	CONSTRAINT "outage_forms_entered" CHECK (forms_entered IS NULL OR forms_entered >= 0),
	CONSTRAINT "outage_words" CHECK ((reconciliation_statement IS NULL OR btrim(reconciliation_statement) <> '')
        AND (cancellation_reason IS NULL OR btrim(cancellation_reason) <> '')
        AND (correction_reason IS NULL OR btrim(correction_reason) <> '')),
	CONSTRAINT "outage_cancelled" CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
        AND cancellation_reason IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "downtime_mar_location" text DEFAULT 'the paper MAR chart' NOT NULL;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "downtime_peep_location" text DEFAULT 'the person''s PEEP in the fire file' NOT NULL;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "downtime_places_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "downtime_places_confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "downtime_pack" ADD CONSTRAINT "downtime_pack_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "downtime_pack" ADD CONSTRAINT "downtime_pack_generated_by_fk" FOREIGN KEY ("tenant_id","generated_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "downtime_pack" ADD CONSTRAINT "downtime_pack_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outage" ADD CONSTRAINT "outage_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outage" ADD CONSTRAINT "outage_workflow_fk" FOREIGN KEY ("tenant_id","workflow_instance_id") REFERENCES "public"."workflow_instance"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outage" ADD CONSTRAINT "outage_declared_by_fk" FOREIGN KEY ("tenant_id","declared_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outage" ADD CONSTRAINT "outage_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outage" ADD CONSTRAINT "outage_reconciled_by_fk" FOREIGN KEY ("tenant_id","reconciled_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outage" ADD CONSTRAINT "outage_cancelled_by_fk" FOREIGN KEY ("tenant_id","cancelled_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "downtime_pack_location_idx" ON "downtime_pack" USING btree ("tenant_id","location_id","generated_at");--> statement-breakpoint
CREATE INDEX "outage_location_idx" ON "outage" USING btree ("tenant_id","location_id","started_at");--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_downtime_places_confirmed_by_fk" FOREIGN KEY ("tenant_id","downtime_places_confirmed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_downtime_places" CHECK (char_length(btrim(downtime_mar_location)) BETWEEN 1 AND 200
        AND char_length(btrim(downtime_peep_location)) BETWEEN 1 AND 200
        AND (downtime_places_confirmed_at IS NULL) = (downtime_places_confirmed_by IS NULL));