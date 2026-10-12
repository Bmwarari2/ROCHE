CREATE TABLE "device_session" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"device_id" uuid NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "device_session_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "device_session_key" UNIQUE("tenant_id","device_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "handed_over_entry" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"handover_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"owner_tenant_user_id" uuid NOT NULL,
	"sent_by" uuid NOT NULL,
	"record_table" text NOT NULL,
	"entry_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "handed_over_entry_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "handed_over_entry_entry_key" UNIQUE("tenant_id","record_table","entry_id"),
	CONSTRAINT "handed_over_entry_table" CHECK (record_table IN ('care_note', 'observation', 'body_map_mark', 'activity_record', 'visit_log'))
);
--> statement-breakpoint
ALTER TABLE "activity_record" ADD COLUMN "handed_over_by" uuid;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "handed_over_by" uuid;--> statement-breakpoint
ALTER TABLE "care_note" ADD COLUMN "handed_over_by" uuid;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "handed_over_by" uuid;--> statement-breakpoint
ALTER TABLE "visit_log" ADD COLUMN "handed_over_by" uuid;--> statement-breakpoint
ALTER TABLE "device_session" ADD CONSTRAINT "device_session_binding_fk" FOREIGN KEY ("tenant_id","device_id","tenant_user_id") REFERENCES "public"."device_binding"("tenant_id","device_id","tenant_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handed_over_entry" ADD CONSTRAINT "handed_over_entry_owner_fk" FOREIGN KEY ("tenant_id","owner_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handed_over_entry" ADD CONSTRAINT "handed_over_entry_sender_fk" FOREIGN KEY ("tenant_id","sent_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_session_session_idx" ON "device_session" USING btree ("tenant_id","session_id");--> statement-breakpoint
CREATE INDEX "handed_over_entry_handover_idx" ON "handed_over_entry" USING btree ("tenant_id","handover_id");--> statement-breakpoint
CREATE INDEX "handed_over_entry_hold_idx" ON "handed_over_entry" USING btree ("tenant_id","device_id","owner_tenant_user_id","accepted_at");--> statement-breakpoint
ALTER TABLE "activity_record" ADD CONSTRAINT "activity_record_handed_over_by_fk" FOREIGN KEY ("tenant_id","handed_over_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD CONSTRAINT "body_map_mark_handed_over_by_fk" FOREIGN KEY ("tenant_id","handed_over_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_note" ADD CONSTRAINT "care_note_handed_over_by_fk" FOREIGN KEY ("tenant_id","handed_over_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_handed_over_by_fk" FOREIGN KEY ("tenant_id","handed_over_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_log" ADD CONSTRAINT "visit_log_handed_over_by_fk" FOREIGN KEY ("tenant_id","handed_over_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;