CREATE TABLE "destruction_certificate" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"record_class" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_ids" uuid[] NOT NULL,
	"record_count" integer NOT NULL,
	"retention_rule" jsonb NOT NULL,
	"reason" text NOT NULL,
	"method" text NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id()
);
--> statement-breakpoint
CREATE TABLE "document_signature" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"document_id" uuid NOT NULL,
	"person_id" uuid,
	"signer_tenant_user_id" uuid,
	"signer_name" text NOT NULL,
	"signer_capacity" text NOT NULL,
	"statement" text NOT NULL,
	"document_sha256" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id()
);
--> statement-breakpoint
CREATE TABLE "legal_hold" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid,
	"subject_type" text,
	"subject_id" uuid,
	"reason" text NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"release_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "legal_hold_target" CHECK ("legal_hold"."person_id" IS NOT NULL OR ("legal_hold"."subject_type" IS NOT NULL AND "legal_hold"."subject_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "subject_type" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "status" text DEFAULT 'available' NOT NULL;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "scan_status" text DEFAULT 'not_scanned' NOT NULL;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "destroyed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_signature" ADD CONSTRAINT "document_signature_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_signature" ADD CONSTRAINT "document_signature_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_signature" ADD CONSTRAINT "document_signature_signer_fk" FOREIGN KEY ("tenant_id","signer_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "destruction_certificate_executed_idx" ON "destruction_certificate" USING btree ("tenant_id","executed_at");--> statement-breakpoint
CREATE INDEX "document_signature_document_idx" ON "document_signature" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE INDEX "legal_hold_active_idx" ON "legal_hold" USING btree ("tenant_id","released_at");--> statement-breakpoint
CREATE INDEX "document_person_idx" ON "document" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE INDEX "document_subject_idx" ON "document" USING btree ("tenant_id","subject_type","subject_id");