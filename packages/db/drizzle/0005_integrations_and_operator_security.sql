-- Integrations and operator console security (ADR-0002 patterns). Runs as harbour_owner.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'integration_connection', 'integration_inbound', 'notification_delivery', 'operator_user',
    'support_access_request'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY[
    'integration_connection', 'integration_inbound', 'notification_delivery', 'support_access_request'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Delivery records are operational detail: tenant-wide roles and jobs read them; anyone whose action
-- raises a notification may create them.
CREATE POLICY delivery_scope ON public.notification_delivery AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.current_scope() = 'tenant')
  WITH CHECK (true);
--> statement-breakpoint

-- The worker sends deliveries across tenants.
CREATE POLICY worker_delivery ON public.notification_delivery AS PERMISSIVE FOR ALL TO harbour_worker
  USING (true) WITH CHECK (true);
--> statement-breakpoint

-- Operators: their own register, every tenant's integration health, and support-access requests.
CREATE POLICY operator_register ON public.operator_user AS PERMISSIVE FOR SELECT TO harbour_operator
  USING (true);
--> statement-breakpoint
CREATE POLICY owner_maintenance ON public.operator_user AS PERMISSIVE FOR ALL TO harbour_owner
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY operator_health ON public.integration_connection AS PERMISSIVE FOR SELECT
  TO harbour_operator USING (true);
--> statement-breakpoint
CREATE POLICY operator_requests ON public.support_access_request AS PERMISSIVE FOR ALL
  TO harbour_operator USING (true) WITH CHECK (true);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.integration_connection, public.integration_inbound,
  public.notification_delivery, public.support_access_request TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.notification_delivery TO harbour_worker;
--> statement-breakpoint
GRANT SELECT ON public.operator_user, public.integration_connection TO harbour_operator;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.support_access_request TO harbour_operator;
--> statement-breakpoint
REVOKE ALL ON public.operator_user FROM harbour_app;
--> statement-breakpoint

-- Versioning: tenant aggregates keep history; the global operator register only bumps its version
-- (operator changes are audited as platform events).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_connection', 'integration_inbound', 'support_access_request'] LOOP
    EXECUTE format(
      'CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format(
      'CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.operator_user
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint

-- Every non in-app channel of a new notification gets a pending delivery for the worker to send.
CREATE OR REPLACE FUNCTION app.queue_notification_deliveries() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- No ON CONFLICT: its arbiter check would apply the delivery read policy to non-tenant-wide users.
  INSERT INTO public.notification_delivery (tenant_id, notification_id, channel, provider)
  SELECT DISTINCT NEW.tenant_id, NEW.id, ch, 'pending_resolution'
  FROM unnest(NEW.channels) AS ch
  WHERE ch <> 'in_app';
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER queue_deliveries AFTER INSERT ON public.notification
  FOR EACH ROW EXECUTE FUNCTION app.queue_notification_deliveries();
--> statement-breakpoint

-- Tenant provisioning for the operator console: creates the tenant, its built-in roles and the
-- first owner (invited) in one step, inside the new tenant's row-level security context. The only
-- way an operator can create tenant data; it cannot read anything back except the new tenant's id.
CREATE OR REPLACE FUNCTION app.provision_tenant(
  p_tenant jsonb,
  p_roles jsonb,
  p_owner jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  new_tenant uuid := COALESCE((p_tenant ->> 'id')::uuid, app.uuid_v7());
  owner_user uuid := app.uuid_v7();
  owner_role uuid;
  r jsonb;
BEGIN
  PERFORM set_config('app.tenant_id', new_tenant::text, true);
  PERFORM set_config('app.scope', 'tenant', true);

  INSERT INTO public.tenant (id, name, legal_name, legal_form, cqc_provider_id, nation, status)
  VALUES (
    new_tenant,
    p_tenant ->> 'name',
    p_tenant ->> 'legalName',
    (p_tenant ->> 'legalForm')::legal_form,
    p_tenant ->> 'cqcProviderId',
    COALESCE(p_tenant ->> 'nation', 'england')::nation,
    'onboarding'
  );

  FOR r IN SELECT * FROM jsonb_array_elements(p_roles) LOOP
    INSERT INTO public.role (key, name, description, permissions, scope_kind, is_builtin)
    VALUES (
      r ->> 'key',
      r ->> 'name',
      r ->> 'description',
      ARRAY(SELECT jsonb_array_elements_text(r -> 'permissions')),
      (r ->> 'scopeKind')::scope_kind,
      true
    );
  END LOOP;

  SELECT id INTO owner_role FROM public.role WHERE key = 'owner';
  IF owner_role IS NULL THEN
    RAISE EXCEPTION 'built-in roles must include owner';
  END IF;

  INSERT INTO public.tenant_user (id, display_name, email, status)
  VALUES (owner_user, p_owner ->> 'displayName', lower(p_owner ->> 'email'), 'invited');
  INSERT INTO public.role_assignment (tenant_user_id, role_id, reason)
  VALUES (owner_user, owner_role, 'Provisioned by Thapsus');

  RETURN new_tenant;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.provision_tenant(jsonb, jsonb, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.provision_tenant(jsonb, jsonb, jsonb) TO harbour_operator;
