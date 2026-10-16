CREATE TABLE "dpia" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"dpia_version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"prefill" jsonb NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"residual_risk" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ico_reference" text,
	"prepared_by" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"version_sha256" text,
	"prepared_at" timestamp with time zone,
	"signed_by" uuid,
	"signed_at" timestamp with time zone,
	"typed_name" text,
	"statement" text,
	"basis" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "dpia_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "dpia_tenant_version_key" UNIQUE("tenant_id","dpia_version"),
	CONSTRAINT "dpia_status" CHECK (status IN ('draft', 'prepared', 'signed', 'superseded')),
	CONSTRAINT "dpia_version" CHECK (dpia_version >= 1),
	CONSTRAINT "dpia_prepared" CHECK (status = 'draft' OR (version_sha256 ~ '^[0-9a-f]{64}$' AND prepared_at IS NOT NULL)),
	CONSTRAINT "dpia_signed" CHECK ((status IN ('signed', 'superseded')) = (signed_by IS NOT NULL AND signed_at IS NOT NULL
        AND typed_name IS NOT NULL AND statement IS NOT NULL AND basis IS NOT NULL)),
	CONSTRAINT "dpia_signer_not_preparer" CHECK (signed_by IS NULL OR NOT (signed_by = ANY (prepared_by)))
);
--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "data_protection_lead_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "sector" text DEFAULT 'independent' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "privacy_notice_url" text;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "dpa_signed_on" date;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "uses_data_beyond_direct_care" boolean;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "marketing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "ai_free_text_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "ai_provider" text;--> statement-breakpoint
ALTER TABLE "dpia" ADD CONSTRAINT "dpia_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpia" ADD CONSTRAINT "dpia_signed_by_fk" FOREIGN KEY ("tenant_id","signed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dpia_one_open_key" ON "dpia" USING btree ("tenant_id") WHERE status IN ('draft', 'prepared');--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_sector" CHECK (sector IN ('independent', 'public'));--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_ai_provider" CHECK (ai_provider IS NULL OR ai_provider IN ('bedrock_london', 'bedrock_eu', 'anthropic', 'tenant_own'));--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_privacy_notice_url" CHECK (privacy_notice_url IS NULL OR privacy_notice_url ~ '^https://');
--> statement-breakpoint

-- The DPIA and data protection governance (PLAT-023; platform-completions.md rules 17 to 22;
-- section 5.1). The named lead is one of the organisation's own members; one signed DPIA at a
-- time; forced RLS; reading needs a DPIA permission, preparing platform.dpia.prepare, signing
-- platform.dpia.sign by the named lead, in their own name, who prepared none of the version; a
-- signed version never changes except to be superseded, and nothing is ever deleted.
ALTER TABLE public.tenant ADD CONSTRAINT tenant_data_protection_lead_fk
  FOREIGN KEY (id, data_protection_lead_id) REFERENCES public.tenant_user (tenant_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX dpia_one_signed_key ON public.dpia (tenant_id) WHERE status = 'signed';
--> statement-breakpoint
ALTER TABLE public.dpia ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.dpia FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.dpia AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY dpia_read ON public.dpia AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.holds_role_permission_somewhere('platform.dpia.read')
    OR app.holds_role_permission_somewhere('platform.dpia.prepare')
    OR app.holds_role_permission_somewhere('platform.dpia.sign'));
--> statement-breakpoint
CREATE POLICY dpia_write ON public.dpia AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (status = 'draft' AND app.current_user_id() = ANY (prepared_by)
    AND app.holds_role_permission_somewhere('platform.dpia.prepare'));
--> statement-breakpoint
CREATE POLICY dpia_change ON public.dpia AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.holds_role_permission_somewhere('platform.dpia.prepare')
    OR app.holds_role_permission_somewhere('platform.dpia.sign'))
  WITH CHECK (app.holds_role_permission_somewhere('platform.dpia.prepare')
    OR app.holds_role_permission_somewhere('platform.dpia.sign'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.dpia_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_me uuid := app.current_user_id();
  v_content_changed boolean;
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.dpia_version, NEW.created_at, NEW.created_by)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.dpia_version, OLD.created_at, OLD.created_by)
     OR NEW.deleted_at IS NOT NULL OR NOT (OLD.prepared_by <@ NEW.prepared_by) THEN
    RAISE EXCEPTION 'A DPIA version keeps its identity and preparers, and is never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  v_content_changed := (NEW.prefill, NEW.answers, NEW.residual_risk, NEW.ico_reference)
    IS DISTINCT FROM (OLD.prefill, OLD.answers, OLD.residual_risk, OLD.ico_reference);
  IF OLD.status IN ('signed', 'superseded') THEN
    -- Signed is final: it may only be superseded by a later version, nothing else changes.
    IF NOT (OLD.status = 'signed' AND NEW.status = 'superseded')
       OR v_content_changed
       OR (NEW.prepared_by, NEW.version_sha256, NEW.prepared_at, NEW.signed_by, NEW.signed_at,
           NEW.typed_name, NEW.statement, NEW.basis)
          IS DISTINCT FROM
          (OLD.prepared_by, OLD.version_sha256, OLD.prepared_at, OLD.signed_by, OLD.signed_at,
           OLD.typed_name, OLD.statement, OLD.basis) THEN
      RAISE EXCEPTION 'A signed DPIA never changes; a later version supersedes it'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'signed' THEN
    IF OLD.status <> 'prepared' OR v_content_changed
       OR NEW.version_sha256 IS DISTINCT FROM OLD.version_sha256
       OR NEW.signed_by IS DISTINCT FROM v_me
       OR NEW.signed_by IS DISTINCT FROM (SELECT t.data_protection_lead_id FROM public.tenant t
                                          WHERE t.id = NEW.tenant_id)
       OR NOT app.holds_role_permission_somewhere('platform.dpia.sign') THEN
      RAISE EXCEPTION 'A prepared DPIA is signed, unchanged, by the named data protection lead in their own name'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('draft', 'prepared')
     OR NOT app.holds_role_permission_somewhere('platform.dpia.prepare') THEN
    RAISE EXCEPTION 'A DPIA is prepared by a holder of platform.dpia.prepare'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Whoever changes or prepares a version is one of its preparers, so they cannot sign it.
  IF v_me IS NOT NULL AND NOT (v_me = ANY (NEW.prepared_by)) THEN
    NEW.prepared_by := array_append(NEW.prepared_by, v_me);
  END IF;
  -- Changing a prepared version returns it to draft; preparing freezes it unchanged.
  IF v_content_changed AND NEW.status = 'prepared' THEN
    RAISE EXCEPTION 'Mark the DPIA prepared without changing it'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'draft' THEN
    NEW.version_sha256 := NULL;
    NEW.prepared_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER dpia_guard BEFORE UPDATE ON public.dpia
  FOR EACH ROW EXECUTE FUNCTION app.dpia_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.dpia
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.dpia
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
