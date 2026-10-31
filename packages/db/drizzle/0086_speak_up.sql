CREATE TABLE "speak_up_case_member" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"concern_id" uuid NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"added_by" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "speak_up_case_member_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "speak_up_case_member_removed" CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
--> statement-breakpoint
CREATE TABLE "speak_up_concern" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"identity" text NOT NULL,
	"category" text NOT NULL,
	"summary" text NOT NULL,
	"received_on" date NOT NULL,
	"state" text DEFAULT 'received' NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"outcome" text,
	"outcome_shared_at" timestamp with time zone,
	"closed_reason" text,
	"closed_at" timestamp with time zone,
	"reply_token_hash" text,
	"retention_class" text DEFAULT 'complaint' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "speak_up_concern_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "speak_up_concern_reply_token_key" UNIQUE("tenant_id","reply_token_hash"),
	CONSTRAINT "speak_up_concern_identity" CHECK (identity IN ('named', 'confidential', 'anonymous')),
	CONSTRAINT "speak_up_concern_category" CHECK (category IN ('care_quality_or_safety', 'staff_safety', 'conduct', 'bullying_or_harassment', 'fraud_or_finance', 'other')),
	CONSTRAINT "speak_up_concern_state" CHECK (state IN ('received', 'acknowledged', 'under_review', 'outcome_shared', 'closed')),
	CONSTRAINT "speak_up_concern_summary" CHECK (length(btrim(summary)) BETWEEN 3 AND 10000),
	CONSTRAINT "speak_up_concern_no_creator" CHECK (created_by IS NULL),
	CONSTRAINT "speak_up_concern_token" CHECK (reply_token_hash IS NULL OR (identity = 'anonymous' AND reply_token_hash ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "speak_up_concern_retention_class" CHECK (retention_class = 'complaint'),
	CONSTRAINT "speak_up_concern_closed" CHECK ((state = 'closed') = (closed_at IS NOT NULL AND closed_reason IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "speak_up_message" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"concern_id" uuid NOT NULL,
	"from_reporter" boolean NOT NULL,
	"author_tenant_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "speak_up_message_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "speak_up_message_author" CHECK (from_reporter = (author_tenant_user_id IS NULL)),
	CONSTRAINT "speak_up_message_body" CHECK (length(btrim(body)) BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "speak_up_reporter" (
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"concern_id" uuid NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "speak_up_reporter_concern_key" UNIQUE("tenant_id","concern_id")
);
--> statement-breakpoint
ALTER TABLE "speak_up_case_member" ADD CONSTRAINT "speak_up_case_member_concern_fk" FOREIGN KEY ("tenant_id","concern_id") REFERENCES "public"."speak_up_concern"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speak_up_case_member" ADD CONSTRAINT "speak_up_case_member_member_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speak_up_case_member" ADD CONSTRAINT "speak_up_case_member_added_by_fk" FOREIGN KEY ("tenant_id","added_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speak_up_message" ADD CONSTRAINT "speak_up_message_concern_fk" FOREIGN KEY ("tenant_id","concern_id") REFERENCES "public"."speak_up_concern"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speak_up_message" ADD CONSTRAINT "speak_up_message_author_fk" FOREIGN KEY ("tenant_id","author_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speak_up_reporter" ADD CONSTRAINT "speak_up_reporter_concern_fk" FOREIGN KEY ("tenant_id","concern_id") REFERENCES "public"."speak_up_concern"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speak_up_reporter" ADD CONSTRAINT "speak_up_reporter_member_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "speak_up_case_member_concern_idx" ON "speak_up_case_member" USING btree ("tenant_id","concern_id");--> statement-breakpoint
CREATE INDEX "speak_up_message_concern_idx" ON "speak_up_message" USING btree ("tenant_id","concern_id","created_at");--> statement-breakpoint

-- Speaking up: a restricted silo (Phase 2 slice 24; SAFE-012; ADR-0089). Forced RLS. Only the
-- Freedom to Speak Up lead (a role carrying the silo permission safety.speak_up.manage), the
-- members the lead names on a case, and the reporter of a named or confidential concern read it;
-- a public request carrying an anonymous concern's reply token (app.speak_up = 'true',
-- app.speak_up_token = its SHA-256) reads that one concern and its messages. No wider role reaches
-- it: built-in roles built from every permission leave the silo out, a role carrying it carries
-- nothing else, no grant carries it, nobody appoints themselves, and nobody holds it together with
-- user or role management (guards below). A concern never stores its creator.
CREATE OR REPLACE FUNCTION app.silo_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY['safety.speak_up.manage']::text[]
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.speak_up_lead() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_user_id() IS NOT NULL
    AND app.holds_role_permission_somewhere('safety.speak_up.manage')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.speak_up_public_token() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN app.current_user_id() IS NULL
                AND current_setting('app.speak_up', true) = 'true'
              THEN nullif(current_setting('app.speak_up_token', true), '') END
$$;
--> statement-breakpoint
-- A member named on the case (invoker rights: the member table's own policy applies).
CREATE OR REPLACE FUNCTION app.speak_up_member(p_concern uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_user_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.speak_up_case_member m
     WHERE m.concern_id = p_concern AND m.tenant_user_id = app.current_user_id()
       AND m.removed_at IS NULL)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.speak_up_reporter(p_concern uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_user_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.speak_up_reporter r
     WHERE r.concern_id = p_concern AND r.tenant_user_id = app.current_user_id())
$$;
--> statement-breakpoint
ALTER TABLE public.speak_up_concern ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.speak_up_concern FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.speak_up_reporter ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.speak_up_reporter FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.speak_up_case_member ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.speak_up_case_member FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.speak_up_message ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.speak_up_message FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['speak_up_concern', 'speak_up_reporter', 'speak_up_case_member',
                           'speak_up_message'] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- Concerns. Read by the lead, a case member, the reporter, the public request with its token, and
-- (only within the transaction that raised it) the member raising a named or confidential one, so
-- they can claim it as its reporter.
CREATE POLICY speak_up_concern_read ON public.speak_up_concern AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.speak_up_lead() OR app.speak_up_member(id) OR app.speak_up_reporter(id)
    OR (reply_token_hash IS NOT NULL AND reply_token_hash = app.speak_up_public_token())
    OR (identity <> 'anonymous' AND app.current_user_id() IS NOT NULL AND age(xmin) = 0));
--> statement-breakpoint
CREATE POLICY speak_up_concern_raise ON public.speak_up_concern AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (created_by IS NULL AND updated_by IS NULL AND state = 'received'
    AND acknowledged_at IS NULL AND outcome IS NULL AND closed_at IS NULL
    AND ((identity = 'anonymous' AND app.current_user_id() IS NULL
          AND current_setting('app.speak_up', true) = 'true')
      OR (identity IN ('named', 'confidential') AND app.current_user_id() IS NOT NULL
          AND reply_token_hash IS NULL)));
--> statement-breakpoint
CREATE POLICY speak_up_concern_manage ON public.speak_up_concern AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.speak_up_lead()) WITH CHECK (app.speak_up_lead());
--> statement-breakpoint
-- Who raised a named or confidential concern: the lead and the reporter always; case members only
-- for a named one. Claimed only by the member raising it, in the same transaction.
CREATE POLICY speak_up_reporter_read ON public.speak_up_reporter AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.speak_up_lead() OR tenant_user_id = app.current_user_id()
    OR (app.speak_up_member(concern_id) AND EXISTS (
      SELECT 1 FROM public.speak_up_concern c WHERE c.id = concern_id AND c.identity = 'named')));
--> statement-breakpoint
CREATE POLICY speak_up_reporter_claim ON public.speak_up_reporter AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (tenant_user_id = app.current_user_id() AND EXISTS (
    SELECT 1 FROM public.speak_up_concern c
     WHERE c.id = concern_id AND c.identity IN ('named', 'confidential') AND age(c.xmin) = 0));
--> statement-breakpoint
-- Case members: the lead names and removes them; a member sees their own membership.
CREATE POLICY speak_up_case_member_read ON public.speak_up_case_member AS RESTRICTIVE FOR SELECT
  TO harbour_app USING (app.speak_up_lead() OR tenant_user_id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY speak_up_case_member_add ON public.speak_up_case_member AS RESTRICTIVE FOR INSERT
  TO harbour_app WITH CHECK (app.speak_up_lead() AND added_by = app.current_user_id()
    AND removed_at IS NULL);
--> statement-breakpoint
CREATE POLICY speak_up_case_member_change ON public.speak_up_case_member AS RESTRICTIVE FOR UPDATE
  TO harbour_app USING (app.speak_up_lead()) WITH CHECK (app.speak_up_lead());
--> statement-breakpoint
-- Messages follow their concern; a reporter's carries no author, a lead's or member's their own.
CREATE POLICY speak_up_message_read ON public.speak_up_message AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (EXISTS (SELECT 1 FROM public.speak_up_concern c WHERE c.id = concern_id));
--> statement-breakpoint
CREATE POLICY speak_up_message_write ON public.speak_up_message AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (EXISTS (SELECT 1 FROM public.speak_up_concern c
                       WHERE c.id = concern_id AND c.state <> 'closed')
    AND ((from_reporter AND author_tenant_user_id IS NULL
          AND (app.speak_up_reporter(concern_id) OR app.speak_up_public_token() IS NOT NULL))
      OR (NOT from_reporter AND author_tenant_user_id = app.current_user_id()
          AND (app.speak_up_lead() OR app.speak_up_member(concern_id)))));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.speak_up_concern_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.identity, NEW.received_on, NEW.created_at, NEW.created_by,
      NEW.reply_token_hash)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.identity, OLD.received_on, OLD.created_at, OLD.created_by,
      OLD.reply_token_hash) THEN
    RAISE EXCEPTION 'A speak-up concern keeps its identity, receipt and reply token'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND app.current_user_id() IS NOT NULL THEN
    RAISE EXCEPTION 'A speak-up concern is removed only by the retention schedule'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER speak_up_concern_guard BEFORE UPDATE ON public.speak_up_concern
  FOR EACH ROW EXECUTE FUNCTION app.speak_up_concern_guard();
--> statement-breakpoint
-- No capture_version on the silo tables: it copies the whole row into record_version, which every
-- member of the organisation reads (ADR-0089). Each change is audited by id instead.
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.speak_up_concern
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.speak_up_case_member
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['speak_up_reporter', 'speak_up_message'] LOOP
    EXECUTE format(
      'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format(
      'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.speak_up_concern TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.speak_up_case_member TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.speak_up_reporter TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.speak_up_message TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.speak_up_concern, public.speak_up_case_member,
  public.speak_up_reporter, public.speak_up_message FROM harbour_app;
--> statement-breakpoint
REVOKE UPDATE ON public.speak_up_reporter, public.speak_up_message FROM harbour_app;
--> statement-breakpoint

-- The silo guards (ADR-0089). A role carrying a silo permission carries nothing else; no access
-- grant carries one; nobody appoints themselves to a silo role; and nobody holds a silo role
-- together with a role that manages users or roles, whichever comes first.
CREATE OR REPLACE FUNCTION app.silo_role_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.permissions && app.silo_permissions() AND NOT (NEW.permissions <@ app.silo_permissions()) THEN
    RAISE EXCEPTION 'A role carrying a silo permission carries nothing else (ADR-0089)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER silo_role_guard BEFORE INSERT OR UPDATE OF permissions ON public.role
  FOR EACH ROW EXECUTE FUNCTION app.silo_role_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.silo_grant_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.permissions && app.silo_permissions() THEN
    RAISE EXCEPTION 'A silo permission is never given by an access grant (ADR-0089)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER silo_grant_guard BEFORE INSERT OR UPDATE OF permissions ON public.access_grant
  FOR EACH ROW EXECUTE FUNCTION app.silo_grant_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.silo_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_permissions text[];
  v_admin text[] := ARRAY['platform.user.manage', 'platform.role.manage']::text[];
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT r.permissions INTO v_permissions FROM public.role r
   WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.role_id;
  IF v_permissions && app.silo_permissions() THEN
    IF NEW.tenant_user_id = app.current_user_id() THEN
      RAISE EXCEPTION 'Nobody appoints themselves to a silo role (ADR-0089)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.role_assignment ra
                 JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
                WHERE ra.tenant_id = NEW.tenant_id AND ra.tenant_user_id = NEW.tenant_user_id
                  AND ra.id IS DISTINCT FROM NEW.id AND ra.deleted_at IS NULL
                  AND (ra.valid_to IS NULL OR ra.valid_to > now())
                  AND r.permissions && v_admin) THEN
      RAISE EXCEPTION 'A silo role is never held with user or role management (ADR-0089)'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF v_permissions && v_admin THEN
    IF EXISTS (SELECT 1 FROM public.role_assignment ra
                 JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
                WHERE ra.tenant_id = NEW.tenant_id AND ra.tenant_user_id = NEW.tenant_user_id
                  AND ra.id IS DISTINCT FROM NEW.id AND ra.deleted_at IS NULL
                  AND (ra.valid_to IS NULL OR ra.valid_to > now())
                  AND r.permissions && app.silo_permissions()) THEN
      RAISE EXCEPTION 'A silo role is never held with user or role management (ADR-0089)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER silo_assignment_guard BEFORE INSERT OR UPDATE ON public.role_assignment
  FOR EACH ROW EXECUTE FUNCTION app.silo_assignment_guard();
