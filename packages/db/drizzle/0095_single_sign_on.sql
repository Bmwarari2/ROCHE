CREATE TABLE "auth"."sso_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" text,
	"provider_id" text NOT NULL,
	"organization_id" text,
	"domain" text NOT NULL,
	CONSTRAINT "sso_provider_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
CREATE TABLE "sso_connection" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"provider_id" text NOT NULL,
	"issuer" text NOT NULL,
	"discovery_url" text NOT NULL,
	"client_id" text NOT NULL,
	"private_key_ref" text NOT NULL,
	"private_key_id" text,
	"allowed_role_keys" text[] NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sso_connection_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "sso_connection_provider_id_key" UNIQUE("provider_id"),
	CONSTRAINT "sso_connection_provider_id" CHECK (provider_id = 'harbour-' || tenant_id::text),
	CONSTRAINT "sso_connection_https" CHECK (issuer ~ '^https://' AND discovery_url ~ '^https://'),
	CONSTRAINT "sso_connection_key_ref" CHECK (private_key_ref ~ '^harbour/sso/[a-z0-9][a-z0-9-]{0,62}(/[a-z0-9][a-z0-9-]{0,62}){0,2}$'),
	CONSTRAINT "sso_connection_client_id" CHECK (length(btrim(client_id)) > 0),
	CONSTRAINT "sso_connection_roles" CHECK (cardinality(allowed_role_keys) > 0)
);
--> statement-breakpoint
CREATE TABLE "sso_domain" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"domain" text NOT NULL,
	"token_sha256" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sso_domain_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "sso_domain_domain" CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9.-]+\.[a-z0-9-]+$'),
	CONSTRAINT "sso_domain_token" CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sso_domain_verified" CHECK ((verified_at IS NULL) = (verified_by IS NULL))
);
--> statement-breakpoint
ALTER TABLE "auth"."sso_provider" ADD CONSTRAINT "sso_provider_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connection" ADD CONSTRAINT "sso_connection_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_domain" ADD CONSTRAINT "sso_domain_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_domain" ADD CONSTRAINT "sso_domain_verified_by_fk" FOREIGN KEY ("tenant_id","verified_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_connection_one_per_tenant_key" ON "sso_connection" USING btree ("tenant_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_domain_tenant_domain_key" ON "sso_domain" USING btree ("tenant_id","domain") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_domain_verified_once_key" ON "sso_domain" USING btree ("domain") WHERE verified_at IS NOT NULL AND removed_at IS NULL;--> statement-breakpoint
-- Security (ADR-0002, ADR-0091): forced RLS, the tenant policy, and only holders of
-- platform.tenant.manage read or change the configuration. No DELETE grant for harbour_app (default
-- privileges); a connection is switched off and a domain removed, never deleted.
ALTER TABLE public.sso_connection ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sso_connection FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.sso_connection AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY sso_connection_manage ON public.sso_connection AS RESTRICTIVE FOR ALL TO harbour_app
  USING (app.holds_role_permission_somewhere('platform.tenant.manage'))
  WITH CHECK (app.holds_role_permission_somewhere('platform.tenant.manage'));
--> statement-breakpoint
ALTER TABLE public.sso_domain ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sso_domain FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.sso_domain AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY sso_domain_manage ON public.sso_domain AS RESTRICTIVE FOR ALL TO harbour_app
  USING (app.holds_role_permission_somewhere('platform.tenant.manage'))
  WITH CHECK (app.holds_role_permission_somewhere('platform.tenant.manage'));
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.sso_connection
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.sso_connection
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.sso_domain
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.sso_domain
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
-- What the SSO functions read, and nothing else (as migration 0054 for invitations).
GRANT SELECT (tenant_id, provider_id, private_key_ref, allowed_role_keys, enabled, deleted_at)
  ON public.sso_connection TO harbour_invitation_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, domain, verified_at, removed_at) ON public.sso_domain
  TO harbour_invitation_owner;
--> statement-breakpoint
-- The facts the SSO callback needs to run ssoSignInDecision (rules 15, 16, 20) before anyone is
-- signed in: the connection (with its key's store name, never the key), the verified domains and the member with that email, in the
-- organisation the provider id names. Changes nothing; returns no row for a provider Harbour did
-- not make.
CREATE OR REPLACE FUNCTION app.sso_sign_in_facts(p_provider_id text, p_email text)
RETURNS TABLE (tenant_id uuid, enabled boolean, private_key_ref text, allowed_role_keys text[],
  verified_domains text[],
  member_id uuid, member_email text, member_status text, member_auth_user_id text,
  member_role_keys text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_prev_tenant text := current_setting('app.tenant_id', true);
  v_prev_scope text := current_setting('app.scope', true);
  v_tenant uuid;
BEGIN
  IF p_provider_id !~ '^harbour-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN;
  END IF;
  v_tenant := substring(p_provider_id FROM 9)::uuid;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  PERFORM set_config('app.scope', 'tenant', true);
  RETURN QUERY
    SELECT c.tenant_id, c.enabled, c.private_key_ref, c.allowed_role_keys,
      coalesce((SELECT array_agg(d.domain ORDER BY d.domain) FROM public.sso_domain d
                WHERE d.tenant_id = c.tenant_id AND d.verified_at IS NOT NULL
                  AND d.removed_at IS NULL), ARRAY[]::text[]),
      tu.id, tu.email, tu.status::text, tu.auth_user_id,
      coalesce((SELECT array_agg(DISTINCT r.key ORDER BY r.key)
                FROM public.role_assignment ra
                JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
                WHERE ra.tenant_id = c.tenant_id AND ra.tenant_user_id = tu.id
                  AND ra.deleted_at IS NULL AND r.deleted_at IS NULL AND r.archived_at IS NULL
                  AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())),
               ARRAY[]::text[])
    FROM public.sso_connection c
    LEFT JOIN public.tenant_user tu ON tu.tenant_id = c.tenant_id AND tu.deleted_at IS NULL
      AND lower(btrim(tu.email)) = lower(btrim(p_email))
    WHERE c.tenant_id = v_tenant AND c.provider_id = p_provider_id AND c.deleted_at IS NULL
    LIMIT 1;
  PERFORM set_config('app.tenant_id', coalesce(v_prev_tenant, ''), true);
  PERFORM set_config('app.scope', coalesce(v_prev_scope, ''), true);
END
$$;
--> statement-breakpoint
-- Links an invited member to the sign-in an SSO callback created (rule 20): only while the
-- connection is on, only for the address of that sign-in, only at a verified domain, only an
-- invited member with no sign-in. Audited in the organisation's chain.
CREATE OR REPLACE FUNCTION app.link_sso_member(p_provider_id text, p_auth_user_id text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
REVOKE ALL ON FUNCTION app.sso_sign_in_facts(text, text), app.link_sso_member(text, text)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sso_sign_in_facts(text, text), app.link_sso_member(text, text)
  TO harbour_app;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_invitation_owner;
--> statement-breakpoint
ALTER FUNCTION app.sso_sign_in_facts(text, text) OWNER TO harbour_invitation_owner;
--> statement-breakpoint
ALTER FUNCTION app.link_sso_member(text, text) OWNER TO harbour_invitation_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_invitation_owner;
