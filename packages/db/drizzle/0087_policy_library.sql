CREATE TABLE "policy" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"policy_key" text NOT NULL,
	"title" text NOT NULL,
	"require_second_reviewer" boolean DEFAULT false NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "policy_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "policy_key_key" UNIQUE("tenant_id","policy_key"),
	CONSTRAINT "policy_key_format" CHECK (policy_key ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "policy_title" CHECK (length(btrim(title)) BETWEEN 2 AND 160),
	CONSTRAINT "policy_retired" CHECK ((retired_at IS NULL) = (retired_reason IS NULL)
        AND (retired_reason IS NULL OR length(btrim(retired_reason)) >= 10))
);
--> statement-breakpoint
CREATE TABLE "policy_signature" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"policy_version_id" uuid NOT NULL,
	"signer_id" uuid DEFAULT app.current_user_id() NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "policy_signature_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "policy_signature_once_key" UNIQUE("tenant_id","policy_version_id","signer_id")
);
--> statement-breakpoint
CREATE TABLE "policy_version" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"policy_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"change" text NOT NULL,
	"change_summary" text NOT NULL,
	"body" text,
	"document_id" uuid,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"review_due_on" date,
	"author_id" uuid DEFAULT app.current_user_id() NOT NULL,
	"published_by" uuid,
	"published_on" date,
	"published_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"retired_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "policy_version_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "policy_version_number_key" UNIQUE("tenant_id","policy_id","version_number"),
	CONSTRAINT "policy_version_state" CHECK (state IN ('draft', 'published', 'superseded', 'retired')),
	CONSTRAINT "policy_version_change" CHECK (change IN ('minor', 'major')),
	CONSTRAINT "policy_version_number" CHECK (version_number >= 1),
	CONSTRAINT "policy_version_summary" CHECK (length(btrim(change_summary)) BETWEEN 2 AND 2000),
	CONSTRAINT "policy_version_content" CHECK ((body IS NOT NULL OR document_id IS NOT NULL) AND (body IS NULL OR length(body) <= 100000)),
	CONSTRAINT "policy_version_roles" CHECK (array_position(roles, NULL) IS NULL AND cardinality(roles) <= 40),
	CONSTRAINT "policy_version_published" CHECK ((state IN ('published', 'superseded', 'retired') AND published_by IS NOT NULL
             AND published_on IS NOT NULL AND published_at IS NOT NULL)
        OR (state = 'draft' AND published_by IS NULL AND published_on IS NULL AND published_at IS NULL)),
	CONSTRAINT "policy_version_review_date" CHECK (state = 'draft' OR published_on IS NULL OR review_due_on > published_on)
);
--> statement-breakpoint
ALTER TABLE "policy_signature" ADD CONSTRAINT "policy_signature_version_fk" FOREIGN KEY ("tenant_id","policy_version_id") REFERENCES "public"."policy_version"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_signature" ADD CONSTRAINT "policy_signature_signer_fk" FOREIGN KEY ("tenant_id","signer_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_version" ADD CONSTRAINT "policy_version_policy_fk" FOREIGN KEY ("tenant_id","policy_id") REFERENCES "public"."policy"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_version" ADD CONSTRAINT "policy_version_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_version" ADD CONSTRAINT "policy_version_author_fk" FOREIGN KEY ("tenant_id","author_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_version" ADD CONSTRAINT "policy_version_published_by_fk" FOREIGN KEY ("tenant_id","published_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "policy_signature_signer_idx" ON "policy_signature" USING btree ("tenant_id","signer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_version_one_draft_key" ON "policy_version" USING btree ("tenant_id","policy_id") WHERE state = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "policy_version_one_published_key" ON "policy_version" USING btree ("tenant_id","policy_id") WHERE state = 'published';
--> statement-breakpoint

-- The policy library and read-and-sign (slice 25; quality.md section 18; QUAL-008; HZ-128): the
-- ADR-0002 patterns; every member reads policies and the versions published, holders of
-- quality.policy.manage write them and read drafts; one draft and at most one published version
-- per policy; publishing, in the publisher's own name and never by the author where the policy needs
-- a second reviewer, supersedes the last version in the same transaction; a published version is
-- fixed but for its state; signatures only on the version in force, in the signer's own name,
-- append-only. Runs as harbour_owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['policy', 'policy_version', 'policy_signature'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.manages_policies() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.is_system() OR app.holds_permission_anywhere('quality.policy.manage')
$$;
--> statement-breakpoint

-- A policy whose only version is a draft is read only by holders of manage (security review
-- round 1, finding 5): its title is not shown to staff before it is published.
CREATE POLICY policy_read ON public.policy AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.manages_policies() OR EXISTS (
    SELECT 1 FROM public.policy_version v WHERE v.policy_id = policy.id AND v.state <> 'draft'));
--> statement-breakpoint
CREATE POLICY policy_write ON public.policy AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.manages_policies());
--> statement-breakpoint
CREATE POLICY policy_change ON public.policy AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.manages_policies()) WITH CHECK (app.manages_policies());
--> statement-breakpoint
-- Drafts are read only by holders of manage; every member reads what was published.
CREATE POLICY policy_version_read ON public.policy_version AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (state <> 'draft' OR app.manages_policies());
--> statement-breakpoint
CREATE POLICY policy_version_draft ON public.policy_version AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.manages_policies()
    AND (app.is_system() OR author_id = app.current_user_id()));
--> statement-breakpoint
CREATE POLICY policy_version_change ON public.policy_version AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.manages_policies()) WITH CHECK (app.manages_policies());
--> statement-breakpoint

-- A new version is a draft numbered next, by its author, for a policy not retired; its document,
-- if any, is an organisation document about no one.
CREATE OR REPLACE FUNCTION app.policy_version_draft() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM 'draft' OR NEW.published_by IS NOT NULL
     OR NEW.published_at IS NOT NULL OR NEW.published_on IS NOT NULL THEN
    RAISE EXCEPTION 'A policy version starts as a draft' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.policy p WHERE p.id = NEW.policy_id AND p.retired_at IS NOT NULL) THEN
    RAISE EXCEPTION 'A retired policy takes no new version' USING ERRCODE = 'check_violation';
  END IF;
  NEW.version_number := COALESCE(
    (SELECT max(v.version_number) FROM public.policy_version v WHERE v.policy_id = NEW.policy_id), 0) + 1;
  PERFORM app.policy_document_check(NEW.document_id);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.policy_document_check(p_document_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.document d
    WHERE d.id = p_document_id AND d.category = 'organisation_document' AND d.person_id IS NULL
      AND d.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'A policy''s document is one of the organisation''s documents'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TRIGGER policy_version_draft BEFORE INSERT ON public.policy_version
  FOR EACH ROW EXECUTE FUNCTION app.policy_version_draft();
--> statement-breakpoint

-- HZ-128: a draft changes freely; publishing is in the publisher's own name by a holder of manage,
-- never the author where the policy needs a second reviewer, for at least one role, with a review
-- date after the UK date of publication, and supersedes the version in force first; a published
-- version only becomes superseded (by the next publication) or retired (with a reason, by a holder
-- of manage); nothing else about it ever changes.
CREATE OR REPLACE FUNCTION app.policy_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Europe/London')::date;
  v_second boolean;
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.policy_id, NEW.version_number, NEW.author_id)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.policy_id, OLD.version_number, OLD.author_id) THEN
    RAISE EXCEPTION 'A policy version keeps its policy, number and author'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state = 'draft' AND NEW.state = 'draft' THEN
    PERFORM app.policy_document_check(NEW.document_id);
    RETURN NEW;
  END IF;
  IF OLD.state = 'draft' AND NEW.state = 'published' THEN
    -- Locked, so a retirement committing meanwhile is seen (security review round 1, finding 7).
    SELECT p.require_second_reviewer INTO v_second FROM public.policy p
      WHERE p.id = NEW.policy_id FOR UPDATE;
    IF app.current_user_id() IS NULL OR NEW.published_by IS DISTINCT FROM app.current_user_id()
       OR NOT app.holds_permission_anywhere('quality.policy.manage') THEN
      RAISE EXCEPTION 'A policy is published by a holder of quality.policy.manage, in their own name'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_second AND NEW.published_by = NEW.author_id THEN
      RAISE EXCEPTION 'Someone other than its author publishes this policy'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF cardinality(NEW.roles) = 0 OR NEW.review_due_on IS NULL OR NEW.review_due_on <= v_today THEN
      RAISE EXCEPTION 'A published policy names who must read it and a review date after today'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.policy p WHERE p.id = NEW.policy_id AND p.retired_at IS NOT NULL) THEN
      RAISE EXCEPTION 'A retired policy is not published again' USING ERRCODE = 'check_violation';
    END IF;
    NEW.published_on := v_today;
    NEW.published_at := now();
    PERFORM set_config('app.policy_superseding', NEW.policy_id::text, true);
    UPDATE public.policy_version SET state = 'superseded', superseded_at = now()
      WHERE policy_id = NEW.policy_id AND state = 'published' AND id <> NEW.id;
    PERFORM set_config('app.policy_superseding', '', true);
    RETURN NEW;
  END IF;
  -- Only the publication above supersedes: from inside this trigger (depth above one), never from
  -- a statement that set the flag itself (security review round 1, finding 6).
  IF OLD.state = 'published' AND NEW.state = 'superseded' AND pg_trigger_depth() > 1
     AND current_setting('app.policy_superseding', true) = NEW.policy_id::text THEN
    IF (NEW.change, NEW.change_summary, NEW.body, NEW.document_id, NEW.roles, NEW.review_due_on,
        NEW.published_by, NEW.published_on, NEW.published_at, NEW.retired_reason)
       IS DISTINCT FROM (OLD.change, OLD.change_summary, OLD.body, OLD.document_id, OLD.roles,
        OLD.review_due_on, OLD.published_by, OLD.published_on, OLD.published_at, OLD.retired_reason) THEN
      RAISE EXCEPTION 'A published policy version is fixed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'published' AND NEW.state = 'retired' THEN
    IF NOT app.manages_policies() OR NEW.retired_reason IS NULL
       OR length(btrim(NEW.retired_reason)) < 10 THEN
      RAISE EXCEPTION 'A policy version is retired by a holder of quality.policy.manage with a reason'
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.change, NEW.change_summary, NEW.body, NEW.document_id, NEW.roles, NEW.review_due_on,
        NEW.published_by, NEW.published_on, NEW.published_at, NEW.superseded_at)
       IS DISTINCT FROM (OLD.change, OLD.change_summary, OLD.body, OLD.document_id, OLD.roles,
        OLD.review_due_on, OLD.published_by, OLD.published_on, OLD.published_at, OLD.superseded_at) THEN
      RAISE EXCEPTION 'A published policy version is fixed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A policy version cannot change like that' USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER policy_version_guard BEFORE UPDATE ON public.policy_version
  FOR EACH ROW EXECUTE FUNCTION app.policy_version_guard();
--> statement-breakpoint

-- HZ-128: a signature is in the signer's own name, on the version in force.
CREATE OR REPLACE FUNCTION app.policy_version_in_force(p_version_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.policy_version v
                 WHERE v.id = p_version_id AND v.state = 'published')
$$;
--> statement-breakpoint
CREATE POLICY policy_signature_read ON public.policy_signature AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (signer_id = app.current_user_id() OR app.manages_policies());
--> statement-breakpoint
CREATE POLICY policy_signature_sign ON public.policy_signature AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (signer_id = app.current_user_id() AND app.policy_version_in_force(policy_version_id));
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['policy', 'policy_version'] LOOP
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.policy_signature
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.policy_signature
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.policy, public.policy_version TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.policy_signature TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.policy_signature FROM harbour_app;
--> statement-breakpoint

-- Earlier versions of a policy draft follow the draft rule: the versions table is otherwise
-- readable across the organisation (security review round 1, finding 8).
CREATE POLICY record_version_policy_draft ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (table_name <> 'policy_version' OR data->>'state' <> 'draft' OR app.manages_policies());

