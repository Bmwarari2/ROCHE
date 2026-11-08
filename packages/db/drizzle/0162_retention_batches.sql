CREATE TABLE "destruction_batch" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"record_class" text NOT NULL,
	"rule" jsonb NOT NULL,
	"item_count" integer NOT NULL,
	"tables" jsonb NOT NULL,
	"proposed_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "destruction_batch_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "destruction_batch_status" CHECK ("destruction_batch"."status" IN ('proposed', 'cancelled')),
	CONSTRAINT "destruction_batch_count" CHECK ("destruction_batch"."item_count" > 0),
	CONSTRAINT "destruction_batch_cancelled" CHECK (("destruction_batch"."status" = 'cancelled') = ("destruction_batch"."cancelled_at" IS NOT NULL)
        AND ("destruction_batch"."cancelled_at" IS NULL) = ("destruction_batch"."cancelled_by" IS NULL)
        AND ("destruction_batch"."cancelled_at" IS NULL) = ("destruction_batch"."cancel_reason" IS NULL)
        AND ("destruction_batch"."cancel_reason" IS NULL OR "destruction_batch"."cancel_reason" IN ('records_still_needed', 'rule_under_review', 'proposed_in_error', 'other')))
);
--> statement-breakpoint
CREATE TABLE "destruction_batch_item" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"batch_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"record_id" uuid NOT NULL,
	"record_class" text NOT NULL,
	"trigger_on" date,
	"due_on" date NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "destruction_batch_item_record_key" UNIQUE("batch_id","table_name","record_id"),
	CONSTRAINT "destruction_batch_item_subject_kind" CHECK ("destruction_batch_item"."subject_kind" IN ('person', 'applicant', 'none')),
	CONSTRAINT "destruction_batch_item_subject_ids" CHECK ("destruction_batch_item"."subject_kind" <> 'none' OR cardinality("destruction_batch_item"."subject_ids") = 0)
);
--> statement-breakpoint
ALTER TABLE "retention_report" DROP CONSTRAINT "retention_report_mode";--> statement-breakpoint
ALTER TABLE "destruction_batch" ADD CONSTRAINT "destruction_batch_cancelled_by_fk" FOREIGN KEY ("tenant_id","cancelled_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destruction_batch_item" ADD CONSTRAINT "destruction_batch_item_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."destruction_batch"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "destruction_batch_list_idx" ON "destruction_batch" USING btree ("tenant_id","status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "destruction_batch_one_proposed" ON "destruction_batch" USING btree ("tenant_id","record_class") WHERE status = 'proposed';--> statement-breakpoint
CREATE INDEX "destruction_batch_item_record_idx" ON "destruction_batch_item" USING btree ("tenant_id","table_name","record_id");--> statement-breakpoint
ALTER TABLE "retention_report" ADD CONSTRAINT "retention_report_mode" CHECK ("retention_report"."mode" IN ('report', 'propose'));--> statement-breakpoint
-- Destruction batches in propose mode (retention sweeps plan 5.4 and 5.5, slice 6; ADR-0135): the
-- ADR-0002 patterns. Only the system (the nightly sweep, no user, tenant-wide) proposes a batch and
-- its items; reading is a records-management decision, so tenant-wide scope only, as for the
-- report, legal holds and certificates; a cancel is a tenant-wide holder of
-- platform.retention.manage's own. Nothing here soft-deletes or destroys a record.
ALTER TABLE public.destruction_batch ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.destruction_batch FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.destruction_batch_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.destruction_batch_item FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.destruction_batch AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.destruction_batch_item AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_wide_only ON public.destruction_batch AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner, harbour_platform_definer, harbour_care_definer,
    harbour_workforce_definer, harbour_scheduling_definer, harbour_finance_definer
  USING (app.current_scope() = 'tenant') WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint
CREATE POLICY tenant_wide_only ON public.destruction_batch_item AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner, harbour_platform_definer, harbour_care_definer,
    harbour_workforce_definer, harbour_scheduling_definer, harbour_finance_definer
  USING (app.current_scope() = 'tenant') WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint
-- Proposed by the system only, never by a person (nor by the migrator acting as one), and only as
-- proposed. Restrictive policies hold harbour_app and harbour_owner (ADR-0002), and with
-- harbour_owner every context definer (ADR-0133).
CREATE POLICY destruction_batch_propose ON public.destruction_batch AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner, harbour_platform_definer, harbour_care_definer,
    harbour_workforce_definer, harbour_scheduling_definer, harbour_finance_definer
  WITH CHECK (app.is_system() AND status = 'proposed');
--> statement-breakpoint
CREATE POLICY destruction_batch_item_propose ON public.destruction_batch_item AS RESTRICTIVE
  FOR INSERT TO harbour_app, harbour_owner, harbour_platform_definer, harbour_care_definer,
    harbour_workforce_definer, harbour_scheduling_definer, harbour_finance_definer
  WITH CHECK (app.is_system());
--> statement-breakpoint
-- Cancelled by a holder of platform.retention.manage, in their own name.
CREATE POLICY destruction_batch_decide ON public.destruction_batch AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner, harbour_platform_definer, harbour_care_definer,
    harbour_workforce_definer, harbour_scheduling_definer, harbour_finance_definer
  USING (app.holds_permission_at('platform.retention.manage', NULL))
  WITH CHECK (app.holds_permission_at('platform.retention.manage', NULL)
    AND cancelled_by = app.current_user_id());
--> statement-breakpoint
-- The batch guard: what was proposed never changes; proposed moves once, to cancelled.
CREATE OR REPLACE FUNCTION app.destruction_batch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.record_class, NEW.rule, NEW.item_count, NEW.tables, NEW.proposed_at)
     IS DISTINCT FROM (OLD.record_class, OLD.rule, OLD.item_count, OLD.tables, OLD.proposed_at) THEN
    RAISE EXCEPTION 'A destruction batch''s proposal never changes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'proposed' AND NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A decided destruction batch never changes' USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER destruction_batch_guard BEFORE UPDATE ON public.destruction_batch
  FOR EACH ROW EXECUTE FUNCTION app.destruction_batch_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.destruction_batch
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.destruction_batch
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.destruction_batch
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON public.destruction_batch
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.destruction_batch_item
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.destruction_batch_item
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.destruction_batch FROM harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.destruction_batch TO harbour_app;
--> statement-breakpoint
GRANT UPDATE (status, cancelled_at, cancelled_by, cancel_reason) ON public.destruction_batch TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.destruction_batch_item FROM harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.destruction_batch_item TO harbour_app;
--> statement-breakpoint
-- Migration 0160 gave retention_report's tenant-wide-only policy to harbour_app alone; ADR-0002
-- has restrictive policies hold harbour_owner too (as legal_hold and destruction_certificate do,
-- migration 0010), and ADR-0133 every context definer with it. Security review of slice 6, L1.
ALTER POLICY tenant_wide_only ON public.retention_report
  TO harbour_app, harbour_owner, harbour_platform_definer, harbour_care_definer,
    harbour_workforce_definer, harbour_scheduling_definer, harbour_finance_definer;
