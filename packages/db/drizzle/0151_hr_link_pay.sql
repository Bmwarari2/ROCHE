CREATE TABLE "hr_pay_period" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"hr_id" text NOT NULL,
	"frequency" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hr_pay_period_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "hr_pay_period_values" CHECK (hr_id ~ '^[A-Za-z0-9_-]{1,64}$' AND frequency IN ('weekly', 'monthly')
        AND ends_on >= starts_on AND ends_on - starts_on <= 30)
);
--> statement-breakpoint
CREATE TABLE "hr_pay_rate" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"hourly_pence" integer NOT NULL,
	"effective_from" date NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hr_pay_rate_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "hr_pay_rate_values" CHECK (hourly_pence BETWEEN 1 AND 100000)
);
--> statement-breakpoint
CREATE TABLE "hr_pay_unit" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"run_id" uuid NOT NULL,
	"hr_pay_period_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"unit_kind" text NOT NULL,
	"quantity" numeric(10, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "hr_pay_unit_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "hr_pay_unit_kind_key" UNIQUE("tenant_id","run_id","member_id","unit_kind"),
	CONSTRAINT "hr_pay_unit_values" CHECK (unit_kind ~ '^(hours(_(bank_holiday|night|overtime|weekend))*|sleep_in|on_call|mileage)$'
        AND quantity > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_pay_rate" ADD CONSTRAINT "hr_pay_rate_staff_profile_fk" FOREIGN KEY ("tenant_id","staff_profile_id") REFERENCES "public"."staff_profile"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_pay_unit" ADD CONSTRAINT "hr_pay_unit_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."pay_run"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_pay_unit" ADD CONSTRAINT "hr_pay_unit_period_fk" FOREIGN KEY ("tenant_id","hr_pay_period_id") REFERENCES "public"."hr_pay_period"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_pay_unit" ADD CONSTRAINT "hr_pay_unit_member_fk" FOREIGN KEY ("tenant_id","member_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_pay_period_hr_key" ON "hr_pay_period" USING btree ("tenant_id","hr_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_pay_period_start_key" ON "hr_pay_period" USING btree ("tenant_id","frequency","starts_on") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_pay_rate_from_key" ON "hr_pay_rate" USING btree ("tenant_id","staff_profile_id","effective_from") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "hr_pay_unit_period_idx" ON "hr_pay_unit" USING btree ("tenant_id","hr_pay_period_id");--> statement-breakpoint
-- Security (slice 89; ADR-0131; HZ-133, HZ-140). Every table: forced RLS and the tenant policy.
-- Thapsus-HR's pay periods and rates are written by the link's sync alone and read by pay
-- holders (periods also by the link's readers); the units are written once, by the system, for
-- a locked pay run, and never change.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hr_pay_period', 'hr_pay_rate', 'hr_pay_unit'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
    EXECUTE format(
      'CREATE POLICY hr_pay_sync_insert ON public.%I AS RESTRICTIVE FOR INSERT TO harbour_app, harbour_owner '
      'WITH CHECK (app.is_system())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hr_pay_period', 'hr_pay_rate'] LOOP
    EXECUTE format(
      'CREATE POLICY hr_pay_sync_update ON public.%I AS RESTRICTIVE FOR UPDATE TO harbour_app, harbour_owner '
      'USING (app.is_system()) WITH CHECK (app.is_system())', t);
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE POLICY hr_pay_period_read ON public.hr_pay_period AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.is_system() OR app.reads_pay()
    OR app.holds_staff_permission('integrations.hr_link.read')
    OR app.holds_staff_permission('integrations.hr_link.review')
    OR app.holds_staff_permission('integrations.hr_link.manage'));
--> statement-breakpoint
-- Hourly rates are pay: pay holders only (rule 11).
CREATE POLICY hr_pay_rate_read ON public.hr_pay_rate AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.is_system() OR app.reads_pay());
--> statement-breakpoint
CREATE POLICY hr_pay_unit_read ON public.hr_pay_unit AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.is_system() OR app.reads_pay());
--> statement-breakpoint
-- Units only for a locked run: what a person checked and locked is what goes out.
CREATE POLICY hr_pay_unit_locked ON public.hr_pay_unit AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.pay_run_status(run_id) = 'locked');
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.hr_pay_unit
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.hr_pay_unit
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
-- Earlier versions of periods and rates are read as the rows are.
CREATE POLICY record_version_hr_pay ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (table_name NOT IN ('hr_pay_period', 'hr_pay_rate')
    OR app.is_system() OR app.reads_pay()
    OR (table_name = 'hr_pay_period' AND (
      app.holds_staff_permission('integrations.hr_link.read')
      OR app.holds_staff_permission('integrations.hr_link.review')
      OR app.holds_staff_permission('integrations.hr_link.manage'))));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.hr_pay_period, public.hr_pay_rate TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.hr_pay_unit TO harbour_app;
