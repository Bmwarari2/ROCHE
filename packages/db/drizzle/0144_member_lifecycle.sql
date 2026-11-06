-- The member lifecycle (H-566; platform.md, Members): a holder of platform.user.manage suspends a
-- membership, then ends it; once the person has no active membership anywhere and asked for their
-- account to be deleted, their sign-in identity is erased. The member row, display name and job
-- title stay, so care records remain attributable (Regulation 17).
ALTER TABLE "tenant_user" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_user" ADD COLUMN "sign_in_erasure_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_user" ADD COLUMN "sign_in_erased_at" timestamp with time zone;--> statement-breakpoint

-- An ended membership stays ended: nothing moves it back, whoever writes (a new membership is a
-- new invitation). A row whose sign-in was erased never takes one again.
CREATE OR REPLACE FUNCTION app.tenant_user_status_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status = 'left' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'An ended membership stays ended'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.sign_in_erased_at IS NOT NULL AND NEW.auth_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'A membership whose sign-in was erased takes no sign-in again'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_user_status_guard BEFORE UPDATE ON public.tenant_user
  FOR EACH ROW EXECUTE FUNCTION app.tenant_user_status_guard();
--> statement-breakpoint

-- Suspends (from active) or ends (from suspended) a membership for a holder of
-- platform.user.manage; the API has already checked that the permission reaches the member
-- (ADR-0071), the step-up and the held entries. Never the caller's own membership, never the
-- organisation's last active member who manages users. Ending also ends the member's roles and
-- grants. Returns the status it found: the same status as asked is a replay and changes nothing.
CREATE OR REPLACE FUNCTION app.change_member_status(p_member uuid, p_to text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_from text;
BEGIN
  IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL
     OR NOT app.holds_role_permission_somewhere('platform.user.manage') THEN
    RAISE EXCEPTION 'Changing a membership needs platform.user.manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_to NOT IN ('suspended', 'left') THEN
    RAISE EXCEPTION 'A membership is suspended or ended here' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_member = app.current_user_id() THEN
    RAISE EXCEPTION 'Nobody changes their own membership' USING ERRCODE = 'HB566';
  END IF;
  SELECT u.status::text INTO v_from FROM public.tenant_user u
   WHERE u.tenant_id = app.current_tenant_id() AND u.id = p_member AND u.deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such member' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_from = p_to THEN
    RETURN v_from;
  END IF;
  IF (p_to = 'suspended' AND v_from <> 'active') OR (p_to = 'left' AND v_from <> 'suspended') THEN
    RAISE EXCEPTION 'A membership is suspended from active and ended from suspended'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_to = 'suspended' AND EXISTS (
       SELECT 1 FROM public.role_assignment ra
         JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        WHERE ra.tenant_id = app.current_tenant_id() AND ra.tenant_user_id = p_member
          AND ra.deleted_at IS NULL AND (ra.valid_to IS NULL OR ra.valid_to > now())
          AND 'platform.user.manage' = ANY (r.permissions))
     AND NOT EXISTS (
       SELECT 1 FROM public.role_assignment ra
         JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
         JOIN public.tenant_user u ON u.tenant_id = ra.tenant_id AND u.id = ra.tenant_user_id
        WHERE ra.tenant_id = app.current_tenant_id() AND ra.tenant_user_id <> p_member
          AND u.status = 'active' AND u.deleted_at IS NULL
          AND ra.deleted_at IS NULL AND ra.valid_from <= now()
          AND (ra.valid_to IS NULL OR ra.valid_to > now())
          AND 'platform.user.manage' = ANY (r.permissions)) THEN
    RAISE EXCEPTION 'The organisation''s last member who manages users keeps their access'
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.tenant_user SET status = p_to::public.tenant_user_status, status_changed_at = now()
   WHERE tenant_id = app.current_tenant_id() AND id = p_member;
  IF p_to = 'left' THEN
    UPDATE public.role_assignment SET valid_to = now()
     WHERE tenant_id = app.current_tenant_id() AND tenant_user_id = p_member
       AND deleted_at IS NULL AND (valid_to IS NULL OR valid_to > now());
    UPDATE public.access_grant SET revoked_at = now()
     WHERE tenant_id = app.current_tenant_id() AND tenant_user_id = p_member
       AND revoked_at IS NULL;
  END IF;
  RETURN v_from;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.change_member_status(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.change_member_status(uuid, text) TO harbour_app;
--> statement-breakpoint

-- Every membership of a sign-in, in every organisation and state (the erasure step reads them
-- before it acts in each organisation's own view). Opaque ids and states only.
CREATE OR REPLACE FUNCTION app.memberships_of_sign_in(p_auth_user_id text)
RETURNS TABLE (tenant_id uuid, tenant_user_id uuid, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT tu.tenant_id, tu.id, tu.status::text FROM public.tenant_user tu
  WHERE tu.auth_user_id = p_auth_user_id AND tu.deleted_at IS NULL
  ORDER BY tu.tenant_id, tu.id
$$;
--> statement-breakpoint

-- The sign-ins due for erasure (H-566): a membership asked for the account to be deleted, and no
-- membership of the sign-in in any organisation is invited or active. Not an operator's sign-in.
CREATE OR REPLACE FUNCTION app.sign_ins_due_for_erasure() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT tu.auth_user_id FROM public.tenant_user tu
  WHERE tu.auth_user_id IS NOT NULL AND tu.sign_in_erasure_requested_at IS NOT NULL
    AND tu.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.tenant_user o
                    WHERE o.auth_user_id = tu.auth_user_id AND o.deleted_at IS NULL
                      AND o.status IN ('invited', 'active'))
    AND NOT EXISTS (SELECT 1 FROM public.operator_user op WHERE op.auth_user_id = tu.auth_user_id)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.memberships_of_sign_in(text), app.sign_ins_due_for_erasure()
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.memberships_of_sign_in(text), app.sign_ins_due_for_erasure()
  TO harbour_app, harbour_worker;
--> statement-breakpoint
GRANT SELECT (auth_user_id) ON public.operator_user TO harbour_membership_reader;
--> statement-breakpoint
CREATE POLICY membership_reader_operator_check ON public.operator_user AS PERMISSIVE FOR SELECT
  TO harbour_membership_reader USING (true);
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_membership_reader;
--> statement-breakpoint
ALTER FUNCTION app.memberships_of_sign_in(text) OWNER TO harbour_membership_reader;
--> statement-breakpoint
ALTER FUNCTION app.sign_ins_due_for_erasure() OWNER TO harbour_membership_reader;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_membership_reader;
