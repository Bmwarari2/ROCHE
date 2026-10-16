-- Thapsus announces a sub-processor notice, and reads and resolves an organisation's objection to
-- one, only through definer functions (platform-completions.md rules 24 and 25; #92 and #95
-- security reviews). They are owned by their own NOLOGIN role, harbour_notice_resolver, which
-- reads and writes only what they need; the operator role keeps no direct access to notices or
-- responses. Each identifies the caller from the transaction's app.operator_id (an active Thapsus
-- admin), works in each organisation's own context, and writes that organisation's audit trail
-- and an outbox event in the same transaction, so the worker tells its lead durably.
REVOKE SELECT, INSERT ON public.sub_processor_response FROM harbour_operator;
--> statement-breakpoint
REVOKE INSERT ON public.sub_processor_notice FROM harbour_operator;
--> statement-breakpoint
DROP POLICY notice_announce ON public.sub_processor_notice;
--> statement-breakpoint
CREATE POLICY notice_announce ON public.sub_processor_notice AS PERMISSIVE FOR INSERT
  TO harbour_notice_resolver, harbour_owner WITH CHECK (true);
--> statement-breakpoint
DROP POLICY response_resolution ON public.sub_processor_response;
--> statement-breakpoint
CREATE POLICY response_resolution ON public.sub_processor_response AS RESTRICTIVE FOR INSERT
  TO harbour_notice_resolver
  WITH CHECK (kind = 'objection_resolved' AND responded_by IS NULL);
--> statement-breakpoint
CREATE POLICY resolver_operator_check ON public.operator_user AS PERMISSIVE FOR SELECT
  TO harbour_notice_resolver USING (true);
--> statement-breakpoint

-- The active Thapsus admin calling (the transaction's app.operator_id), or an error.
CREATE OR REPLACE FUNCTION app.notice_resolver_admin() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE v_operator uuid;
BEGIN
  SELECT o.id INTO v_operator FROM public.operator_user o
   WHERE o.id = nullif(current_setting('app.operator_id', true), '')::uuid
     AND o.active AND o.role = 'admin';
  IF v_operator IS NULL THEN
    RAISE EXCEPTION 'operator_not_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_operator;
END
$$;
--> statement-breakpoint

-- Every organisation's objections to one notice, with the grounds it gave Thapsus, each read
-- recorded in that organisation's audit trail (ids only, never the grounds).
CREATE OR REPLACE FUNCTION app.sub_processor_objections(p_notice uuid, p_request_id text)
RETURNS TABLE (tenant_id uuid, objected_at timestamptz, grounds text, resolved_at timestamptz,
               resolution text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  v_operator uuid := app.notice_resolver_admin();
  v_auth_user text := (SELECT o.auth_user_id FROM public.operator_user o WHERE o.id = v_operator);
  v_tenant uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sub_processor_notice n WHERE n.id = p_notice) THEN
    RAISE EXCEPTION 'notice_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  FOR v_tenant IN SELECT t.id FROM public.tenant t ORDER BY t.id LOOP
    PERFORM set_config('app.tenant_id', v_tenant::text, true);
    FOR tenant_id, objected_at, grounds, resolved_at, resolution IN
      SELECT o.tenant_id, o.responded_at, o.grounds,
             (SELECT min(r.responded_at) FROM public.sub_processor_response r
               WHERE r.tenant_id = o.tenant_id AND r.notice_id = p_notice
                 AND r.kind = 'objection_resolved' AND r.responded_at >= o.responded_at),
             (SELECT r.resolution FROM public.sub_processor_response r
               WHERE r.tenant_id = o.tenant_id AND r.notice_id = p_notice
                 AND r.kind = 'objection_resolved' AND r.responded_at >= o.responded_at
               ORDER BY r.responded_at LIMIT 1)
        FROM public.sub_processor_response o
       WHERE o.tenant_id = v_tenant AND o.notice_id = p_notice AND o.kind = 'objected'
       ORDER BY o.responded_at
    LOOP
      INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
        resource_type, resource_id, scope, request_id)
      VALUES (v_tenant, v_auth_user, ARRAY['thapsus_admin'], 'platform.sub_processor.objection_read',
        'sub_processor_notice', p_notice::text, jsonb_build_object('operatorId', v_operator),
        p_request_id);
      RETURN NEXT;
    END LOOP;
  END LOOP;
END
$$;
--> statement-breakpoint

-- Records how an organisation's open objection to a notice was resolved: only when one is open
-- (a later objection reopens), once at a time, with the organisation's audit event.
CREATE OR REPLACE FUNCTION app.resolve_sub_processor_objection(
  p_tenant uuid, p_notice uuid, p_resolution text, p_request_id text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_operator uuid := app.notice_resolver_admin();
  v_auth_user text := (SELECT o.auth_user_id FROM public.operator_user o WHERE o.id = v_operator);
  v_key text;
  v_objected timestamptz;
  v_id uuid;
BEGIN
  IF p_resolution IS NULL
     OR p_resolution NOT IN ('objection_withdrawn', 'not_used_for_tenant', 'services_ended') THEN
    RAISE EXCEPTION 'invalid_resolution' USING ERRCODE = 'check_violation';
  END IF;
  SELECT n.sub_processor_key INTO v_key FROM public.sub_processor_notice n WHERE n.id = p_notice;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'notice_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  -- One resolution at a time for this organisation and notice.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':' || p_notice::text, 0));
  SELECT max(o.responded_at) INTO v_objected FROM public.sub_processor_response o
   WHERE o.tenant_id = p_tenant AND o.notice_id = p_notice AND o.kind = 'objected';
  IF v_objected IS NULL OR EXISTS (
       SELECT 1 FROM public.sub_processor_response r
        WHERE r.tenant_id = p_tenant AND r.notice_id = p_notice
          AND r.kind = 'objection_resolved' AND r.responded_at >= v_objected) THEN
    RAISE EXCEPTION 'no_open_objection' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.sub_processor_response
    (tenant_id, sub_processor_key, notice_id, kind, resolution, responded_by)
  VALUES (p_tenant, v_key, p_notice, 'objection_resolved', p_resolution, NULL)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
    resource_type, resource_id, scope, request_id)
  VALUES (p_tenant, v_auth_user, ARRAY['thapsus_admin'], 'platform.sub_processor.objection_resolved',
    'sub_processor_notice', p_notice::text,
    jsonb_build_object('operatorId', v_operator, 'responseId', v_id, 'resolution', p_resolution),
    p_request_id);
  -- The worker tells the organisation's lead (idempotent by its dedupe key).
  INSERT INTO public.outbox_event (tenant_id, aggregate_type, aggregate_id, event_type, payload)
  VALUES (p_tenant, 'sub_processor_notice', p_notice::text,
    'platform.sub_processor.objection_resolved',
    jsonb_build_object('noticeId', p_notice, 'responseId', v_id));
  RETURN v_id;
END
$$;
--> statement-breakpoint

-- Announces a notice to the organisations it affects (the API works them out from their
-- configuration and checks the timing first): the notice, and for each organisation its audit
-- event and an outbox event the worker turns into a notification, all in one transaction.
CREATE OR REPLACE FUNCTION app.announce_sub_processor_notice(
  p_key text, p_kind text, p_use jsonb, p_effective_from timestamptz, p_tenants uuid[],
  p_request_id text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_operator uuid := app.notice_resolver_admin();
  v_auth_user text := (SELECT o.auth_user_id FROM public.operator_user o WHERE o.id = v_operator);
  v_notice uuid;
  v_tenant uuid;
BEGIN
  INSERT INTO public.sub_processor_notice (sub_processor_key, kind, use, announced_at, effective_from)
  VALUES (p_key, p_kind, p_use, now(), p_effective_from)
  RETURNING id INTO v_notice;
  FOREACH v_tenant IN ARRAY coalesce(p_tenants, ARRAY[]::uuid[]) LOOP
    PERFORM set_config('app.tenant_id', v_tenant::text, true);
    INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
      resource_type, resource_id, scope, request_id)
    VALUES (v_tenant, v_auth_user, ARRAY['thapsus_admin'], 'platform.sub_processor.announced',
      'sub_processor_notice', v_notice::text,
      jsonb_build_object('operatorId', v_operator, 'subProcessorKey', p_key, 'kind', p_kind),
      p_request_id);
    INSERT INTO public.outbox_event (tenant_id, aggregate_type, aggregate_id, event_type, payload)
    VALUES (v_tenant, 'sub_processor_notice', v_notice::text,
      'platform.sub_processor.notice_announced', jsonb_build_object('noticeId', v_notice));
  END LOOP;
  RETURN v_notice;
END
$$;
--> statement-breakpoint

-- What harbour_notice_resolver's functions need, and nothing else.
GRANT USAGE ON SCHEMA public, app TO harbour_notice_resolver;
--> statement-breakpoint
GRANT SELECT (id, sub_processor_key), INSERT ON public.sub_processor_notice
  TO harbour_notice_resolver;
--> statement-breakpoint
GRANT SELECT (id) ON public.tenant TO harbour_notice_resolver;
--> statement-breakpoint
CREATE POLICY resolver_tenants ON public.tenant AS PERMISSIVE FOR SELECT
  TO harbour_notice_resolver USING (true);
--> statement-breakpoint
GRANT SELECT, INSERT ON public.sub_processor_response TO harbour_notice_resolver;
--> statement-breakpoint
GRANT INSERT ON public.audit_event, public.outbox_event TO harbour_notice_resolver;
--> statement-breakpoint
GRANT SELECT (id, auth_user_id, role, active) ON public.operator_user TO harbour_notice_resolver;
--> statement-breakpoint
-- Who may execute them is set before they change owner: the new owner keeps the ACL, and once it
-- has changed only that owner could revoke the default PUBLIC execute right.
REVOKE ALL ON FUNCTION app.notice_resolver_admin() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.sub_processor_objections(uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resolve_sub_processor_objection(uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.announce_sub_processor_notice(text, text, jsonb, timestamptz, uuid[], text)
  FROM PUBLIC;
--> statement-breakpoint
-- Functions in app are executable by the other application roles by default: not these.
REVOKE ALL ON FUNCTION app.notice_resolver_admin(), app.sub_processor_objections(uuid, text),
  app.resolve_sub_processor_objection(uuid, uuid, text, text),
  app.announce_sub_processor_notice(text, text, jsonb, timestamptz, uuid[], text)
  FROM harbour_app, harbour_worker, harbour_auth, harbour_sync;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sub_processor_objections(uuid, text) TO harbour_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_sub_processor_objection(uuid, uuid, text, text)
  TO harbour_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.announce_sub_processor_notice(text, text, jsonb, timestamptz, uuid[], text)
  TO harbour_operator;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_notice_resolver;
--> statement-breakpoint
ALTER FUNCTION app.notice_resolver_admin() OWNER TO harbour_notice_resolver;
--> statement-breakpoint
ALTER FUNCTION app.sub_processor_objections(uuid, text) OWNER TO harbour_notice_resolver;
--> statement-breakpoint
ALTER FUNCTION app.resolve_sub_processor_objection(uuid, uuid, text, text)
  OWNER TO harbour_notice_resolver;
--> statement-breakpoint
ALTER FUNCTION app.announce_sub_processor_notice(text, text, jsonb, timestamptz, uuid[], text)
  OWNER TO harbour_notice_resolver;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_notice_resolver;
