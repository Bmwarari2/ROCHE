-- #26 review round 2, S1: who may change an escalation policy link or a coded discard reason is
-- decided by the roles and grants that carry the permission, never by the session's merged scope.
-- A Registered Manager at one home who is also an administrator at another (no
-- quality.policy.manage there), or also a group executive, kept a scope wider than the permission
-- they hold, so the earlier policies (0044) let them change the other home's or the whole
-- organisation's links. Runs as harbour_owner.

-- Whether the session's member holds a permission at a location, or across the organisation when
-- the location is NULL: a live role assignment of a role scoped to the organisation or to
-- locations that carries the permission, assigned with no location or at that location; or a live,
-- unrevoked grant carrying it, with no location or for that location
-- (`placesHoldingPermission` in packages/domain, which the API checks first).
CREATE OR REPLACE FUNCTION app.holds_permission_at(p_permission text, p_location_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.current_user_id() IS NOT NULL AND (
    EXISTS (
      SELECT 1
      FROM public.role_assignment ra
      JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
      WHERE ra.tenant_id = app.current_tenant_id()
        AND ra.tenant_user_id = app.current_user_id()
        AND ra.deleted_at IS NULL
        AND r.archived_at IS NULL
        AND ra.valid_from <= now()
        AND (ra.valid_to IS NULL OR ra.valid_to > now())
        AND r.scope_kind::text IN ('tenant', 'location')
        -- A role mixing portal and staff permissions gives none, as at sign-in
        -- (`rolePermissionMix`; PORTAL_ONLY_PERMISSIONS in packages/domain; #26 review round 3).
        AND NOT (r.permissions && ARRAY['comms.portal.family', 'comms.portal.self', 'comms.feed.read',
          'comms.notification.subscribe', 'comms.visit_booking.request']::text[])
        AND p_permission = ANY (r.permissions)
        AND (ra.location_id IS NULL OR ra.location_id = p_location_id))
    OR EXISTS (
      SELECT 1
      FROM public.access_grant g
      WHERE g.tenant_id = app.current_tenant_id()
        AND g.tenant_user_id = app.current_user_id()
        AND g.deleted_at IS NULL
        AND g.revoked_at IS NULL
        AND g.valid_from <= now()
        AND g.valid_to > now()
        AND p_permission = ANY (g.permissions)
        AND (g.location_id IS NULL OR g.location_id = p_location_id)))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.holds_permission_at(text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_permission_at(text, uuid) TO harbour_app;
--> statement-breakpoint

-- Escalation policy links: the app writes a link only where its member holds
-- quality.policy.manage (a link for the whole organisation only when they hold it there). The owner
-- role (migrations, seeds, the operator) keeps the organisation's view.
DROP POLICY escalation_policy_link_write ON public.escalation_policy_link;
--> statement-breakpoint
DROP POLICY escalation_policy_link_change ON public.escalation_policy_link;
--> statement-breakpoint
CREATE POLICY escalation_policy_link_write ON public.escalation_policy_link AS RESTRICTIVE
  FOR INSERT TO harbour_app
  WITH CHECK (app.holds_permission_at('quality.policy.manage', location_id));
--> statement-breakpoint
CREATE POLICY escalation_policy_link_change ON public.escalation_policy_link AS RESTRICTIVE
  FOR UPDATE TO harbour_app
  USING (app.holds_permission_at('quality.policy.manage', location_id))
  WITH CHECK (app.holds_permission_at('quality.policy.manage', location_id));
--> statement-breakpoint
CREATE POLICY escalation_policy_link_system_write ON public.escalation_policy_link AS RESTRICTIVE
  FOR INSERT TO harbour_owner
  WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint
CREATE POLICY escalation_policy_link_system_change ON public.escalation_policy_link AS RESTRICTIVE
  FOR UPDATE TO harbour_owner
  USING (app.current_scope() = 'tenant')
  WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint

-- Coded discard reasons: the app changes them only for a member who holds platform.tenant.manage
-- across the organisation. The owner role keeps the seeding function's organisation view.
DROP POLICY discard_reason_write ON public.discard_reason;
--> statement-breakpoint
DROP POLICY discard_reason_change ON public.discard_reason;
--> statement-breakpoint
CREATE POLICY discard_reason_write ON public.discard_reason AS RESTRICTIVE
  FOR INSERT TO harbour_app
  WITH CHECK (app.holds_permission_at('platform.tenant.manage', NULL));
--> statement-breakpoint
CREATE POLICY discard_reason_change ON public.discard_reason AS RESTRICTIVE
  FOR UPDATE TO harbour_app
  USING (app.holds_permission_at('platform.tenant.manage', NULL))
  WITH CHECK (app.holds_permission_at('platform.tenant.manage', NULL));
--> statement-breakpoint
CREATE POLICY discard_reason_system_write ON public.discard_reason AS RESTRICTIVE
  FOR INSERT TO harbour_owner
  WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint
CREATE POLICY discard_reason_system_change ON public.discard_reason AS RESTRICTIVE
  FOR UPDATE TO harbour_owner
  USING (app.current_scope() = 'tenant')
  WITH CHECK (app.current_scope() = 'tenant');
