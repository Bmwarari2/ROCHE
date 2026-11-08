CREATE TABLE "retention_report" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"mode" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"tables_read" integer NOT NULL,
	"tables_skipped" integer NOT NULL,
	"lines" jsonb NOT NULL,
	"totals" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "retention_report_mode" CHECK ("retention_report"."mode" IN ('report')),
	CONSTRAINT "retention_report_counts" CHECK ("retention_report"."duration_ms" >= 0 AND "retention_report"."tables_read" >= 0 AND "retention_report"."tables_skipped" >= 0)
);
--> statement-breakpoint
CREATE INDEX "retention_report_latest_idx" ON "retention_report" USING btree ("tenant_id","as_of");--> statement-breakpoint
-- The retention report (retention sweeps plan slice 4; ADR-0135): the ADR-0002 patterns. Counts
-- only. The worker writes it as the system in each organisation's context; reading it is a
-- records-management decision, so tenant-wide scope only, as for legal holds and certificates.
-- Append-only: each run is a new row.
ALTER TABLE public.retention_report ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.retention_report FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.retention_report AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_wide_only ON public.retention_report AS RESTRICTIVE FOR ALL TO harbour_app
  USING (app.current_scope() = 'tenant') WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.retention_report
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.retention_report
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON public.retention_report TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.retention_report FROM harbour_app;
