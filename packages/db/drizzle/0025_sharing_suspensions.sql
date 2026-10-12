CREATE TABLE "sharing_decision_suspension" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"sharing_decision_id" uuid NOT NULL,
	"suspended_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	"lifted_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sharing_decision_suspension_period" CHECK (lifted_at IS NULL OR lifted_at > suspended_at),
	CONSTRAINT "sharing_decision_suspension_lifted" CHECK ((lifted_at IS NULL) = (lifted_reason IS NULL))
);
--> statement-breakpoint
ALTER TABLE "sharing_decision" DROP CONSTRAINT "sharing_decision_sections";--> statement-breakpoint
ALTER TABLE "sharing_decision" ADD COLUMN "authority_order_sections" text[];--> statement-breakpoint
ALTER TABLE "sharing_decision_suspension" ADD CONSTRAINT "sharing_decision_suspension_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharing_decision_suspension" ADD CONSTRAINT "sharing_decision_suspension_decision_fk" FOREIGN KEY ("tenant_id","person_id","sharing_decision_id") REFERENCES "public"."sharing_decision"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharing_decision_suspension" ADD CONSTRAINT "sharing_decision_suspension_lifted_by_fk" FOREIGN KEY ("tenant_id","lifted_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sharing_decision_suspension_open_key" ON "sharing_decision_suspension" USING btree ("tenant_id","sharing_decision_id") WHERE lifted_at IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "sharing_decision_suspension_decision_idx" ON "sharing_decision_suspension" USING btree ("tenant_id","sharing_decision_id");--> statement-breakpoint
ALTER TABLE "sharing_decision" ADD CONSTRAINT "sharing_decision_order_sections" CHECK ((authority_order_sections IS NULL OR (cardinality(authority_order_sections) > 0
        AND authority_order_sections <@ ARRAY['about_me', 'daily_updates', 'photos', 'activities_and_visits', 'care_plan', 'health_summary', 'medicines', 'appointments', 'finance', 'benefits', 'documents']::text[]))
        AND (authority_role IS NULL
          OR authority_role NOT IN ('deputy_personal_welfare', 'deputy_property_affairs')
          OR authority_order_sections IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sharing_decision" ADD CONSTRAINT "sharing_decision_sections" CHECK (cardinality(sections) > 0 AND sections <@ ARRAY['about_me', 'daily_updates', 'photos', 'activities_and_visits', 'care_plan', 'health_summary', 'medicines', 'appointments', 'finance', 'benefits', 'documents']::text[]);--> statement-breakpoint

-- Sharing suspensions as periods (people.md rule 13; comms.md rules 2 and 5; HZ-022). The ADR-0002
-- patterns of migration 0021: forced row-level security, the tenant policy, the person's scope,
-- versioning and grants without DELETE. Runs as harbour_owner.
ALTER TABLE public.sharing_decision_suspension ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sharing_decision_suspension FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.sharing_decision_suspension AS PERMISSIVE FOR ALL
  TO PUBLIC USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY person_child_scope ON public.sharing_decision_suspension AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.person_visible(person_id)) WITH CHECK (app.person_visible(person_id));
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.sharing_decision_suspension
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.sharing_decision_suspension
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.sharing_decision_suspension TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.sharing_decision_suspension FROM harbour_app;
--> statement-breakpoint

-- backfill: begin
-- A decision suspended before this migration gets its open period, from when it was suspended.
-- No tenant is set while migrating, so FORCE is lifted for this statement only.
ALTER TABLE public.sharing_decision NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sharing_decision_suspension NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO public.sharing_decision_suspension (tenant_id, person_id, sharing_decision_id,
    suspended_at, reason, created_by, updated_by, created_at, updated_at)
  SELECT d.tenant_id, d.person_id, d.id, d.suspended_at, d.suspended_reason, d.updated_by,
    d.updated_by, d.updated_at, d.updated_at
  FROM public.sharing_decision d
  WHERE d.suspended_at IS NOT NULL AND d.deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE public.sharing_decision FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sharing_decision_suspension FORCE ROW LEVEL SECURITY;
-- backfill: end
