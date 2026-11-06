-- The member lifecycle, completed (H-566; platform.md, Members; built on migration 0129). Three
-- times on the member row: when its status last changed, when the member asked for their account
-- to be deleted, and when their sign-in was erased. app.change_membership (still the only function
-- that changes a member's status or sign-in link) now records them, and lets the erasure sweep,
-- as the system, remove the link of an ended membership whose sign-in is due for erasure: the
-- member asked, that membership has ended, and no membership of the sign-in in an onboarding or
-- active organisation is invited, active or suspended, and it is not a Harbour operator's.
ALTER TABLE "tenant_user" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_user" ADD COLUMN "sign_in_erasure_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_user" ADD COLUMN "sign_in_erased_at" timestamp with time zone;--> statement-breakpoint

GRANT SELECT (sign_in_erasure_requested_at, sign_in_erased_at, status_changed_at),
  UPDATE (status_changed_at, sign_in_erased_at) ON public.tenant_user TO harbour_member_owner;
--> statement-breakpoint
GRANT SELECT (id, status) ON public.tenant TO harbour_member_owner;
--> statement-breakpoint
CREATE POLICY member_owner_tenant_status ON public.tenant AS PERMISSIVE FOR SELECT
  TO harbour_member_owner USING (true);
--> statement-breakpoint
GRANT SELECT (auth_user_id) ON public.operator_user TO harbour_member_owner;
--> statement-breakpoint
CREATE POLICY member_owner_operator_check ON public.operator_user AS PERMISSIVE FOR SELECT
  TO harbour_member_owner USING (true);
--> statement-breakpoint
-- The application role writes none of the three times itself: the member's own request goes
-- through app.request_sign_in_erasure, the others through app.change_membership. It keeps UPDATE
-- on every other column (status and the sign-in link stay held by migration 0129's policy).
REVOKE UPDATE ON public.tenant_user FROM harbour_app;
--> statement-breakpoint
GRANT UPDATE (auth_user_id, display_name, email, job_title, status, is_agency, mfa_required,
  last_seen_at, updated_at, updated_by, version, deleted_at) ON public.tenant_user TO harbour_app;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_member_owner;
--> statement-breakpoint
SET ROLE harbour_member_owner;
--> statement-breakpoint

-- Whether a sign-in is due for erasure (see above). Internal: called by this role's functions.
CREATE OR REPLACE FUNCTION app.sign_in_erasure_due(p_auth_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_auth_user_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.tenant_user tu
                WHERE tu.auth_user_id = p_auth_user_id AND tu.deleted_at IS NULL
                  AND tu.status = 'left' AND tu.sign_in_erasure_requested_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM public.tenant_user o
                      JOIN public.tenant t ON t.id = o.tenant_id
                    WHERE o.auth_user_id = p_auth_user_id AND o.deleted_at IS NULL
                      AND o.status IN ('invited', 'active', 'suspended')
                      AND t.status <> 'closed')
    AND NOT EXISTS (SELECT 1 FROM public.operator_user op WHERE op.auth_user_id = p_auth_user_id)
$$;
--> statement-breakpoint

-- The ended memberships whose sign-in is due for erasure, across organisations, for the worker's
-- sweep: opaque ids only. The membership that asked comes last, so a sweep stopped part-way still
-- finds the sign-in due next time.
CREATE OR REPLACE FUNCTION app.sign_ins_due_for_erasure()
RETURNS TABLE (tenant_id uuid, tenant_user_id uuid, auth_user_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT tu.tenant_id, tu.id, tu.auth_user_id FROM public.tenant_user tu
  WHERE tu.auth_user_id IS NOT NULL AND tu.deleted_at IS NULL AND tu.status = 'left'
    AND app.sign_in_erasure_due(tu.auth_user_id)
  ORDER BY tu.auth_user_id, (tu.sign_in_erasure_requested_at IS NOT NULL), tu.tenant_id, tu.id
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.change_membership(p_member uuid, p_action text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_me uuid := app.current_user_id();
  v_actor_status text;
  v_status text;
  v_auth text;
BEGIN
  -- The erasure sweep (H-566, migration 0153): as the system, with no member, it may only remove
  -- the link of an ended membership whose sign-in is due for erasure.
  -- Only the worker's own connection (session_user), never the application role acting as the
  -- system (security review of H-566 v2, M1). The sign-in's lock is held to commit, so the sweep's
  -- re-check and its deletion of the identity cannot interleave with an invitation accepted or a
  -- single sign-on link made for the same sign-in (H1).
  IF v_tenant IS NOT NULL AND v_me IS NULL AND app.is_system() AND session_user = 'harbour_worker'
     AND p_action = 'unlink_sign_in' AND p_member IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_tenant::text || ':membership_change'));
    SELECT tu.status::text, tu.auth_user_id INTO v_status, v_auth FROM public.tenant_user tu
     WHERE tu.tenant_id = v_tenant AND tu.id = p_member AND tu.deleted_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_auth IS NULL THEN
      RETURN 'unchanged';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('sign_in:' || v_auth));
    IF v_status <> 'left' OR NOT app.sign_in_erasure_due(v_auth) THEN
      RAISE EXCEPTION 'sign_in_in_use' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.tenant_user SET auth_user_id = NULL, sign_in_erased_at = now()
     WHERE tenant_id = v_tenant AND id = p_member;
    RETURN v_status;
  END IF;
  IF v_tenant IS NULL OR v_me IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('suspend', 'reinstate', 'end', 'unlink_sign_in') THEN
    RAISE EXCEPTION 'unknown_action' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_member IS NULL THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'no_data_found';
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
    UPDATE public.tenant_user SET status = 'suspended', status_changed_at = now()
     WHERE tenant_id = v_tenant AND id = p_member;
  ELSIF p_action = 'reinstate' THEN
    IF v_status IN ('invited', 'active') THEN
      RETURN 'unchanged';
    END IF;
    -- An ended membership comes back only for a holder of platform.user.manage across the
    -- organisation, never once its sign-in has been erased, nor while the member's own request
    -- to delete their account stands (a wrong leaving date withdrawn, HZ-133; H-1469). Its roles
    -- and grants stay ended: the manager gives them again.
    IF v_status = 'left' AND (
         NOT app.holds_permission_at('platform.user.manage', NULL)
         OR EXISTS (SELECT 1 FROM public.tenant_user tu
                    WHERE tu.tenant_id = v_tenant AND tu.id = p_member
                      AND (tu.sign_in_erased_at IS NOT NULL
                           OR tu.sign_in_erasure_requested_at IS NOT NULL))) THEN
      RAISE EXCEPTION 'membership_ended' USING ERRCODE = 'check_violation';
    END IF;
    IF v_status NOT IN ('suspended', 'left') THEN
      RAISE EXCEPTION 'membership_ended' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.tenant_user
       SET status = CASE WHEN v_auth IS NULL THEN 'invited' ELSE 'active' END::public.tenant_user_status,
           status_changed_at = now()
     WHERE tenant_id = v_tenant AND id = p_member;
  ELSIF p_action = 'end' THEN
    IF v_status = 'left' THEN
      RETURN 'unchanged';
    END IF;
    IF v_status <> 'suspended' THEN
      RAISE EXCEPTION 'suspend_first' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.tenant_user SET status = 'left', status_changed_at = now()
     WHERE tenant_id = v_tenant AND id = p_member;
  ELSIF p_action = 'unlink_sign_in' THEN
    IF v_status <> 'left' THEN
      RAISE EXCEPTION 'membership_not_ended' USING ERRCODE = 'check_violation';
    END IF;
    IF v_auth IS NULL THEN
      RETURN 'unchanged';
    END IF;
    UPDATE public.tenant_user SET auth_user_id = NULL, sign_in_erased_at = now()
     WHERE tenant_id = v_tenant AND id = p_member;
  ELSE
    RAISE EXCEPTION 'unknown_action' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v_status;
END
$$;
--> statement-breakpoint
-- Set as their owner, so the revoke takes effect (ADR-0002).
REVOKE ALL ON FUNCTION app.sign_in_erasure_due(text), app.sign_ins_due_for_erasure() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sign_ins_due_for_erasure() TO harbour_worker;
--> statement-breakpoint
-- The sweep runs app.change_membership on the worker's own connection.
GRANT EXECUTE ON FUNCTION app.change_membership(uuid, text) TO harbour_worker;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_member_owner;
--> statement-breakpoint

-- The guard (migration 0129), replaced in place, not added to: it now also lets
-- app.change_membership (run as harbour_member_owner) bring an ended membership back, active with
-- its sign-in or invited without one, while that sign-in has not been erased (H-1469). Every other
-- transition is as before.
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
       OR (OLD.status <> 'left' AND NEW.status = 'left')
       OR (current_user = 'harbour_member_owner' AND OLD.status = 'left'
           AND OLD.sign_in_erased_at IS NULL
           AND ((NEW.status = 'active' AND NEW.auth_user_id IS NOT NULL)
                OR (NEW.status = 'invited' AND NEW.auth_user_id IS NULL)))) THEN
    RAISE EXCEPTION 'A membership cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Accepting an invitation and linking a single sign-on member (migration 0129, owned by
-- harbour_invitation_owner, so redefined as that role) also take the sign-in's lock, after the
-- organisation's; otherwise unchanged.
GRANT CREATE ON SCHEMA app TO harbour_invitation_owner;
--> statement-breakpoint
SET ROLE harbour_invitation_owner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.accept_invitation(p_token text, p_auth_user_id text)
RETURNS TABLE (tenant_id uuid, tenant_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_prev_tenant text := current_setting('app.tenant_id', true);
  v_prev_user text := current_setting('app.user_id', true);
  v_prev_scope text := current_setting('app.scope', true);
  v record;
  v_refusal text;
  v_email text;
  v_tenant uuid;
  v_member uuid;
BEGIN
  -- The organisation and member first, unlocked, so the membership-change lock is taken before
  -- any row lock, then the member's row, then the invitation's (migration 0129).
  SELECT i.tenant_id, i.tenant_user_id INTO v_tenant, v_member
    FROM public.invitation i WHERE i.token_hash = app.invitation_token_hash(p_token);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_tenant::text || ':membership_change'));
  -- The sign-in's own lock, which the erasure sweep holds while it erases (migration 0153).
  PERFORM pg_advisory_xact_lock(hashtext('sign_in:' || coalesce(p_auth_user_id, '')));
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  PERFORM set_config('app.scope', 'tenant', true);
  PERFORM set_config('app.user_id', v_member::text, true);
  PERFORM 1 FROM public.tenant_user tu
   WHERE tu.tenant_id = v_tenant AND tu.id = v_member
   FOR UPDATE;
  SELECT i.id, i.tenant_id, i.tenant_user_id, i.email, i.expires_at, i.accepted_at, i.revoked_at
    INTO v FROM public.invitation i WHERE i.token_hash = app.invitation_token_hash(p_token)
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT app.invitation_refusal(v.accepted_at, v.revoked_at, v.expires_at, t.status::text,
      tu.status::text, tu.auth_user_id, tu.deleted_at)
    INTO v_refusal
    FROM public.tenant t
    JOIN public.tenant_user tu ON tu.tenant_id = t.id AND tu.id = v.tenant_user_id
    WHERE t.id = v.tenant_id;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION '%', v_refusal USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT lower(btrim(u.email)) INTO v_email FROM auth."user" u WHERE u.id = p_auth_user_id;
  IF v_email IS DISTINCT FROM v.email THEN
    RAISE EXCEPTION 'email_mismatch' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_user tu
             WHERE tu.tenant_id = v.tenant_id AND tu.auth_user_id = p_auth_user_id) THEN
    RAISE EXCEPTION 'already_member' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  UPDATE public.invitation SET accepted_at = clock_timestamp(),
      accepted_auth_user_id = p_auth_user_id
    WHERE id = v.id;
  UPDATE public.tenant_user SET auth_user_id = p_auth_user_id, status = 'active'
    WHERE public.tenant_user.tenant_id = v.tenant_id AND id = v.tenant_user_id
      AND status = 'invited' AND auth_user_id IS NULL AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_invited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM app.invitation_audit(v.tenant_id, v.id, 'platform.invitation.accepted',
    v.tenant_user_id, p_auth_user_id, NULL, NULL, NULL);
  PERFORM set_config('app.tenant_id', coalesce(v_prev_tenant, ''), true);
  PERFORM set_config('app.user_id', coalesce(v_prev_user, ''), true);
  PERFORM set_config('app.scope', coalesce(v_prev_scope, ''), true);
  RETURN QUERY SELECT v.tenant_id, v.tenant_user_id;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.link_sso_member(p_provider_id text, p_auth_user_id text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_prev_tenant text := current_setting('app.tenant_id', true);
  v_prev_scope text := current_setting('app.scope', true);
  v_tenant uuid;
  v_email text;
  v_member uuid;
BEGIN
  IF p_provider_id !~ '^harbour-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'sso_provider_unknown' USING ERRCODE = 'no_data_found';
  END IF;
  v_tenant := substring(p_provider_id FROM 9)::uuid;
  -- The membership-change lock first, so linking and suspending never wait on each other's row
  -- locks (migration 0129); the one member row is then locked by the update.
  PERFORM pg_advisory_xact_lock(hashtext(v_tenant::text || ':membership_change'));
  -- The sign-in's own lock, which the erasure sweep holds while it erases (migration 0153).
  PERFORM pg_advisory_xact_lock(hashtext('sign_in:' || coalesce(p_auth_user_id, '')));
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  PERFORM set_config('app.scope', 'tenant', true);
  IF NOT EXISTS (SELECT 1 FROM public.sso_connection c WHERE c.tenant_id = v_tenant
                 AND c.provider_id = p_provider_id AND c.enabled AND c.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'sso_off' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT lower(btrim(u.email)) INTO v_email FROM auth."user" u WHERE u.id = p_auth_user_id;
  IF v_email IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.sso_domain d WHERE d.tenant_id = v_tenant
        AND d.domain = split_part(v_email, '@', 2)
        AND d.verified_at IS NOT NULL AND d.removed_at IS NULL) THEN
    RAISE EXCEPTION 'domain_not_verified' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- The sign-in must have come through this organisation's provider (#33 review L1).
  IF NOT EXISTS (SELECT 1 FROM auth.account a
                 WHERE a.user_id = p_auth_user_id AND a.provider_id = p_provider_id) THEN
    RAISE EXCEPTION 'sso_account_missing' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_user tu
             WHERE tu.tenant_id = v_tenant AND tu.auth_user_id = p_auth_user_id) THEN
    RAISE EXCEPTION 'already_member' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  UPDATE public.tenant_user SET auth_user_id = p_auth_user_id, status = 'active'
    WHERE public.tenant_user.tenant_id = v_tenant AND lower(btrim(email)) = v_email
      AND status = 'invited' AND auth_user_id IS NULL AND deleted_at IS NULL
    RETURNING id INTO v_member;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'member_not_invited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  INSERT INTO public.audit_event (tenant_id, actor_tenant_user_id, actor_auth_user_id,
      actor_role_keys, action, outcome, resource_type, resource_id, scope)
    VALUES (v_tenant, v_member, p_auth_user_id, ARRAY[]::text[], 'platform.sso.member_linked',
      'success', 'tenant_user', v_member::text, jsonb_build_object('via', 'sso'));
  PERFORM set_config('app.tenant_id', coalesce(v_prev_tenant, ''), true);
  PERFORM set_config('app.scope', coalesce(v_prev_scope, ''), true);
  RETURN v_member;
END
$$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_invitation_owner;
--> statement-breakpoint

-- The member's own request (MOB-011): the session's member, their own row, once.
CREATE OR REPLACE FUNCTION app.request_sign_in_erasure() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.tenant_user SET sign_in_erasure_requested_at = now()
   WHERE tenant_id = app.current_tenant_id() AND id = app.current_user_id()
     AND sign_in_erasure_requested_at IS NULL;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.request_sign_in_erasure() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.request_sign_in_erasure() TO harbour_app;
