CREATE TABLE "refused_entry" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"entry_id" uuid NOT NULL,
	"record_table" text NOT NULL,
	"person_id" uuid,
	"location_id" uuid,
	"payload" jsonb NOT NULL,
	"http_status" integer,
	"refusal_code" text NOT NULL,
	"refusal_message" text,
	"refused_at" timestamp with time zone NOT NULL,
	"author_tenant_user_id" uuid NOT NULL,
	"device_id" uuid,
	"review_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "refused_entry_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "refused_entry_entry_key" UNIQUE("tenant_id","entry_id"),
	CONSTRAINT "refused_entry_table" CHECK (record_table IN ('care_note', 'observation', 'body_map_mark', 'activity_record', 'visit_log')),
	CONSTRAINT "refused_entry_payload" CHECK (jsonb_typeof(payload) = 'object'),
	CONSTRAINT "refused_entry_code" CHECK (refusal_code ~ '^[a-z0-9_]{1,80}$'),
	CONSTRAINT "refused_entry_status" CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599)
);
--> statement-breakpoint
ALTER TABLE "refused_entry" ADD CONSTRAINT "refused_entry_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refused_entry" ADD CONSTRAINT "refused_entry_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refused_entry" ADD CONSTRAINT "refused_entry_author_fk" FOREIGN KEY ("tenant_id","author_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refused_entry" ADD CONSTRAINT "refused_entry_task_fk" FOREIGN KEY ("tenant_id","review_task_id") REFERENCES "public"."task"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refused_entry_person_idx" ON "refused_entry" USING btree ("tenant_id","person_id","refused_at");