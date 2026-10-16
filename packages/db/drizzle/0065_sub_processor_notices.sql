CREATE TABLE "sub_processor_notice" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"sub_processor_key" text NOT NULL,
	"kind" text NOT NULL,
	"use" jsonb NOT NULL,
	"announced_at" timestamp with time zone NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sub_processor_notice_kind" CHECK (kind IN ('new', 'replacement')),
	CONSTRAINT "sub_processor_notice_dates" CHECK (effective_from >= announced_at),
	CONSTRAINT "sub_processor_notice_use" CHECK (use ->> 'kind' IN ('always', 'capability', 'ai_provider'))
);
--> statement-breakpoint
CREATE TABLE "sub_processor_response" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"sub_processor_key" text NOT NULL,
	"notice_id" uuid,
	"kind" text NOT NULL,
	"grounds" text,
	"resolution" text,
	"responded_by" uuid DEFAULT app.current_user_id(),
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sub_processor_response_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "sub_processor_response_kind" CHECK (CASE kind
        WHEN 'acknowledged' THEN grounds IS NULL AND resolution IS NULL AND responded_by IS NOT NULL
        WHEN 'objected' THEN notice_id IS NOT NULL AND char_length(btrim(grounds)) BETWEEN 20 AND 4000
          AND resolution IS NULL AND responded_by IS NOT NULL
        WHEN 'objection_resolved' THEN notice_id IS NOT NULL AND grounds IS NULL
          AND resolution IN ('objection_withdrawn', 'not_used_for_tenant', 'services_ended')
        ELSE false END)
);
--> statement-breakpoint
ALTER TABLE "sub_processor_response" ADD CONSTRAINT "sub_processor_response_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_processor_response" ADD CONSTRAINT "sub_processor_response_notice_id_sub_processor_notice_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."sub_processor_notice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_processor_response" ADD CONSTRAINT "sub_processor_response_by_fk" FOREIGN KEY ("tenant_id","responded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sub_processor_notice_key_idx" ON "sub_processor_notice" USING btree ("sub_processor_key","announced_at");--> statement-breakpoint
CREATE INDEX "sub_processor_response_key_idx" ON "sub_processor_response" USING btree ("tenant_id","sub_processor_key","responded_at");--> statement-breakpoint

-- Sub-processor notices are Thapsus's and the same for every organisation (rules 24 and 25):
-- everyone reads them, only the operator role announces one, and none changes once announced.
ALTER TABLE public.sub_processor_notice ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sub_processor_notice FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notice_read ON public.sub_processor_notice AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (true);
--> statement-breakpoint
CREATE POLICY notice_announce ON public.sub_processor_notice AS PERMISSIVE FOR INSERT
  TO harbour_operator, harbour_owner WITH CHECK (true);
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.sub_processor_notice
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.sub_processor_notice
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.sub_processor_notice FROM harbour_app;
--> statement-breakpoint
GRANT SELECT ON public.sub_processor_notice TO harbour_app, harbour_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.sub_processor_notice TO harbour_operator;
--> statement-breakpoint

-- An organisation's responses: append-only, read with a DPIA or onboarding permission, and
-- written by the application only as the named data protection lead holding platform.dpia.sign
-- through a role, in their own name, acknowledging or objecting. Thapsus records how an
-- objection was resolved (the operator role, with the organisation's tenant in its context).
ALTER TABLE public.sub_processor_response ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sub_processor_response FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.sub_processor_response AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY response_read ON public.sub_processor_response AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (app.holds_role_permission_somewhere('platform.dpia.read')
    OR app.holds_role_permission_somewhere('platform.dpia.prepare')
    OR app.holds_role_permission_somewhere('platform.dpia.sign')
    OR app.holds_role_permission_somewhere('platform.onboarding.read')
    OR app.holds_role_permission_somewhere('platform.onboarding.manage'));
--> statement-breakpoint
CREATE POLICY response_write ON public.sub_processor_response AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (kind IN ('acknowledged', 'objected')
    AND responded_by = app.current_user_id()
    AND responded_by IS NOT DISTINCT FROM (SELECT t.data_protection_lead_id FROM public.tenant t
                                           WHERE t.id = sub_processor_response.tenant_id)
    AND app.holds_role_permission_somewhere('platform.dpia.sign'));
--> statement-breakpoint
CREATE POLICY response_resolution ON public.sub_processor_response AS RESTRICTIVE FOR INSERT
  TO harbour_operator
  WITH CHECK (kind = 'objection_resolved' AND responded_by IS NULL);
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.sub_processor_response
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.sub_processor_response
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON public.sub_processor_response TO harbour_app, harbour_operator;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.sub_processor_response FROM harbour_app, harbour_operator;
