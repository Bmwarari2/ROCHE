CREATE TABLE "member_device_key" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"device_id" uuid NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "member_device_key_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "member_device_key_shape" CHECK (public_key ~ '^[A-Za-z0-9+/]{86}[AEIMQUYcgkosw048]=$')
);
--> statement-breakpoint
ALTER TABLE "controlled_drug_witness_assertion" ADD COLUMN "method" text DEFAULT 'step_up' NOT NULL;--> statement-breakpoint
ALTER TABLE "controlled_drug_witness_assertion" ADD COLUMN "device_key_id" uuid;--> statement-breakpoint
ALTER TABLE "controlled_drug_witness_assertion" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "controlled_drug_witness_assertion" ADD COLUMN "signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "member_device_key" ADD CONSTRAINT "member_device_key_binding_fk" FOREIGN KEY ("tenant_id","device_id","tenant_user_id") REFERENCES "public"."device_binding"("tenant_id","device_id","tenant_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_device_key_member_idx" ON "member_device_key" USING btree ("tenant_id","device_id","tenant_user_id","enrolled_at");--> statement-breakpoint
ALTER TABLE "controlled_drug_witness_assertion" ADD CONSTRAINT "controlled_drug_witness_assertion_device_key_fk" FOREIGN KEY ("tenant_id","device_key_id") REFERENCES "public"."member_device_key"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_witness_assertion" ADD CONSTRAINT "controlled_drug_witness_assertion_method" CHECK ((method = 'step_up' AND device_key_id IS NULL AND signature IS NULL AND signed_at IS NULL)
       OR (method = 'device_factor' AND device_key_id IS NOT NULL AND signature IS NOT NULL AND signed_at IS NOT NULL));--> statement-breakpoint
-- Device signing keys (ADR-0084; Phase 2 slice 70): the ADR-0002 patterns. A member enrols only
-- their own key, in their own session on a device bound to them; reads are their own keys, or the
-- system's view when the API verifies a witness's signature (withSystemRights). Append-only: a new
-- PIN is a new row.
ALTER TABLE public.member_device_key ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.member_device_key FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.member_device_key AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY member_device_key_scope ON public.member_device_key AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner, harbour_care_definer, harbour_finance_definer,
    harbour_platform_definer, harbour_scheduling_definer, harbour_workforce_definer
  USING (tenant_user_id = app.current_user_id()
    OR (app.current_user_id() IS NULL AND app.current_scope() = 'tenant'));
--> statement-breakpoint
CREATE POLICY member_device_key_own_insert ON public.member_device_key AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner, harbour_care_definer, harbour_finance_definer,
    harbour_platform_definer, harbour_scheduling_definer, harbour_workforce_definer
  WITH CHECK (tenant_user_id = app.current_user_id());
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.member_device_key
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.member_device_key
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON public.member_device_key TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.member_device_key FROM harbour_app;

--> statement-breakpoint
-- A dose recorded on a phone and refused gets a server copy too (slice 70; HZ-115, HZ-004).
ALTER TABLE "refused_entry" DROP CONSTRAINT "refused_entry_table";--> statement-breakpoint
ALTER TABLE "refused_entry" ADD CONSTRAINT "refused_entry_table" CHECK (record_table IN ('care_note', 'observation', 'body_map_mark', 'activity_record', 'visit_log', 'medication_administration'));
--> statement-breakpoint
-- The services each home runs reach the phone (stream `my_location_services`), so it applies the
-- same controlled drugs witness policy as the API before a dose (medicines.md rule 27; HZ-116):
-- "no one is here to witness" is offered only where every active service allows it. No personal
-- data. The sync role reads it for replication only, the 0147 pattern.
CREATE POLICY sync_replication_read ON public.service AS PERMISSIVE FOR SELECT TO harbour_sync
  USING (true);
--> statement-breakpoint
GRANT SELECT ON public.service TO harbour_sync;
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE public.service;
