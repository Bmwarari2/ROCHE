-- Membership changes held by the database (H-566; security review of
-- fix/recommended-answers-platform, 31/10/2026; ADR-0002). Suspending, reinstating and ending a
-- membership, and unlinking its sign-in, go through app.change_membership, which runs as the
-- NOLOGIN role harbour_member_owner. The application role can no longer change a member's status
-- or sign-in link by itself: a restrictive policy and a guard trigger refuse it, so a bug in any
-- route cannot undo a suspension or relink a member to another sign-in (a membership takeover).
-- The leavers sweep (no member set) ends access through app.end_leaver_access (migration 0091),
-- which runs as harbour_owner and so keeps working; invitation acceptance and single sign-on link
-- an invited member through their own definer functions, which the trigger allows.

-- The member as stored before the statement: the policy below compares a new row with it (a
-- function, because a policy may not read its own table directly). Invoker rights, so it reads in
-- the caller's own organisation only.
CREATE OR REPLACE FUNCTION app.tenant_user_stored_link(p_id uuid)
RETURNS TABLE (status text, auth_user_id text)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT tu.status::text, tu.auth_user_id FROM public.tenant_user tu WHERE tu.id = p_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.tenant_user_stored_link(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.tenant_user_stored_link(uuid) TO harbour_app;
--> statement-breakpoint

-- The application role keeps a member's status and sign-in link as they are; only
-- app.change_membership (another role) changes them.
CREATE POLICY tenant_user_membership_held ON public.tenant_user AS RESTRICTIVE FOR UPDATE
  TO harbour_app
  USING (true)
  WITH CHECK (EXISTS (
    SELECT 1 FROM app.tenant_user_stored_link(tenant_user.id) s
    WHERE s.status = tenant_user.status::text
      AND s.auth_user_id IS NOT DISTINCT FROM tenant_user.auth_user_id));
--> statement-breakpoint

-- Only the changes a membership can make. harbour_owner (migrations, seeds, maintenance, and the
-- functions it owns: app.end_leaver_access, which ends a leaver's access from any state) is not
-- held here. The application role changes neither status nor link itself. Anyone else may: link
-- an invited member to their sign-in once (an invitation accepted, a single sign-on link);
-- suspend an invited or active member; reinstate a suspended one (active with a sign-in, invited
-- without); end a membership; and remove the link of an ended membership (erasure). The link is
-- never changed to another sign-in.
CREATE OR REPLACE FUNCTION app.tenant_user_membership_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.auth_user_id IS NOT DISTINCT FROM OLD.auth_user_id THEN
    RETURN NEW;
  END IF;
  IF current_user = 'harbour_owner' THEN
    RETURN NEW;
  END IF;
  IF current_user = 'harbour_app' THEN
    RAISE EXCEPTION 'A member''s status and sign-in change only through app.change_membership'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'invited' AND NEW.status = 'active'
     AND OLD.auth_user_id IS NULL AND NEW.auth_user_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id
     AND NOT (NEW.auth_user_id IS NULL AND OLD.status = 'left' AND NEW.status = 'left') THEN
    RAISE EXCEPTION 'A member''s sign-in is linked once, and removed only after the membership ends'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status IN ('invited', 'active') AND NEW.status = 'suspended')
       OR (OLD.status = 'suspended' AND NEW.status = 'active' AND NEW.auth_user_id IS NOT NULL)
       OR (OLD.status = 'suspended' AND NEW.status = 'invited' AND NEW.auth_user_id IS NULL)
       OR (OLD.status <> 'left' AND NEW.status = 'left')) THEN
    RAISE EXCEPTION 'A membership cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_user_membership_guard BEFORE UPDATE OF status, auth_user_id
  ON public.tenant_user FOR EACH ROW EXECUTE FUNCTION app.tenant_user_membership_guard();
--> statement-breakpoint

-- harbour_member_owner reads members across organisations (only to count a sign-in's memberships
-- elsewhere, below; every other read filters on the caller's organisation).
CREATE POLICY member_owner_lookup ON public.tenant_user AS PERMISSIVE FOR SELECT
  TO harbour_member_owner USING (true);
--> statement-breakpoint

-- Suspend, reinstate, end, or unlink the sign-in of a member, as the session's member, who must
-- hold platform.user.manage, be active, and not be the member changed. One change at a time in an
-- organisation (an advisory lock), with the actor's and the member's rows locked in id order, so
-- two managers cannot suspend each other at once. The organisation always keeps an active member
-- who manages users through a role (as app.end_leaver_access does, migration 0091): an acting-up
-- grant never counts, so a grant holder cannot remove the last holder of the role. Returns the
-- state before, or 'unchanged' when the member is already as asked. Refusals raise with the code
-- the API turns into words.
CREATE OR REPLACE FUNCTION app.change_membership(p_member uuid, p_action text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_me uuid := app.current_user_id();
  v_actor_status text;
  v_status text;
  v_auth text;
BEGIN
  IF v_tenant IS NULL OR v_me IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_action NOT IN ('suspend', 'reinstate', 'end', 'unlink_sign_in') THEN
    RAISE EXCEPTION 'unknown_action' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_member = v_me THEN
    RAISE EXCEPTION 'own_membership' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT app.holds_permission_anywhere('platform.user.manage') THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_tenant::text || ':membership_change'));
  PERFORM 1 FROM public.tenant_user tu
   WHERE tu.tenant_id = v_tenant AND tu.id IN (v_me, p_member)
   ORDER BY tu.id
   FOR UPDATE;
  SELECT tu.status::text INTO v_actor_status FROM public.tenant_user tu
   WHERE tu.tenant_id = v_tenant AND tu.id = v_me AND tu.deleted_at IS NULL;
  IF v_actor_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT tu.status::text, tu.auth_user_id INTO v_status, v_auth FROM public.tenant_user tu
   WHERE tu.tenant_id = v_tenant AND tu.id = p_member AND tu.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_action = 'suspend' THEN
    IF v_status = 'suspended' THEN
      RETURN 'unchanged';
    END IF;
    IF v_status = 'left' THEN
      RAISE EXCEPTION 'membership_ended' USING ERRCODE = 'check_violation';
    END IF;
    IF v_status = 'active' AND EXISTS (
         SELECT 1 FROM public.role_assignment ra
           JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
          WHERE ra.tenant_id = v_tenant AND ra.tenant_user_id = p_member
            AND ra.deleted_at IS NULL AND r.deleted_at IS NULL AND r.archived_at IS NULL
            AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
            AND 'platform.user.manage' = ANY (r.permissions))
       AND NOT EXISTS (
         SELECT 1 FROM public.role_assignment ra
           JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
           JOIN public.tenant_user u ON u.tenant_id = ra.tenant_id AND u.id = ra.tenant_user_id
          WHERE ra.tenant_id = v_tenant AND ra.tenant_user_id <> p_member
            AND u.status = 'active' AND u.deleted_at IS NULL
            AND ra.deleted_at IS NULL AND r.deleted_at IS NULL AND r.archived_at IS NULL
            AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
            AND 'platform.user.manage' = ANY (r.permissions)) THEN
      RAISE EXCEPTION 'last_user_manager' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.tenant_user SET status = 'suspended'
     WHERE tenant_id = v_tenant AND id = p_member;
  ELSIF p_action = 'reinstate' THEN
    IF v_status IN ('invited', 'active') THEN
      RETURN 'unchanged';
    END IF;
    IF v_status <> 'suspended' THEN
      RAISE EXCEPTION 'membership_ended' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.tenant_user
       SET status = CASE WHEN v_auth IS NULL THEN 'invited' ELSE 'active' END::public.tenant_user_status
     WHERE tenant_id = v_tenant AND id = p_member;
  ELSIF p_action = 'end' THEN
    IF v_status = 'left' THEN
      RETURN 'unchanged';
    END IF;
    IF v_status <> 'suspended' THEN
      RAISE EXCEPTION 'suspend_first' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.tenant_user SET status = 'left'
     WHERE tenant_id = v_tenant AND id = p_member;
  ELSE
    IF v_status <> 'left' THEN
      RAISE EXCEPTION 'membership_not_ended' USING ERRCODE = 'check_violation';
    END IF;
    IF v_auth IS NULL THEN
      RETURN 'unchanged';
    END IF;
    UPDATE public.tenant_user SET auth_user_id = NULL
     WHERE tenant_id = v_tenant AND id = p_member;
  END IF;
  RETURN v_status;
END
$$;
--> statement-breakpoint

-- How many memberships the member's sign-in has in other organisations that have not ended
-- (invited, active or suspended): erasing the sign-in would orphan any of them, and signing it out
-- would end work there. A count only, never which organisations, and only for a holder of
-- platform.user.manage asking about a member of their own organisation.
CREATE OR REPLACE FUNCTION app.sign_in_memberships_elsewhere(p_member uuid) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_auth text;
BEGIN
  IF v_tenant IS NULL OR NOT app.holds_permission_anywhere('platform.user.manage') THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT tu.auth_user_id INTO v_auth FROM public.tenant_user tu
   WHERE tu.tenant_id = v_tenant AND tu.id = p_member;
  IF v_auth IS NULL THEN
    RETURN 0;
  END IF;
  RETURN (SELECT count(*)::integer FROM public.tenant_user other
           WHERE other.auth_user_id = v_auth AND other.tenant_id <> v_tenant
             AND other.status <> 'left' AND other.deleted_at IS NULL);
END
$$;
--> statement-breakpoint

-- What harbour_member_owner's functions need, and nothing else. Execute rights are set before the
-- owner changes (ADR-0002).
GRANT USAGE ON SCHEMA public, app TO harbour_member_owner;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, status, auth_user_id, deleted_at), UPDATE (status, auth_user_id)
  ON public.tenant_user TO harbour_member_owner;
--> statement-breakpoint
GRANT SELECT ON public.role_assignment, public.role, public.access_grant, public.location
  TO harbour_member_owner;
--> statement-breakpoint
-- The version history of the member row (capture_version runs as the role that updates it).
GRANT INSERT ON public.record_version TO harbour_member_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_permission_at(text, uuid), app.holds_permission_anywhere(text)
  TO harbour_member_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.change_membership(uuid, text), app.sign_in_memberships_elsewhere(uuid)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.change_membership(uuid, text), app.sign_in_memberships_elsewhere(uuid)
  TO harbour_app;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_member_owner;
--> statement-breakpoint
ALTER FUNCTION app.change_membership(uuid, text) OWNER TO harbour_member_owner;
--> statement-breakpoint
ALTER FUNCTION app.sign_in_memberships_elsewhere(uuid) OWNER TO harbour_member_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_member_owner;
