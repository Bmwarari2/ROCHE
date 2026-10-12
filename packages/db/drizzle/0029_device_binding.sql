CREATE TABLE "device_binding" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"device_id" uuid NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "device_binding_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "device_binding_device_user_key" UNIQUE("tenant_id","device_id","tenant_user_id"),
	CONSTRAINT "device_binding_seen" CHECK (last_seen_at >= first_seen_at),
	CONSTRAINT "device_binding_revocation" CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason IN ('lost_or_stolen', 'staff_left', 'access_withdrawn', 'replaced', 'other')))
);
--> statement-breakpoint
ALTER TABLE "device_binding" ADD CONSTRAINT "device_binding_user_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_binding" ADD CONSTRAINT "device_binding_revoked_by_fk" FOREIGN KEY ("tenant_id","revoked_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_binding_user_idx" ON "device_binding" USING btree ("tenant_id","tenant_user_id");