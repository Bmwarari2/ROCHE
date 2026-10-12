-- Data scope per permission, review round 1 (ADR-0071). Runs as harbour_owner.
--
-- S-M1: the people a user is assigned to, and those they opened by break-glass, count only for
-- the permission the request uses when it says so. The API sets `app.scope_assigned` when a role
-- scoped to assigned people carries the permission, and `app.scope_break_glass` only for the read
-- permissions a break-glass record opens (`BREAK_GLASS_PERMISSIONS` in packages/domain). Scope
-- 'assigned' always counts assigned people. Missing or anything but 'true' counts neither: fails
-- closed. `app.person_in_scope` is the only function that reads `person_assignment` or
-- `break_glass_event` for the reader; every child table follows it through `app.person_visible`.

CREATE OR REPLACE FUNCTION app.scope_includes_assigned() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT app.current_scope() = 'assigned'
    OR COALESCE(current_setting('app.scope_assigned', true), '') = 'true'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.scope_includes_break_glass() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(current_setting('app.scope_break_glass', true), '') = 'true'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.person_in_scope(p_person_id uuid, p_location_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_scope() IN ('tenant', 'locations', 'assigned') AND (
  CASE app.current_scope()
    WHEN 'tenant' THEN true
    WHEN 'locations' THEN p_location_id = ANY (app.current_location_ids())
    ELSE false
  END
  OR (app.scope_includes_assigned() AND EXISTS (
    SELECT 1 FROM public.person_assignment pa
    WHERE pa.tenant_id = app.current_tenant_id()
      AND pa.person_id = p_person_id
      AND pa.tenant_user_id = app.current_user_id()
      AND pa.deleted_at IS NULL
      AND pa.valid_from <= now()
      AND (pa.valid_to IS NULL OR pa.valid_to > now())
  ))
  OR (app.scope_includes_break_glass() AND EXISTS (
    SELECT 1 FROM public.break_glass_event bg
    WHERE bg.tenant_id = app.current_tenant_id()
      AND bg.person_id = p_person_id
      AND bg.tenant_user_id = app.current_user_id()
      AND bg.opened_at <= now()
      AND bg.expires_at > now()
  )))
$$;
--> statement-breakpoint

-- L1 and L2: a role or grant with no location counts across the organisation only for a role
-- scoped to the organisation, or one marked organisation-wide (0048), as in packages/domain.
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
        AND (ra.location_id = p_location_id
          OR (ra.location_id IS NULL AND (r.scope_kind = 'tenant' OR ra.organisation_wide))))
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
        AND (g.location_id = p_location_id OR (g.location_id IS NULL AND g.organisation_wide))))
$$;
--> statement-breakpoint

-- L2: a location role assigned with no location, and not marked organisation-wide, is refused
-- (it used to reach the whole organisation by default). A role the trigger cannot see is refused
-- too.
CREATE OR REPLACE FUNCTION app.role_assignment_place_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_kind text;
BEGIN
  IF NEW.location_id IS NULL AND NOT NEW.organisation_wide THEN
    SELECT r.scope_kind::text INTO v_kind FROM public.role r
      WHERE r.id = NEW.role_id AND r.tenant_id = NEW.tenant_id;
    IF v_kind IS NULL OR v_kind = 'location' THEN
      RAISE EXCEPTION 'A location role needs a location, or to be marked organisation-wide'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER role_assignment_place BEFORE INSERT OR UPDATE OF location_id, organisation_wide, role_id
  ON public.role_assignment FOR EACH ROW EXECUTE FUNCTION app.role_assignment_place_guard();
--> statement-breakpoint

-- L1: the application gives or changes a grant only where its member holds platform.grant.manage
-- (a grant for the whole organisation only when they hold it there). The owner role (migrations,
-- seeds) keeps its view.
CREATE POLICY access_grant_write ON public.access_grant AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.holds_permission_at('platform.grant.manage', location_id));
--> statement-breakpoint
CREATE POLICY access_grant_change ON public.access_grant AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.holds_permission_at('platform.grant.manage', location_id))
  WITH CHECK (app.holds_permission_at('platform.grant.manage', location_id));
--> statement-breakpoint

-- L8: the application assigns someone to a person only when the person is in the writer's view
-- and the writer holds people.assignment.manage where the person lives; a job with no member (the
-- worker ending expired assignments) keeps the organisation's view. These add to assignment_scope.
CREATE POLICY assignment_write ON public.person_assignment AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (
    (app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
    OR (app.person_visible(person_id) AND app.holds_permission_at('people.assignment.manage',
      (SELECT p.location_id FROM public.person p WHERE p.id = person_id))));
--> statement-breakpoint
CREATE POLICY assignment_change ON public.person_assignment AS RESTRICTIVE FOR UPDATE TO harbour_app
  WITH CHECK (
    (app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
    OR (app.person_visible(person_id) AND app.holds_permission_at('people.assignment.manage',
      (SELECT p.location_id FROM public.person p WHERE p.id = person_id))));
