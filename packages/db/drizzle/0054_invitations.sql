CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"email" text,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"created_by_operator" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_auth_user_id" text,
	"claimed_auth_user_id" text,
	"claimed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revocation_reason" text,
	CONSTRAINT "invitation_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "invitation_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "invitation_token_hash" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "invitation_one_sender" CHECK (num_nonnulls(created_by, created_by_operator) = 1),
	CONSTRAINT "invitation_expiry" CHECK (expires_at > created_at),
	CONSTRAINT "invitation_accepted" CHECK ((accepted_at IS NULL) = (accepted_auth_user_id IS NULL)),
	CONSTRAINT "invitation_revoked" CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL)
        AND (revocation_reason IS NULL OR revocation_reason IN
          ('superseded', 'revoked', 'member_removed', 'member_changed', 'expired'))
        AND (revoked_by IS NULL OR revoked_at IS NOT NULL)),
	CONSTRAINT "invitation_email_open_only" CHECK ((email IS NOT NULL) = (accepted_at IS NULL AND revoked_at IS NULL)),
	CONSTRAINT "invitation_final" CHECK (accepted_at IS NULL OR revoked_at IS NULL),
	CONSTRAINT "invitation_claimed" CHECK ((claimed_at IS NULL) = (claimed_auth_user_id IS NULL))
);
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_created_by_operator_operator_user_id_fk" FOREIGN KEY ("created_by_operator") REFERENCES "public"."operator_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_member_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_revoked_by_fk" FOREIGN KEY ("tenant_id","revoked_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitation_member_idx" ON "invitation" USING btree ("tenant_id","tenant_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_one_open_key" ON "invitation" USING btree ("tenant_id","tenant_user_id") WHERE accepted_at IS NULL AND revoked_at IS NULL;--> statement-breakpoint

-- Invitations (PLAT-004; platform.md, Invitations and MFA enrolment; hazard HZ-011; #43 review
-- round 1, M2 to M4): the ADR-0002 patterns, and security-definer functions owned by their own
-- NOLOGIN role, harbour_invitation_owner (as the membership lookup is owned by
-- harbour_membership_reader), for what must happen before an organisation is chosen. Runs as
-- harbour_owner.
ALTER TABLE public.invitation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.invitation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.invitation AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
-- Who sees an invitation: the organisation's view, roles across the organisation or at locations
-- (the API narrows them to the members platform.user.manage reaches), and the member it is for.
CREATE POLICY invitation_scope ON public.invitation AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.current_scope() IN ('tenant', 'locations') OR tenant_user_id = app.current_user_id())
  WITH CHECK (app.current_scope() IN ('tenant', 'locations')
    OR tenant_user_id = app.current_user_id());
--> statement-breakpoint
-- The definer functions find an invitation by its token's hash in any organisation, then work in
-- that organisation.
CREATE POLICY invitation_owner ON public.invitation AS PERMISSIVE FOR ALL
  TO harbour_invitation_owner USING (true) WITH CHECK (true);
--> statement-breakpoint

-- Whether the session's member may invite the member (#43 review M3): they hold
-- platform.user.manage across the organisation or at a location where the member has a role, and
-- every permission of each of the member's roles and grants where it applies, so no one hands out
-- more than they hold. Invoker rights: it reads under the caller's row-level security.
CREATE OR REPLACE FUNCTION app.may_invite(p_member uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT (app.holds_permission_at('platform.user.manage', NULL)
      OR EXISTS (
        SELECT 1 FROM public.role_assignment ra
        WHERE ra.tenant_id = app.current_tenant_id() AND ra.tenant_user_id = p_member
          AND ra.deleted_at IS NULL AND ra.location_id IS NOT NULL
          AND app.holds_permission_at('platform.user.manage', ra.location_id)))
    AND NOT EXISTS (
      SELECT 1
      FROM public.role_assignment ra
      JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
      CROSS JOIN LATERAL unnest(r.permissions) AS p(permission)
      WHERE ra.tenant_id = app.current_tenant_id() AND ra.tenant_user_id = p_member
        AND ra.deleted_at IS NULL AND r.deleted_at IS NULL AND r.archived_at IS NULL
        AND (ra.valid_to IS NULL OR ra.valid_to > now())
        AND NOT app.holds_permission_at(p.permission, ra.location_id))
    AND NOT EXISTS (
      SELECT 1
      FROM public.access_grant g
      CROSS JOIN LATERAL unnest(g.permissions) AS p(permission)
      WHERE g.tenant_id = app.current_tenant_id() AND g.tenant_user_id = p_member
        AND g.deleted_at IS NULL AND g.revoked_at IS NULL AND g.valid_to > now()
        AND NOT app.holds_permission_at(p.permission, g.location_id))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.may_invite(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.may_invite(uuid) TO harbour_app;
--> statement-breakpoint
-- A member sends an invitation in their own name (the session's member, never one the request
-- names), only to a member they may invite (#43 review round 2, N2). Operators never write
-- invitations directly (no grant on the table); the first owner's comes through
-- app.invite_first_owner.
CREATE POLICY invitation_issue ON public.invitation AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (created_by_operator IS NULL AND created_by IS NOT NULL
    AND created_by = app.current_user_id() AND app.may_invite(tenant_user_id));
--> statement-breakpoint

-- A new invitation is open, made now, lapses in the future, and is for a member still invited,
-- with no sign-in and a second factor required; its address is the member's, copied here, never
-- taken from the request (#43 review M3).
CREATE OR REPLACE FUNCTION app.invitation_issue() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_member record;
BEGIN
  IF num_nonnulls(NEW.accepted_at, NEW.accepted_auth_user_id, NEW.revoked_at, NEW.revoked_by,
       NEW.revocation_reason) > 0 THEN
    RAISE EXCEPTION 'An invitation is sent open, neither accepted nor revoked'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- The sender (N2): inside app.invite_first_owner (its owner is the current user) an operator
  -- and no member; anywhere else the session's member, and no operator.
  IF current_user = 'harbour_invitation_owner' THEN
    IF NEW.created_by IS NOT NULL OR NEW.created_by_operator IS NULL THEN
      RAISE EXCEPTION 'The first owner''s invitation is sent by an operator, not a member'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.created_by_operator IS NOT NULL OR NEW.created_by IS NULL
     OR NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'An invitation is sent in the name of the member sending it'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.created_at := now();
  IF NEW.expires_at <= NEW.created_at THEN
    RAISE EXCEPTION 'An invitation lapses in the future' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, auth_user_id, email, mfa_required INTO v_member FROM public.tenant_user
    WHERE tenant_id = NEW.tenant_id AND id = NEW.tenant_user_id AND deleted_at IS NULL;
  IF NOT FOUND OR v_member.status <> 'invited' OR v_member.auth_user_id IS NOT NULL
     OR NOT v_member.mfa_required THEN
    RAISE EXCEPTION 'Only a member still invited, with no sign-in and a second factor required, is sent an invitation'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.email := lower(btrim(v_member.email));
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invitation_issue BEFORE INSERT ON public.invitation
  FOR EACH ROW EXECUTE FUNCTION app.invitation_issue();
--> statement-breakpoint
-- Single use: an invitation keeps its member, link, sender and expiry; it changes only by being
-- accepted or revoked, once, its address cleared then (#43 review M4); accepted or revoked is
-- final. Accepted only inside app.accept_invitation, before it lapses. Revoked in the reviser's
-- name, or with no reviser only inside a function owned by harbour_invitation_owner (round 2, N1):
-- the sweep (expired, once lapsed), the member-change trigger (member_removed, member_changed) or
-- the first owner's re-invitation (superseded). The definer path is recognised by current_user,
-- which inside a SECURITY DEFINER function is its owner. The times are the server's.
CREATE OR REPLACE FUNCTION app.invitation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_definer boolean := current_user = 'harbour_invitation_owner';
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.tenant_user_id, NEW.token_hash, NEW.created_at, NEW.created_by,
      NEW.created_by_operator, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.tenant_user_id, OLD.token_hash, OLD.created_at, OLD.created_by,
      OLD.created_by_operator, OLD.expires_at) THEN
    RAISE EXCEPTION 'An invitation keeps its member, link, sender and expiry'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'An accepted or revoked invitation is final'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- A claim: the sign-in an acceptance created is recorded before it is linked, once, while the
  -- invitation is open, only inside app.record_invitation_sign_in.
  IF NEW.accepted_at IS NULL AND NEW.revoked_at IS NULL THEN
    IF NOT v_definer OR OLD.expires_at <= now() OR NEW.claimed_auth_user_id IS NULL
       OR OLD.claimed_auth_user_id IS NOT NULL OR NEW.email IS DISTINCT FROM OLD.email THEN
      RAISE EXCEPTION 'An invitation changes only by being claimed, accepted or revoked'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.claimed_at := now();
    RETURN NEW;
  END IF;
  IF (NEW.claimed_auth_user_id, NEW.claimed_at)
     IS DISTINCT FROM (OLD.claimed_auth_user_id, OLD.claimed_at) THEN
    RAISE EXCEPTION 'An invitation''s claim is recorded on its own'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.accepted_at IS NOT NULL THEN
    IF NEW.revoked_at IS NOT NULL OR OLD.expires_at <= now() OR NOT v_definer
       OR app.current_user_id() IS DISTINCT FROM OLD.tenant_user_id THEN
      RAISE EXCEPTION 'An invitation is accepted once, before it lapses, by the member it is for'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.accepted_at := now();
  ELSE
    IF NEW.revoked_by IS NULL THEN
      IF NOT v_definer
         OR NOT ((NEW.revocation_reason = 'expired' AND OLD.expires_at <= now())
           OR NEW.revocation_reason IN ('member_removed', 'member_changed', 'superseded')) THEN
        RAISE EXCEPTION 'An invitation is revoked in the name of the member revoking it'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    ELSIF NEW.revoked_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'An invitation is revoked in the name of the member revoking it'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.revoked_at := now();
  END IF;
  NEW.email := NULL;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invitation_guard BEFORE UPDATE ON public.invitation
  FOR EACH ROW EXECUTE FUNCTION app.invitation_guard();
--> statement-breakpoint

-- The application may read every column but the token's hash, so a stored hash is never readable
-- as a credential (#43 review M2); insert an invitation's member, link, expiry and sender, never
-- its address (copied) or an operator (round 2, N2); and change only the revocation columns
-- (acceptance is app.accept_invitation's); no delete. Operators have no grant at all.
REVOKE ALL ON public.invitation FROM harbour_app;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, tenant_user_id, email, created_at, created_by, created_by_operator,
  expires_at, accepted_at, accepted_auth_user_id, revoked_at, revoked_by, revocation_reason)
  ON public.invitation TO harbour_app;
--> statement-breakpoint
GRANT INSERT (id, tenant_id, tenant_user_id, token_hash, expires_at, created_by)
  ON public.invitation TO harbour_app;
--> statement-breakpoint
GRANT UPDATE (revoked_at, revoked_by, revocation_reason, email) ON public.invitation TO harbour_app;
--> statement-breakpoint
REVOKE ALL ON public.invitation FROM harbour_operator, harbour_worker, harbour_sync;
--> statement-breakpoint

-- What harbour_invitation_owner's functions need, and nothing else.
GRANT USAGE ON SCHEMA public, app, auth TO harbour_invitation_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.invitation TO harbour_invitation_owner;
--> statement-breakpoint
GRANT SELECT, UPDATE (auth_user_id, status) ON public.tenant_user TO harbour_invitation_owner;
--> statement-breakpoint
GRANT SELECT ON public.tenant, public.role, public.role_assignment, public.rate_table
  TO harbour_invitation_owner;
--> statement-breakpoint
GRANT SELECT (id, auth_user_id, role, active) ON public.operator_user TO harbour_invitation_owner;
--> statement-breakpoint
CREATE POLICY invitation_owner_operator_check ON public.operator_user AS PERMISSIVE FOR SELECT
  TO harbour_invitation_owner USING (true);
--> statement-breakpoint
GRANT INSERT ON public.audit_event, public.record_version TO harbour_invitation_owner;
--> statement-breakpoint
GRANT SELECT (id, email) ON auth."user" TO harbour_invitation_owner;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_invitation_owner;
--> statement-breakpoint

-- The SHA-256 (hex) of a link's token, as the application stores it.
CREATE OR REPLACE FUNCTION app.invitation_token_hash(p_token text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  SELECT encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;
--> statement-breakpoint

-- Why an invitation cannot be accepted now (the codes of `acceptRefusal` in packages/domain), or
-- null. Reads the invitation, its organisation and its member as found.
CREATE OR REPLACE FUNCTION app.invitation_refusal(
  p_accepted_at timestamptz, p_revoked_at timestamptz, p_expires_at timestamptz,
  p_tenant_status text, p_member_status text, p_member_auth_user text)
RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN p_accepted_at IS NOT NULL THEN 'invitation_used'
    WHEN p_revoked_at IS NOT NULL THEN 'invitation_revoked'
    WHEN p_expires_at <= now() THEN 'invitation_expired'
    WHEN p_tenant_status NOT IN ('onboarding', 'active') THEN 'organisation_not_active'
    WHEN p_member_status IS DISTINCT FROM 'invited' OR p_member_auth_user IS NOT NULL
      THEN 'member_not_invited'
  END
$$;
--> statement-breakpoint

-- The lookup behind the link's page, before anyone is signed in: the organisation's name, the
-- address masked, the expiry and why it cannot be accepted, or no row for an unknown token. It
-- takes the raw token (never a stored hash) and changes nothing.
CREATE OR REPLACE FUNCTION app.invitation_for_token(p_token text)
RETURNS TABLE (invitation_id uuid, tenant_id uuid, organisation_name text, email_masked text,
  expires_at timestamptz, refusal text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_prev text := current_setting('app.tenant_id', true);
  v record;
BEGIN
  SELECT i.id, i.tenant_id, i.email, i.expires_at, i.accepted_at, i.revoked_at, i.tenant_user_id
    INTO v FROM public.invitation i WHERE i.token_hash = app.invitation_token_hash(p_token);
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM set_config('app.tenant_id', v.tenant_id::text, true);
  RETURN QUERY
    SELECT v.id, v.tenant_id, coalesce(t.brand_name, t.name),
      CASE WHEN v.email IS NULL THEN NULL
        ELSE left(v.email, 1) || '***' || substr(v.email, position('@' IN v.email)) END,
      v.expires_at,
      app.invitation_refusal(v.accepted_at, v.revoked_at, v.expires_at, t.status::text,
        tu.status::text, tu.auth_user_id)
    FROM public.tenant t
    JOIN public.tenant_user tu ON tu.tenant_id = t.id AND tu.id = v.tenant_user_id
    WHERE t.id = v.tenant_id;
  PERFORM set_config('app.tenant_id', coalesce(v_prev, ''), true);
END
$$;
--> statement-breakpoint

-- Step one of accepting (#43 review M2 and low): finds the invitation by the raw token, locks it
-- for the rest of the transaction, so a second attempt waits and then finds it used, and says why
-- it cannot be accepted (null when it can). The API creates a new sign-in only after this, in the
-- same transaction, and deletes it if anything after fails.
CREATE OR REPLACE FUNCTION app.claim_invitation(p_token text)
RETURNS TABLE (invitation_id uuid, tenant_id uuid, tenant_user_id uuid, email text, refusal text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_prev text := current_setting('app.tenant_id', true);
  v record;
BEGIN
  SELECT i.id, i.tenant_id, i.tenant_user_id, i.email, i.expires_at, i.accepted_at, i.revoked_at
    INTO v FROM public.invitation i WHERE i.token_hash = app.invitation_token_hash(p_token)
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM set_config('app.tenant_id', v.tenant_id::text, true);
  RETURN QUERY
    SELECT v.id, v.tenant_id, v.tenant_user_id, v.email,
      app.invitation_refusal(v.accepted_at, v.revoked_at, v.expires_at, t.status::text,
        tu.status::text, tu.auth_user_id)
    FROM public.tenant t
    JOIN public.tenant_user tu ON tu.tenant_id = t.id AND tu.id = v.tenant_user_id
    WHERE t.id = v.tenant_id;
  PERFORM set_config('app.tenant_id', coalesce(v_prev, ''), true);
END
$$;
--> statement-breakpoint

-- Step two: links the sign-in to the member and accepts the invitation, in the transaction that
-- claimed it. Refused unless the invitation can still be accepted, the sign-in's email is the
-- invitation's (read from auth.user here, never taken from the caller) and the sign-in is not
-- already a member of the organisation. Clears the address and writes the audit event. Returns
-- the organisation and the member.
CREATE OR REPLACE FUNCTION app.accept_invitation(p_token text, p_auth_user_id text)
RETURNS TABLE (tenant_id uuid, tenant_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_prev_tenant text := current_setting('app.tenant_id', true);
  v_prev_user text := current_setting('app.user_id', true);
  v_prev_scope text := current_setting('app.scope', true);
  v record;
  v_refusal text;
  v_email text;
BEGIN
  SELECT i.id, i.tenant_id, i.tenant_user_id, i.email, i.expires_at, i.accepted_at, i.revoked_at
    INTO v FROM public.invitation i WHERE i.token_hash = app.invitation_token_hash(p_token)
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM set_config('app.tenant_id', v.tenant_id::text, true);
  PERFORM set_config('app.scope', 'tenant', true);
  PERFORM set_config('app.user_id', v.tenant_user_id::text, true);
  SELECT app.invitation_refusal(v.accepted_at, v.revoked_at, v.expires_at, t.status::text,
      tu.status::text, tu.auth_user_id)
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
  UPDATE public.invitation SET accepted_at = now(), accepted_auth_user_id = p_auth_user_id
    WHERE id = v.id;
  UPDATE public.tenant_user SET auth_user_id = p_auth_user_id, status = 'active'
    WHERE public.tenant_user.tenant_id = v.tenant_id AND id = v.tenant_user_id
      AND status = 'invited' AND auth_user_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_invited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  INSERT INTO public.audit_event (tenant_id, actor_tenant_user_id, actor_auth_user_id,
      actor_role_keys, action, outcome, resource_type, resource_id)
    VALUES (v.tenant_id, v.tenant_user_id, p_auth_user_id, ARRAY[]::text[],
      'platform.invitation.accepted', 'success', 'invitation', v.id::text);
  PERFORM set_config('app.tenant_id', coalesce(v_prev_tenant, ''), true);
  PERFORM set_config('app.user_id', coalesce(v_prev_user, ''), true);
  PERFORM set_config('app.scope', coalesce(v_prev_scope, ''), true);
  RETURN QUERY SELECT v.tenant_id, v.tenant_user_id;
END
$$;
--> statement-breakpoint

-- A rate-table figure for an organisation on today's UK date: its own row first, then its
-- nation's, the UK's and all (as resolveRate chooses), or only the global rows when p_global_only.
CREATE OR REPLACE FUNCTION app.invitation_rate(p_tenant uuid, p_key text, p_global_only boolean)
RETURNS numeric
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT r.value FROM public.rate_table r, public.tenant t
  WHERE t.id = p_tenant AND r.key = p_key
    AND r.nation IN (t.nation::text, 'uk', 'all')
    AND r.valid_from <= (now() AT TIME ZONE 'Europe/London')::date
    AND (r.valid_to IS NULL OR r.valid_to > (now() AT TIME ZONE 'Europe/London')::date)
    AND (r.tenant_id IS NULL OR (NOT p_global_only AND r.tenant_id = p_tenant))
  ORDER BY r.tenant_id IS NOT NULL DESC,
    CASE r.nation WHEN t.nation::text THEN 3 WHEN 'uk' THEN 2 ELSE 1 END DESC
  LIMIT 1
$$;
--> statement-breakpoint

-- The first owner's invitation (#43 review M3; round 2, low): an operator invites only the
-- organisation's invited owner, and only while the organisation has no active member; any open
-- invitation is superseded. The operator is the one the operator middleware set for the
-- transaction (app.operator_id), checked here to be an active admin; the expiry is
-- invitation.expiry_hours (the organisation's figure, else the global one) capped at the global
-- invitation.expiry_hours_max. Only the token's hash comes from the caller; the address is the
-- member's. Audited in the organisation's chain, naming the operator.
CREATE OR REPLACE FUNCTION app.invite_first_owner(p_tenant uuid, p_token_hash text)
RETURNS TABLE (invitation_id uuid, tenant_user_id uuid, email text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_operator record;
  v_member uuid;
  v_invitation uuid;
  v_email text;
  v_hours numeric;
  v_max numeric;
  v_expires timestamptz;
BEGIN
  SELECT o.id, o.auth_user_id INTO v_operator FROM public.operator_user o
    WHERE o.id = nullif(current_setting('app.operator_id', true), '')::uuid
      AND o.active AND o.role = 'admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator_not_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  PERFORM set_config('app.scope', 'tenant', true);
  PERFORM set_config('app.user_id', '', true);
  IF EXISTS (SELECT 1 FROM public.tenant_user tu WHERE tu.tenant_id = p_tenant
             AND tu.status = 'active' AND tu.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'organisation_has_members' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  v_hours := app.invitation_rate(p_tenant, 'invitation.expiry_hours', false);
  v_max := app.invitation_rate(p_tenant, 'invitation.expiry_hours_max', true);
  IF v_hours IS NULL OR v_max IS NULL OR v_hours <= 0 OR v_max <= 0 THEN
    RAISE EXCEPTION 'invitation_expiry_not_set' USING ERRCODE = 'no_data_found';
  END IF;
  v_expires := now() + make_interval(secs => least(v_hours, v_max) * 3600);
  SELECT tu.id INTO v_member
    FROM public.tenant_user tu
    JOIN public.role_assignment ra ON ra.tenant_id = tu.tenant_id AND ra.tenant_user_id = tu.id
      AND ra.deleted_at IS NULL
    JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id AND r.key = 'owner'
    WHERE tu.tenant_id = p_tenant AND tu.status = 'invited' AND tu.auth_user_id IS NULL
      AND tu.deleted_at IS NULL
    ORDER BY tu.created_at LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'no_invited_owner' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE public.invitation SET revoked_at = now(), revoked_by = NULL,
      revocation_reason = 'superseded'
    WHERE public.invitation.tenant_id = p_tenant AND public.invitation.tenant_user_id = v_member
      AND accepted_at IS NULL AND revoked_at IS NULL;
  INSERT INTO public.invitation (tenant_id, tenant_user_id, token_hash, expires_at, created_by,
      created_by_operator)
    VALUES (p_tenant, v_member, p_token_hash, v_expires, NULL, v_operator.id)
    RETURNING id, public.invitation.email INTO v_invitation, v_email;
  INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action, outcome,
      resource_type, resource_id, scope)
    VALUES (p_tenant, v_operator.auth_user_id, ARRAY['thapsus_admin'], 'platform.invitation.sent',
      'success', 'invitation', v_invitation::text,
      jsonb_build_object('tenantUserId', v_member, 'expiresAt', v_expires, 'firstOwner', true,
        'operatorId', v_operator.id));
  RETURN QUERY SELECT v_invitation, v_member, v_email, v_expires;
END
$$;
--> statement-breakpoint

-- A member's open invitations end when the member changes (#43 review M3): their address, roles,
-- grants or status, because the invitation was checked against them when sent. In the name of the
-- member making the change, or with no reviser when a job with no member makes it (round 2, N1):
-- a SECURITY DEFINER trigger function owned by harbour_invitation_owner, so the guard recognises
-- it whoever changes the member.
CREATE OR REPLACE FUNCTION app.invitation_member_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_tenant uuid;
  v_member uuid;
  v_reason text := 'member_changed';
BEGIN
  IF TG_TABLE_NAME = 'tenant_user' THEN
    v_tenant := NEW.tenant_id;
    v_member := NEW.id;
    IF NEW.email IS NOT DISTINCT FROM OLD.email THEN
      IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
         OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('suspended', 'left')) THEN
        v_reason := 'member_removed';
      ELSE
        RETURN NULL;
      END IF;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    v_tenant := OLD.tenant_id;
    v_member := OLD.tenant_user_id;
  ELSE
    v_tenant := NEW.tenant_id;
    v_member := NEW.tenant_user_id;
  END IF;
  UPDATE public.invitation SET revoked_at = now(), revoked_by = app.current_user_id(),
      revocation_reason = v_reason
    WHERE tenant_id = v_tenant AND tenant_user_id = v_member
      AND accepted_at IS NULL AND revoked_at IS NULL;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invitation_member_changed AFTER UPDATE OF email, status, deleted_at
  ON public.tenant_user FOR EACH ROW EXECUTE FUNCTION app.invitation_member_changed();
--> statement-breakpoint
CREATE TRIGGER invitation_member_changed AFTER INSERT OR UPDATE OR DELETE ON public.role_assignment
  FOR EACH ROW EXECUTE FUNCTION app.invitation_member_changed();
--> statement-breakpoint
CREATE TRIGGER invitation_member_changed AFTER INSERT OR UPDATE OR DELETE ON public.access_grant
  FOR EACH ROW EXECUTE FUNCTION app.invitation_member_changed();
--> statement-breakpoint

-- Records the sign-in an acceptance created, in its own committed transaction before the
-- acceptance links it (#43 review round 2): the nightly sweep may then delete it if the
-- acceptance never completes, and never a sign-in the invitation path did not make.
CREATE OR REPLACE FUNCTION app.record_invitation_sign_in(p_token text, p_auth_user_id text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v record;
BEGIN
  SELECT i.id, i.tenant_id INTO v FROM public.invitation i
    WHERE i.token_hash = app.invitation_token_hash(p_token)
      AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
      AND i.claimed_auth_user_id IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.invitation SET claimed_auth_user_id = p_auth_user_id WHERE id = v.id;
  RETURN true;
END
$$;
--> statement-breakpoint

-- The sign-ins the nightly sweep deletes: made by an acceptance that never completed, recorded
-- more than invitation.unlinked_sign_in_hours (global rate) ago, and named by no membership in any
-- organisation. A sign-in the invitation path did not make is never returned.
CREATE OR REPLACE FUNCTION app.unlinked_invitation_sign_ins() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT i.claimed_auth_user_id FROM public.invitation i
  WHERE i.claimed_auth_user_id IS NOT NULL AND i.accepted_at IS NULL
    AND i.claimed_at <= now() - make_interval(secs => 3600 * (
      SELECT r.value FROM public.rate_table r
      WHERE r.key = 'invitation.unlinked_sign_in_hours' AND r.tenant_id IS NULL
        AND r.valid_from <= (now() AT TIME ZONE 'Europe/London')::date
        AND (r.valid_to IS NULL OR r.valid_to > (now() AT TIME ZONE 'Europe/London')::date)
      ORDER BY r.valid_from DESC LIMIT 1))
    AND NOT EXISTS (SELECT 1 FROM public.tenant_user tu
                    WHERE tu.auth_user_id = i.claimed_auth_user_id)
$$;
--> statement-breakpoint

-- The nightly sweep (#43 review M4 and low): every lapsed invitation still open is revoked as
-- expired, which clears its address and frees the member for a new invitation; one audit event
-- per invitation, in its organisation's chain. Returns how many.
CREATE OR REPLACE FUNCTION app.sweep_expired_invitations() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v record;
  n integer := 0;
BEGIN
  PERFORM set_config('app.user_id', '', true);
  PERFORM set_config('app.scope', 'tenant', true);
  FOR v IN SELECT i.id, i.tenant_id FROM public.invitation i
           WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at <= now()
           ORDER BY i.tenant_id, i.id FOR UPDATE LOOP
    PERFORM set_config('app.tenant_id', v.tenant_id::text, true);
    UPDATE public.invitation SET revoked_at = now(), revoked_by = NULL,
        revocation_reason = 'expired'
      WHERE id = v.id;
    INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
        outcome, resource_type, resource_id)
      VALUES (v.tenant_id, 'system', ARRAY['system'], 'platform.invitation.expired', 'success',
        'invitation', v.id::text);
    n := n + 1;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  RETURN n;
END
$$;
--> statement-breakpoint

ALTER FUNCTION app.invitation_for_token(text) OWNER TO harbour_invitation_owner;
--> statement-breakpoint
ALTER FUNCTION app.claim_invitation(text) OWNER TO harbour_invitation_owner;
--> statement-breakpoint
ALTER FUNCTION app.accept_invitation(text, text) OWNER TO harbour_invitation_owner;
--> statement-breakpoint
ALTER FUNCTION app.invite_first_owner(uuid, text) OWNER TO harbour_invitation_owner;
--> statement-breakpoint
ALTER FUNCTION app.invitation_member_changed() OWNER TO harbour_invitation_owner;
--> statement-breakpoint
ALTER FUNCTION app.record_invitation_sign_in(text, text) OWNER TO harbour_invitation_owner;
--> statement-breakpoint
ALTER FUNCTION app.unlinked_invitation_sign_ins() OWNER TO harbour_invitation_owner;
--> statement-breakpoint
ALTER FUNCTION app.sweep_expired_invitations() OWNER TO harbour_invitation_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_invitation_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.invitation_for_token(text), app.claim_invitation(text),
  app.accept_invitation(text, text), app.invite_first_owner(uuid, text),
  app.invitation_member_changed(), app.record_invitation_sign_in(text, text),
  app.unlinked_invitation_sign_ins(), app.sweep_expired_invitations() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.invitation_for_token(text), app.claim_invitation(text),
  app.record_invitation_sign_in(text, text), app.accept_invitation(text, text) TO harbour_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.invite_first_owner(uuid, text) TO harbour_operator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sweep_expired_invitations(), app.unlinked_invitation_sign_ins()
  TO harbour_worker;
