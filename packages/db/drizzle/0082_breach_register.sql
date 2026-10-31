CREATE TABLE "dp_breach" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid,
	"source" text NOT NULL,
	"summary" text NOT NULL,
	"aware_at" timestamp with time zone NOT NULL,
	"occurred_at" timestamp with time zone,
	"factors" jsonb,
	"suggested_severity" text,
	"suggested_report_to_ico" boolean,
	"suggested_tell_individuals" boolean,
	"assessed_by" uuid,
	"assessed_at" timestamp with time zone,
	"report_to_ico" boolean,
	"tell_individuals" boolean,
	"decision_reasoning" text,
	"acknowledged_suggestion" boolean DEFAULT false NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reported_at" timestamp with time zone,
	"ico_reference" text,
	"delay_reason" text,
	"subject_notice" text,
	"individuals_told_on" date,
	"status" text DEFAULT 'open' NOT NULL,
	"lessons" text,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "dp_breach_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "dp_breach_source" CHECK (source IN ('tenant', 'processor_notice')),
	CONSTRAINT "dp_breach_status" CHECK (status IN ('open', 'closed')),
	CONSTRAINT "dp_breach_summary" CHECK (char_length(btrim(summary)) BETWEEN 10 AND 4000),
	CONSTRAINT "dp_breach_assessed" CHECK ((factors IS NULL) = (suggested_severity IS NULL)
        AND (factors IS NULL) = (suggested_report_to_ico IS NULL)
        AND (factors IS NULL) = (suggested_tell_individuals IS NULL)
        AND (factors IS NULL) = (assessed_at IS NULL)
        AND (suggested_severity IS NULL OR suggested_severity IN ('low', 'medium', 'high', 'critical'))),
	CONSTRAINT "dp_breach_decided" CHECK ((decided_at IS NULL) = (report_to_ico IS NULL)
        AND (decided_at IS NULL) = (tell_individuals IS NULL)
        AND (decided_at IS NULL) = (decided_by IS NULL)
        AND (decided_at IS NULL OR (factors IS NOT NULL
          AND char_length(btrim(decision_reasoning)) BETWEEN 20 AND 4000))),
	CONSTRAINT "dp_breach_reported" CHECK ((reported_at IS NULL) = (ico_reference IS NULL)
        AND (reported_at IS NULL OR report_to_ico IS TRUE)
        AND (ico_reference IS NULL OR char_length(btrim(ico_reference)) BETWEEN 1 AND 100)
        AND (delay_reason IS NULL OR char_length(btrim(delay_reason)) BETWEEN 1 AND 4000)),
	CONSTRAINT "dp_breach_individuals" CHECK ((individuals_told_on IS NULL) = (subject_notice IS NULL)
        AND (individuals_told_on IS NULL OR tell_individuals IS TRUE)
        AND (subject_notice IS NULL OR char_length(btrim(subject_notice)) BETWEEN 20 AND 10000)),
	CONSTRAINT "dp_breach_closed" CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL)
        AND (status = 'open' OR (decided_at IS NOT NULL
          AND char_length(btrim(lessons)) BETWEEN 20 AND 4000)))
);
--> statement-breakpoint
CREATE TABLE "dp_complaint" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid,
	"received_on" date NOT NULL,
	"channel" text NOT NULL,
	"complainant_kind" text NOT NULL,
	"complainant_name" text NOT NULL,
	"complainant_contact" text,
	"person_id" uuid,
	"about" text NOT NULL,
	"summary" text NOT NULL,
	"acknowledged_on" date,
	"last_contact_on" date,
	"outcome" text,
	"ico_right_stated" boolean DEFAULT false NOT NULL,
	"breach_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_on" date,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "dp_complaint_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "dp_complaint_channel" CHECK (channel IN ('form', 'email', 'letter', 'phone', 'in_person', 'forwarded_by_thapsus', 'other')),
	CONSTRAINT "dp_complaint_complainant_kind" CHECK (complainant_kind IN ('person_supported', 'representative', 'family', 'staff', 'other')),
	CONSTRAINT "dp_complaint_about" CHECK (about IN ('access', 'accuracy', 'sharing', 'security', 'retention', 'other')),
	CONSTRAINT "dp_complaint_status" CHECK (status IN ('open', 'closed')),
	CONSTRAINT "dp_complaint_text" CHECK (char_length(btrim(complainant_name)) BETWEEN 1 AND 200
        AND (complainant_contact IS NULL OR char_length(btrim(complainant_contact)) BETWEEN 1 AND 500)
        AND char_length(btrim(summary)) BETWEEN 10 AND 4000),
	CONSTRAINT "dp_complaint_dates" CHECK ((acknowledged_on IS NULL OR acknowledged_on >= received_on)
        AND (last_contact_on IS NULL OR last_contact_on >= received_on)
        AND (closed_on IS NULL OR closed_on >= received_on)),
	CONSTRAINT "dp_complaint_closed" CHECK ((status = 'closed') = (closed_on IS NOT NULL AND closed_by IS NOT NULL)
        AND (status = 'open' OR (ico_right_stated
          AND char_length(btrim(outcome)) BETWEEN 20 AND 10000)))
);
--> statement-breakpoint
CREATE TABLE "processor_breach_notice" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"breach_id" uuid NOT NULL,
	"follows_id" uuid,
	"nature" text NOT NULL,
	"data_categories" text NOT NULL,
	"approx_people" integer,
	"approx_records" integer,
	"likely_consequences" text NOT NULL,
	"measures" text NOT NULL,
	"tenant_actions" text NOT NULL,
	"contact" text NOT NULL,
	"sent_by_operator" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processor_breach_notice_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "processor_breach_notice_text" CHECK (char_length(btrim(nature)) BETWEEN 10 AND 4000
        AND char_length(btrim(data_categories)) BETWEEN 3 AND 2000
        AND char_length(btrim(likely_consequences)) BETWEEN 3 AND 4000
        AND char_length(btrim(measures)) BETWEEN 3 AND 4000
        AND char_length(btrim(tenant_actions)) BETWEEN 3 AND 4000
        AND char_length(btrim(contact)) BETWEEN 3 AND 500),
	CONSTRAINT "processor_breach_notice_counts" CHECK ((approx_people IS NULL OR approx_people >= 0)
        AND (approx_records IS NULL OR approx_records >= 0))
);
--> statement-breakpoint
CREATE TABLE "processor_breach_notice_ack" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"notice_id" uuid NOT NULL,
	"acknowledged_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processor_breach_notice_ack_notice_key" UNIQUE("tenant_id","notice_id")
);
--> statement-breakpoint
ALTER TABLE "dp_breach" ADD CONSTRAINT "dp_breach_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dp_breach" ADD CONSTRAINT "dp_breach_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dp_breach" ADD CONSTRAINT "dp_breach_assessed_by_fk" FOREIGN KEY ("tenant_id","assessed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dp_breach" ADD CONSTRAINT "dp_breach_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dp_breach" ADD CONSTRAINT "dp_breach_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dp_complaint" ADD CONSTRAINT "dp_complaint_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dp_complaint" ADD CONSTRAINT "dp_complaint_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dp_complaint" ADD CONSTRAINT "dp_complaint_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dp_complaint" ADD CONSTRAINT "dp_complaint_breach_fk" FOREIGN KEY ("tenant_id","breach_id") REFERENCES "public"."dp_breach"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dp_complaint" ADD CONSTRAINT "dp_complaint_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processor_breach_notice" ADD CONSTRAINT "processor_breach_notice_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processor_breach_notice" ADD CONSTRAINT "processor_breach_notice_follows_id_processor_breach_notice_id_fk" FOREIGN KEY ("follows_id") REFERENCES "public"."processor_breach_notice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processor_breach_notice" ADD CONSTRAINT "processor_breach_notice_breach_fk" FOREIGN KEY ("tenant_id","breach_id") REFERENCES "public"."dp_breach"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processor_breach_notice_ack" ADD CONSTRAINT "processor_breach_notice_ack_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processor_breach_notice_ack" ADD CONSTRAINT "processor_breach_notice_ack_notice_fk" FOREIGN KEY ("tenant_id","notice_id") REFERENCES "public"."processor_breach_notice"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processor_breach_notice_ack" ADD CONSTRAINT "processor_breach_notice_ack_by_fk" FOREIGN KEY ("tenant_id","acknowledged_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dp_breach_open_idx" ON "dp_breach" USING btree ("tenant_id","status","aware_at");--> statement-breakpoint
CREATE INDEX "dp_complaint_open_idx" ON "dp_complaint" USING btree ("tenant_id","status","received_on");--> statement-breakpoint
CREATE INDEX "processor_breach_notice_breach_idx" ON "processor_breach_notice" USING btree ("tenant_id","breach_id","sent_at");
-- Slice 20 (PLAT-022; platform.md rules 18 to 26). Everything below is what Drizzle cannot
-- express: forced row-level security, permission policies, guards on closed records, append-only
-- notices and acknowledgements, grants, record history, and the definer function Thapsus uses to
-- send a processor breach notice. The register and complaints are the organisation's data
-- protection function: whoever holds quality.dsar.manage through a role, anywhere.

-- Breach register entries.
ALTER TABLE public.dp_breach ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.dp_breach FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.dp_breach AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY breach_read ON public.dp_breach AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.holds_role_permission_somewhere('quality.dsar.manage'));
--> statement-breakpoint
CREATE POLICY breach_record ON public.dp_breach AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (source = 'tenant' AND status = 'open'
    AND app.holds_role_permission_somewhere('quality.dsar.manage'));
--> statement-breakpoint
CREATE POLICY breach_change ON public.dp_breach AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.holds_role_permission_somewhere('quality.dsar.manage'))
  WITH CHECK (app.holds_role_permission_somewhere('quality.dsar.manage'));
--> statement-breakpoint
-- Rules 19 and 23: the source never changes; awareness only until the ICO report is recorded; a
-- closed entry never changes.
CREATE OR REPLACE FUNCTION app.dp_breach_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'dp_breach_closed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.source IS DISTINCT FROM OLD.source OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'dp_breach_source_fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.aware_at IS DISTINCT FROM OLD.aware_at AND OLD.reported_at IS NOT NULL THEN
    RAISE EXCEPTION 'dp_breach_aware_at_after_report' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER dp_breach_guard BEFORE UPDATE ON public.dp_breach
  FOR EACH ROW EXECUTE FUNCTION app.dp_breach_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.dp_breach
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.dp_breach
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.dp_breach TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.dp_breach FROM harbour_app;
--> statement-breakpoint

-- Thapsus's notices: read with the register permission, written only by the definer function.
ALTER TABLE public.processor_breach_notice ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.processor_breach_notice FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.processor_breach_notice AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY notice_read ON public.processor_breach_notice AS RESTRICTIVE FOR SELECT
  TO harbour_app USING (app.holds_role_permission_somewhere('quality.dsar.manage'));
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.processor_breach_notice
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.processor_breach_notice
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT ON public.processor_breach_notice TO harbour_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.processor_breach_notice FROM harbour_app;
--> statement-breakpoint

-- Acknowledgements: append-only, once per notice, only in the acknowledger's own name.
ALTER TABLE public.processor_breach_notice_ack ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.processor_breach_notice_ack FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.processor_breach_notice_ack AS PERMISSIVE FOR ALL
  TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY ack_read ON public.processor_breach_notice_ack AS RESTRICTIVE FOR SELECT
  TO harbour_app USING (app.holds_role_permission_somewhere('quality.dsar.manage'));
--> statement-breakpoint
CREATE POLICY ack_write ON public.processor_breach_notice_ack AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (acknowledged_by = app.current_user_id()
    AND app.holds_role_permission_somewhere('quality.dsar.manage'));
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.processor_breach_notice_ack
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.processor_breach_notice_ack
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON public.processor_breach_notice_ack TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.processor_breach_notice_ack FROM harbour_app;
--> statement-breakpoint

-- Data protection complaints.
ALTER TABLE public.dp_complaint ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.dp_complaint FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.dp_complaint AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY complaint_read ON public.dp_complaint AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.holds_role_permission_somewhere('quality.dsar.manage'));
--> statement-breakpoint
CREATE POLICY complaint_record ON public.dp_complaint AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (status = 'open' AND app.holds_role_permission_somewhere('quality.dsar.manage'));
--> statement-breakpoint
CREATE POLICY complaint_change ON public.dp_complaint AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.holds_role_permission_somewhere('quality.dsar.manage'))
  WITH CHECK (app.holds_role_permission_somewhere('quality.dsar.manage'));
--> statement-breakpoint
-- Rule 25: a closed complaint never changes.
CREATE OR REPLACE FUNCTION app.dp_complaint_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'dp_complaint_closed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'dp_complaint_tenant_fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER dp_complaint_guard BEFORE UPDATE ON public.dp_complaint
  FOR EACH ROW EXECUTE FUNCTION app.dp_complaint_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.dp_complaint
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.dp_complaint
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.dp_complaint TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.dp_complaint FROM harbour_app;
--> statement-breakpoint

-- Rule 24: Thapsus sends a processor breach notice. An active admin (the transaction's
-- app.operator_id, checked by app.notice_resolver_admin from migration 0067) stores the notice,
-- opens the organisation's register entry (or links a follow-up to the first notice's entry),
-- and writes the organisation's audit event and an outbox event, in one transaction. Ids only in
-- the audit scope and the event payload.
CREATE OR REPLACE FUNCTION app.send_processor_breach_notice(
  p_tenant uuid, p_follows uuid, p_nature text, p_data_categories text, p_approx_people integer,
  p_approx_records integer, p_likely_consequences text, p_measures text, p_tenant_actions text,
  p_contact text, p_request_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_operator uuid := app.notice_resolver_admin();
  v_auth_user text := (SELECT o.auth_user_id FROM public.operator_user o WHERE o.id = v_operator);
  v_breach uuid;
  v_notice uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenant t WHERE t.id = p_tenant) THEN
    RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  IF p_follows IS NOT NULL THEN
    SELECT n.breach_id INTO v_breach FROM public.processor_breach_notice n
     WHERE n.id = p_follows AND n.tenant_id = p_tenant AND n.follows_id IS NULL;
    IF v_breach IS NULL THEN
      RAISE EXCEPTION 'notice_not_found' USING ERRCODE = 'no_data_found';
    END IF;
  ELSE
    INSERT INTO public.dp_breach (tenant_id, source, summary, aware_at, created_by, updated_by)
    VALUES (p_tenant, 'processor_notice', p_nature, now(), NULL, NULL)
    RETURNING id INTO v_breach;
  END IF;
  INSERT INTO public.processor_breach_notice (tenant_id, breach_id, follows_id, nature,
    data_categories, approx_people, approx_records, likely_consequences, measures, tenant_actions,
    contact, sent_by_operator)
  VALUES (p_tenant, v_breach, p_follows, p_nature, p_data_categories, p_approx_people,
    p_approx_records, p_likely_consequences, p_measures, p_tenant_actions, p_contact, v_operator)
  RETURNING id INTO v_notice;
  INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
    resource_type, resource_id, scope, request_id)
  VALUES (p_tenant, v_auth_user, ARRAY['thapsus_admin'], 'platform.breach.processor_notice_sent',
    'processor_breach_notice', v_notice::text,
    jsonb_build_object('operatorId', v_operator, 'breachId', v_breach, 'followsId', p_follows),
    p_request_id);
  INSERT INTO public.outbox_event (tenant_id, aggregate_type, aggregate_id, event_type, payload)
  VALUES (p_tenant, 'processor_breach_notice', v_notice::text,
    'platform.breach.processor_notice_sent',
    jsonb_build_object('noticeId', v_notice, 'breachId', v_breach));
  RETURN jsonb_build_object('noticeId', v_notice, 'breachId', v_breach);
END
$$;
--> statement-breakpoint
-- What the function needs, through its owner harbour_notice_resolver, and nothing else.
GRANT SELECT (id), INSERT ON public.dp_breach TO harbour_notice_resolver;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, breach_id, follows_id), INSERT ON public.processor_breach_notice
  TO harbour_notice_resolver;
--> statement-breakpoint
-- The ACL is set before the owner changes: the new owner keeps it (ADR-0002).
REVOKE ALL ON FUNCTION app.send_processor_breach_notice(uuid, uuid, text, text, integer, integer,
  text, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.send_processor_breach_notice(uuid, uuid, text, text, integer, integer,
  text, text, text, text, text) FROM harbour_app, harbour_worker, harbour_auth, harbour_sync;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.send_processor_breach_notice(uuid, uuid, text, text, integer,
  integer, text, text, text, text, text) TO harbour_operator;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_notice_resolver;
--> statement-breakpoint
ALTER FUNCTION app.send_processor_breach_notice(uuid, uuid, text, text, integer, integer, text,
  text, text, text, text) OWNER TO harbour_notice_resolver;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_notice_resolver;
