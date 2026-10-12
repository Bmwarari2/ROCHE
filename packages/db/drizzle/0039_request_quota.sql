CREATE TABLE "request_quota" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"quota" text NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"hits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_quota_key" UNIQUE("tenant_id","quota","tenant_user_id"),
	CONSTRAINT "request_quota_hits" CHECK (jsonb_typeof(hits) = 'array')
);
--> statement-breakpoint
ALTER TABLE "request_quota" ADD CONSTRAINT "request_quota_user_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;