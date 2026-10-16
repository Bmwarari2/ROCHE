-- Members created by a manager (PLAT-004; platform.md, Invitations and MFA enrolment). The
-- application may add a member of staff, and give them a role, only as an invited member who must
-- use a second factor, and only where its member holds platform.user.manage and every permission
-- of that role (as app.may_invite does for sending an invitation), so no one hands out more than
-- they hold. Depends on 0059 (letter templates, #69) only for its number; nothing here uses it.
-- The owner role (migrations, seeds, the operator) is unaffected.

-- Whether the session's member may give `p_role` at `p_location` (NULL: across the organisation).
-- Invoker rights: it reads under the caller's row-level security, so another organisation's role
-- is never found. Only staff roles are given here: never the portal role of a person receiving care
-- (scope 'self'); a family role's portal permissions are held by no member of staff, so it fails
-- the permission check.
CREATE OR REPLACE FUNCTION app.may_assign_role(p_role uuid, p_location uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.holds_permission_at('platform.user.manage', p_location)
    AND EXISTS (
      SELECT 1 FROM public.role r
      WHERE r.id = p_role AND r.tenant_id = app.current_tenant_id()
        AND r.deleted_at IS NULL AND r.archived_at IS NULL
        AND r.scope_kind::text <> 'self')
    AND NOT EXISTS (
      SELECT 1
      FROM public.role r
      CROSS JOIN LATERAL unnest(r.permissions) AS p(permission)
      WHERE r.id = p_role AND r.tenant_id = app.current_tenant_id()
        AND NOT app.holds_permission_at(p.permission, p_location))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.may_assign_role(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.may_assign_role(uuid, uuid) TO harbour_app;
--> statement-breakpoint

-- Whether the session's member holds a permission anywhere: across the organisation or at any
-- location (a role or a grant in force).
CREATE OR REPLACE FUNCTION app.holds_permission_somewhere(p_permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.holds_permission_at(p_permission, NULL)
    OR EXISTS (
      SELECT 1 FROM public.location l
      WHERE l.tenant_id = app.current_tenant_id() AND l.deleted_at IS NULL
        AND app.holds_permission_at(p_permission, l.id))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.holds_permission_somewhere(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_permission_somewhere(text) TO harbour_app;
--> statement-breakpoint

-- A member the application adds is invited, has no sign-in and must use a second factor, and is
-- added by someone holding platform.user.manage.
CREATE POLICY tenant_user_issue ON public.tenant_user AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (status = 'invited' AND auth_user_id IS NULL AND mfa_required
    AND app.holds_permission_somewhere('platform.user.manage'));
--> statement-breakpoint

-- A role is given only where the giver may give it (app.may_assign_role); a location role across
-- the organisation counts as given across the organisation.
CREATE POLICY role_assignment_issue ON public.role_assignment AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.may_assign_role(role_id, location_id));
