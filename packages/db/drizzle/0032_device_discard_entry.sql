CREATE TABLE "device_discard_entry" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"discard_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"entry_id" uuid NOT NULL,
	"owner_tenant_user_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "device_discard_entry_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "device_discard_entry_stage_key" UNIQUE("tenant_id","discard_id","stage","entry_id"),
	CONSTRAINT "device_discard_entry_stage" CHECK (stage IN ('requested', 'deleted', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "device_discard_entry" ADD CONSTRAINT "device_discard_entry_owner_fk" FOREIGN KEY ("tenant_id","owner_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_discard_entry_entry_idx" ON "device_discard_entry" USING btree ("tenant_id","entry_id","owner_tenant_user_id");