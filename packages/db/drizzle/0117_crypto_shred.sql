-- Per-organisation crypto-shredding (PLAT-012; platform.md, Crypto-shredding; ADR-0109).
-- Destruction certificates gain their signature, the key versions a shred destroyed, the date
-- backups no longer hold deleted rows, and the two people of a shred. A whole-organisation shred
-- waits in tenant_shred_request for a second person. Expand only: every new certificate column is
-- nullable or defaulted, so the previous release keeps writing certificates.

ALTER TABLE "destruction_certificate" ADD COLUMN "body_sha256" text;--> statement-breakpoint
ALTER TABLE "destruction_certificate" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "destruction_certificate" ADD COLUMN "signature_key" text;--> statement-breakpoint
ALTER TABLE "destruction_certificate" ADD COLUMN "signature_algorithm" text;--> statement-breakpoint
ALTER TABLE "destruction_certificate" ADD COLUMN "key_versions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "destruction_certificate" ADD COLUMN "keys_destroyed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "destruction_certificate" ADD COLUMN "backups_expire_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "destruction_certificate" ADD COLUMN "requested_by" uuid;--> statement-breakpoint
ALTER TABLE "destruction_certificate" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "destruction_certificate" ADD CONSTRAINT "destruction_certificate_two_people"
  CHECK (approved_by IS NULL OR requested_by IS NULL OR approved_by <> requested_by);--> statement-breakpoint
ALTER TABLE "destruction_certificate" ADD CONSTRAINT "destruction_certificate_signed"
  CHECK ((signature IS NULL) = (body_sha256 IS NULL) AND (signature IS NULL) = (signature_key IS NULL)
    AND (signature IS NULL) = (signature_algorithm IS NULL)
    AND (body_sha256 IS NULL OR body_sha256 ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "destruction_certificate" ADD CONSTRAINT "destruction_certificate_requested_by_fk"
  FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."tenant_user"("tenant_id","id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destruction_certificate" ADD CONSTRAINT "destruction_certificate_approved_by_fk"
  FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."tenant_user"("tenant_id","id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "tenant_shred_request" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"export_confirmed" boolean NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"certificate_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tenant_shred_request_status" CHECK (status IN ('pending', 'approved', 'cancelled')),
	CONSTRAINT "tenant_shred_request_export" CHECK (export_confirmed),
	CONSTRAINT "tenant_shred_request_reason" CHECK (char_length(btrim(reason)) >= 20),
	CONSTRAINT "tenant_shred_request_two_people" CHECK (status <> 'approved' OR (decided_by IS NOT NULL
	  AND decided_by <> requested_by AND certificate_id IS NOT NULL)),
	CONSTRAINT "tenant_shred_request_cancel" CHECK (status <> 'cancelled' OR decided_by = requested_by)
);
--> statement-breakpoint
ALTER TABLE "tenant_shred_request" ADD CONSTRAINT "tenant_shred_request_tenant_fk" FOREIGN KEY ("tenant_id")
  REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_shred_request" ADD CONSTRAINT "tenant_shred_request_requested_by_fk"
  FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."tenant_user"("tenant_id","id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_shred_request" ADD CONSTRAINT "tenant_shred_request_decided_by_fk"
  FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."tenant_user"("tenant_id","id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_shred_request_one_pending" ON "tenant_shred_request" USING btree ("tenant_id")
  WHERE status = 'pending';--> statement-breakpoint

ALTER TABLE public.tenant_shred_request ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.tenant_shred_request FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.tenant_shred_request AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
-- Records-management decisions: tenant-wide holders of platform.retention.manage only.
CREATE POLICY tenant_shred_request_reach ON public.tenant_shred_request AS RESTRICTIVE FOR ALL
  TO harbour_app
  USING (app.current_scope() = 'tenant' AND app.holds_permission_at('platform.retention.manage', NULL))
  WITH CHECK (app.current_scope() = 'tenant' AND app.holds_permission_at('platform.retention.manage', NULL));
--> statement-breakpoint
-- A request is made pending, in the requester's own name.
CREATE POLICY tenant_shred_request_ask ON public.tenant_shred_request AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (status = 'pending' AND requested_by = app.current_user_id() AND decided_by IS NULL
    AND decided_at IS NULL AND certificate_id IS NULL);
--> statement-breakpoint
-- A decision is the decider's own: approved by someone else, cancelled by the requester.
CREATE POLICY tenant_shred_request_decide ON public.tenant_shred_request AS RESTRICTIVE FOR UPDATE
  TO harbour_app
  USING (status = 'pending')
  WITH CHECK (decided_by = app.current_user_id());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.tenant_shred_request FROM harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.tenant_shred_request TO harbour_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by, decided_at, certificate_id) ON public.tenant_shred_request TO harbour_app;
--> statement-breakpoint

-- The request guard: who asked, why and when never change; pending moves once, to approved or
-- cancelled, and never back.
CREATE OR REPLACE FUNCTION app.tenant_shred_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.tenant_id, NEW.reason, NEW.export_confirmed, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.reason, OLD.export_confirmed, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'A shred request''s requester and reason never change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'A decided shred request never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_shred_request_guard BEFORE UPDATE ON public.tenant_shred_request
  FOR EACH ROW EXECUTE FUNCTION app.tenant_shred_request_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.tenant_shred_request
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.tenant_shred_request
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
