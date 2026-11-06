CREATE TABLE "payroll_connection" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"provider" text NOT NULL,
	"external_organisation_id" text NOT NULL,
	"secret_ref" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"connected_by" uuid NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "payroll_connection_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_connection_provider" CHECK (provider IN ('xero_payroll_uk')),
	CONSTRAINT "payroll_connection_status" CHECK (status IN ('connected', 'disconnected')),
	CONSTRAINT "payroll_connection_disconnected" CHECK ((status = 'disconnected') = (disconnected_at IS NOT NULL)),
	CONSTRAINT "payroll_connection_external_id" CHECK (external_organisation_id ~ '^[A-Za-z0-9-]{1,64}$'),
	CONSTRAINT "payroll_connection_secret_ref" CHECK (secret_ref = 'payroll/' || tenant_id::text || '/' || provider || '/' || id::text)
);
--> statement-breakpoint
CREATE TABLE "payroll_export" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"run_id" uuid NOT NULL,
	"calculation" integer NOT NULL,
	"format" text NOT NULL,
	"format_version" integer NOT NULL,
	"line_count" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"reexport" boolean DEFAULT false NOT NULL,
	"outcome" text NOT NULL,
	"payroll_references" jsonb NOT NULL,
	"exported_by" uuid NOT NULL,
	"exported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_export_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_export_format" CHECK (format IN ('xero_payroll_uk', 'staffology_csv', 'sage_csv', 'brightpay_csv')),
	CONSTRAINT "payroll_export_outcome" CHECK (outcome IN ('generated', 'pending')),
	CONSTRAINT "payroll_export_hash" CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "payroll_export_counts" CHECK (line_count >= 0 AND format_version >= 1 AND calculation >= 1),
	CONSTRAINT "payroll_export_references" CHECK (jsonb_typeof(payroll_references) = 'object')
);
--> statement-breakpoint
CREATE TABLE "payroll_export_result" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"export_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"external_ref" text,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_export_result_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_export_result_outcome" CHECK (outcome IN ('sent', 'failed', 'unknown')),
	CONSTRAINT "payroll_export_result_external_ref" CHECK ((external_ref IS NULL OR external_ref ~ '^[A-Za-z0-9-]{1,64}$') AND (external_ref IS NULL OR outcome = 'sent'))
);
--> statement-breakpoint
ALTER TABLE "pay_profile" ADD COLUMN "payroll_reference" text;--> statement-breakpoint
ALTER TABLE "payroll_connection" ADD CONSTRAINT "payroll_connection_connected_by_fk" FOREIGN KEY ("tenant_id","connected_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_export" ADD CONSTRAINT "payroll_export_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."pay_run"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_export" ADD CONSTRAINT "payroll_export_exported_by_fk" FOREIGN KEY ("tenant_id","exported_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_export_result" ADD CONSTRAINT "payroll_export_result_export_fk" FOREIGN KEY ("tenant_id","export_id") REFERENCES "public"."payroll_export"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_export_result" ADD CONSTRAINT "payroll_export_result_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_connection_live_key" ON "payroll_connection" USING btree ("tenant_id","provider") WHERE status = 'connected' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "payroll_export_run_idx" ON "payroll_export" USING btree ("tenant_id","run_id","exported_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_export_result_export_key" ON "payroll_export_result" USING btree ("tenant_id","export_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_profile_payroll_reference_key" ON "pay_profile" USING btree ("tenant_id","payroll_reference") WHERE payroll_reference IS NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_profile" ADD CONSTRAINT "pay_profile_payroll_reference" CHECK (payroll_reference IS NULL OR (payroll_reference ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$' AND payroll_reference ~ '[0-9]' AND payroll_reference !~* '^[a-z]{2}[0-9]{6}[a-d]?$'));

--> statement-breakpoint

-- Payroll and pension exports (scheduling.md section 19; SCHED-008; ADR-0013, ADR-0097). Forced
-- RLS with the tenant policy on both tables (ADR-0002). Only holders of finance.payroll.export
-- across the organisation (as pay, section 18 rule 13) connect a provider or export, and an export
-- also needs the right to read pay. Only a locked run's current calculation is exported; whether it
-- is a re-export is the database's to say, one export of a run at a time. Exports and their
-- results are append-only. A connection's secret is named by the database, never by a caller.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_connection', 'payroll_export', 'payroll_export_result'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE POLICY payroll_connection_read ON public.payroll_connection AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.holds_pay_permission('finance.payroll.export'));
--> statement-breakpoint
CREATE POLICY payroll_connection_insert ON public.payroll_connection AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.holds_pay_permission('finance.payroll.export')
    AND connected_by = app.current_user_id() AND status = 'connected');
--> statement-breakpoint
CREATE POLICY payroll_connection_update ON public.payroll_connection AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (app.holds_pay_permission('finance.payroll.export'))
  WITH CHECK (app.holds_pay_permission('finance.payroll.export'));
--> statement-breakpoint
-- A connection keeps its provider, organisation, secret and who connected it; it only moves from
-- connected to disconnected, once, at the database's time.
CREATE OR REPLACE FUNCTION app.payroll_connection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.external_organisation_id IS DISTINCT FROM OLD.external_organisation_id
     OR NEW.secret_ref IS DISTINCT FROM OLD.secret_ref
     OR NEW.connected_by IS DISTINCT FROM OLD.connected_by
     OR NEW.connected_at IS DISTINCT FROM OLD.connected_at
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'payroll_connection_fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'disconnected' THEN
    RAISE EXCEPTION 'payroll_connection_disconnected' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'disconnected' THEN
    NEW.disconnected_at := now();
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payroll_connection_guard BEFORE UPDATE ON public.payroll_connection
  FOR EACH ROW EXECUTE FUNCTION app.payroll_connection_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_connection_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- The organisation's own secret: a caller cannot point a connection at another's tokens.
  NEW.secret_ref := 'payroll/' || NEW.tenant_id::text || '/' || NEW.provider || '/' || NEW.id::text;
  NEW.connected_at := now();
  NEW.disconnected_at := NULL;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payroll_connection_insert_guard BEFORE INSERT ON public.payroll_connection
  FOR EACH ROW EXECUTE FUNCTION app.payroll_connection_insert_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.payroll_connection
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.payroll_connection
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.payroll_connection
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- One key per organisation and run, for pg_advisory_xact_lock: the API takes it before checking
-- for an earlier export, and the guard again before deciding (it is re-entrant).
CREATE OR REPLACE FUNCTION app.payroll_export_lock_key(p_tenant uuid, p_run uuid) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT hashtextextended('payroll_export:' || p_tenant::text || ':' || p_run::text, 0)
$$;
--> statement-breakpoint
CREATE POLICY payroll_export_read ON public.payroll_export AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.holds_pay_permission('finance.payroll.export') AND app.reads_pay());
--> statement-breakpoint
CREATE POLICY payroll_export_insert ON public.payroll_export AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.holds_pay_permission('finance.payroll.export') AND app.reads_pay()
    AND exported_by = app.current_user_id());
--> statement-breakpoint
-- Rules 1, 6 and 8: only a locked run's current calculation; whether it is a re-export is decided
-- here, under a lock on the run so two exports at once cannot both be first; an API export needs
-- the organisation's live connection and starts pending; a file is generated.
CREATE OR REPLACE FUNCTION app.payroll_export_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(app.payroll_export_lock_key(NEW.tenant_id, NEW.run_id));
  IF app.pay_run_status(NEW.run_id) IS DISTINCT FROM 'locked'
     OR NEW.calculation IS DISTINCT FROM app.pay_run_calculation(NEW.run_id) THEN
    RAISE EXCEPTION 'payroll_export_not_locked' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.format = 'xero_payroll_uk' AND NOT EXISTS (
      SELECT 1 FROM public.payroll_connection c
      WHERE c.tenant_id = NEW.tenant_id AND c.provider = 'xero_payroll_uk'
        AND c.status = 'connected' AND c.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'payroll_export_not_connected' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.outcome IS DISTINCT FROM
     (CASE WHEN NEW.format = 'xero_payroll_uk' THEN 'pending' ELSE 'generated' END) THEN
    RAISE EXCEPTION 'payroll_export_outcome' USING ERRCODE = 'check_violation';
  END IF;
  -- Anything before, unless it is known to have failed: a pending or unknown send counts.
  NEW.reexport := EXISTS (
    SELECT 1 FROM public.payroll_export e
    WHERE e.tenant_id = NEW.tenant_id AND e.run_id = NEW.run_id
      AND e.calculation = NEW.calculation
      AND NOT EXISTS (
        SELECT 1 FROM public.payroll_export_result r
        WHERE r.tenant_id = e.tenant_id AND r.export_id = e.id AND r.outcome = 'failed'));
  NEW.exported_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payroll_export_guard BEFORE INSERT ON public.payroll_export
  FOR EACH ROW EXECUTE FUNCTION app.payroll_export_guard();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.payroll_export
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.payroll_export
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE POLICY payroll_export_result_read ON public.payroll_export_result AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.holds_pay_permission('finance.payroll.export') AND app.reads_pay());
--> statement-breakpoint
CREATE POLICY payroll_export_result_insert ON public.payroll_export_result AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.holds_pay_permission('finance.payroll.export') AND app.reads_pay()
    AND recorded_by = app.current_user_id());
--> statement-breakpoint
-- Rule 8: a result only for an API export, once (the unique index), at the database's time.
CREATE OR REPLACE FUNCTION app.payroll_export_result_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM public.payroll_export e
      WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.export_id AND e.outcome = 'pending') THEN
    RAISE EXCEPTION 'payroll_export_result_not_pending' USING ERRCODE = 'check_violation';
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payroll_export_result_guard BEFORE INSERT ON public.payroll_export_result
  FOR EACH ROW EXECUTE FUNCTION app.payroll_export_result_guard();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.payroll_export_result
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.payroll_export_result
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.payroll_connection TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.payroll_export TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.payroll_export_result TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.payroll_connection FROM harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.payroll_export FROM harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.payroll_export_result FROM harbour_app;
