CREATE TABLE "tenant_export" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"kind" text DEFAULT 'full' NOT NULL,
	"since" timestamp with time zone,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"snapshot_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"schema_version" text,
	"storage_key" text,
	"bytes" bigint,
	"manifest_sha256" text,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"downloaded_at" timestamp with time zone,
	"downloaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tenant_export_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_export_kind" CHECK (kind IN ('full', 'changes_since')),
	CONSTRAINT "tenant_export_since" CHECK ((kind = 'changes_since') = (since IS NOT NULL)),
	CONSTRAINT "tenant_export_status" CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired', 'revoked')),
	CONSTRAINT "tenant_export_ready" CHECK (status <> 'ready' OR (ready_at IS NOT NULL AND expires_at IS NOT NULL
        AND storage_key IS NOT NULL AND manifest_sha256 IS NOT NULL AND snapshot_at IS NOT NULL)),
	CONSTRAINT "tenant_export_revoked" CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)),
	CONSTRAINT "tenant_export_failed" CHECK ((status = 'failed') = (failed_at IS NOT NULL)),
	CONSTRAINT "tenant_export_downloaded" CHECK ((downloaded_at IS NULL) = (downloaded_by IS NULL)
        AND (downloaded_by IS NULL OR downloaded_by = requested_by)),
	CONSTRAINT "tenant_export_storage_key" CHECK (storage_key IS NULL OR storage_key = 'tenants/' || tenant_id || '/exports/' || id || '/export.zip'),
	CONSTRAINT "tenant_export_manifest_sha256" CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tenant_export_bytes" CHECK (bytes IS NULL OR bytes >= 0)
);
--> statement-breakpoint
ALTER TABLE "tenant_export" ADD CONSTRAINT "tenant_export_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_export" ADD CONSTRAINT "tenant_export_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_export" ADD CONSTRAINT "tenant_export_revoked_by_fk" FOREIGN KEY ("tenant_id","revoked_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_export" ADD CONSTRAINT "tenant_export_downloaded_by_fk" FOREIGN KEY ("tenant_id","downloaded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_export_one_running_key" ON "tenant_export" USING btree ("tenant_id") WHERE status IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "tenant_export_requested_idx" ON "tenant_export" USING btree ("tenant_id","requested_at");--> statement-breakpoint

-- The free full export (PLAT-015; platform-completions.md rules 12 to 15; hazards HZ-011 and
-- HZ-070). Follows 0060 (#71, members) and 0061 (#75, family feed).
-- The ADR-0002 patterns, then: only holders of platform.export.create across the organisation
-- (the owner) see or change an export, and the export worker (no member, the organisation's view);
-- a request is queued in the requester's own name; the guard keeps who asked and what was asked,
-- moves the status forward only, and records the single download, by the requester only, once.
ALTER TABLE public.tenant_export ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.tenant_export FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.tenant_export AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_export_permission ON public.tenant_export AS RESTRICTIVE FOR ALL
  TO harbour_app
  USING ((app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
    OR app.holds_permission_at('platform.export.create', NULL))
  WITH CHECK ((app.current_user_id() IS NULL AND app.current_scope() = 'tenant')
    OR app.holds_permission_at('platform.export.create', NULL));
--> statement-breakpoint
CREATE POLICY tenant_export_request ON public.tenant_export AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (status = 'queued' AND requested_by = app.current_user_id()
    AND storage_key IS NULL AND downloaded_at IS NULL);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.tenant_export_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.kind, NEW.since, NEW.requested_by, NEW.requested_at,
      NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.kind, OLD.since, OLD.requested_by, OLD.requested_at,
      OLD.created_at, OLD.created_by)
     OR NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'An export keeps who asked for it and what was asked, and is never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- What a ready export was built from and where it is kept never changes after (#77 review L2).
  IF OLD.status IN ('ready', 'expired', 'revoked') AND OLD.ready_at IS NOT NULL
     AND (NEW.storage_key, NEW.manifest_sha256, NEW.snapshot_at, NEW.expires_at, NEW.ready_at,
          NEW.bytes, NEW.schema_version)
       IS DISTINCT FROM
         (OLD.storage_key, OLD.manifest_sha256, OLD.snapshot_at, OLD.expires_at, OLD.ready_at,
          OLD.bytes, OLD.schema_version) THEN
    RAISE EXCEPTION 'A ready export keeps its archive, manifest, snapshot and expiry'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('failed', 'expired', 'revoked') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'A % export is final', OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'revoked'))
    OR (OLD.status = 'running' AND NEW.status IN ('ready', 'failed', 'revoked'))
    OR (OLD.status = 'ready' AND NEW.status IN ('expired', 'revoked'))) THEN
    RAISE EXCEPTION 'An export cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'revoked' AND OLD.status <> 'revoked'
     AND NEW.revoked_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'An export is revoked in the name of the member doing it'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- The single download (rule 12, one-time fetch): set once, by the requester, while ready.
  IF (NEW.downloaded_at, NEW.downloaded_by) IS DISTINCT FROM (OLD.downloaded_at, OLD.downloaded_by)
     AND (OLD.downloaded_at IS NOT NULL OR OLD.status <> 'ready' OR NEW.status <> 'ready'
       OR NEW.downloaded_by IS DISTINCT FROM app.current_user_id()
       OR OLD.expires_at <= now()) THEN
    RAISE EXCEPTION 'An export is downloaded once, by the person who asked for it, while it is ready'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_export_guard BEFORE UPDATE ON public.tenant_export
  FOR EACH ROW EXECUTE FUNCTION app.tenant_export_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.tenant_export
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.tenant_export
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint

-- Data migration (platform-completions.md section 3): the export permission was renamed from
-- platform.data.export to platform.export.create. The export needs it across the organisation, so
-- it is renamed only in roles scoped to the organisation and in grants across it; elsewhere the old
-- name, which nothing reads, is removed (#77 review L3). Each role change is a new version; every
-- role and grant changed is audited per tenant. Idempotent.
ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.access_grant NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.role
           UNION SELECT DISTINCT tenant_id FROM public.access_grant ORDER BY 1 LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    WITH changed AS (
      UPDATE public.role r
         SET permissions = CASE
           WHEN r.scope_kind::text <> 'tenant' OR 'platform.export.create' = ANY (r.permissions)
             THEN array_remove(r.permissions, 'platform.data.export')
           ELSE array_replace(r.permissions, 'platform.data.export', 'platform.export.create') END
       WHERE r.tenant_id = t AND 'platform.data.export' = ANY (r.permissions)
       RETURNING r.id, r.key, 'platform.export.create' = ANY (r.permissions) AS holds
    )
    INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
        outcome, resource_type, resource_id, scope, reason)
      SELECT t, 'system', ARRAY['system'], 'platform.role.permissions_migrated', 'success',
        'role', c.id::text,
        jsonb_build_object('migration', '0062_tenant_export', 'roleKey', c.key,
          'removed', 'platform.data.export', 'holdsExport', c.holds),
        'The export permission was renamed (migration 0062)'
      FROM changed c;
    WITH changed AS (
      UPDATE public.access_grant g
         SET permissions = CASE
           WHEN g.location_id IS NOT NULL OR 'platform.export.create' = ANY (g.permissions)
             THEN array_remove(g.permissions, 'platform.data.export')
           ELSE array_replace(g.permissions, 'platform.data.export', 'platform.export.create') END
       WHERE g.tenant_id = t AND 'platform.data.export' = ANY (g.permissions)
       RETURNING g.id, 'platform.export.create' = ANY (g.permissions) AS holds
    )
    INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
        outcome, resource_type, resource_id, scope, reason)
      SELECT t, 'system', ARRAY['system'], 'platform.grant.permissions_migrated', 'success',
        'access_grant', c.id::text,
        jsonb_build_object('migration', '0062_tenant_export', 'removed', 'platform.data.export',
          'holdsExport', c.holds),
        'The export permission was renamed (migration 0062)'
      FROM changed c;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.access_grant FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.role FORCE ROW LEVEL SECURITY;
