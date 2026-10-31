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
CREATE TABLE "speak_up_intake" (
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"hits" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "speak_up_intake_pkey" PRIMARY KEY("tenant_id","bucket","window_start"),
	CONSTRAINT "speak_up_intake_bucket" CHECK (bucket ~ '^(net:[0-9a-f]{64}|tenant|day)$'),
	CONSTRAINT "speak_up_intake_window" CHECK (window_end > window_start)
);
--> statement-breakpoint
ALTER TABLE "speak_up_concern" ADD COLUMN "reply_token_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "speak_up_intake_end_idx" ON "speak_up_intake" USING btree ("tenant_id","window_end");
--> statement-breakpoint
ALTER TABLE "speak_up_concern" ADD CONSTRAINT "speak_up_concern_token_expiry" CHECK ((reply_token_hash IS NULL) = (reply_token_expires_at IS NULL));
--> statement-breakpoint
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
ALTER TABLE public.speak_up_intake ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.speak_up_intake FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['speak_up_concern', 'speak_up_reporter', 'speak_up_case_member',
                           'speak_up_message', 'speak_up_intake'] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- The silo's policies bind the application and the owner roles alike (security review L7): the
-- owner role reads a concern only as the lead, a case member or its reporter would.
-- Concerns. Read by the lead, a case member, the reporter, and the public request carrying the
-- hash of a reply token that has not expired.
CREATE POLICY speak_up_concern_read ON public.speak_up_concern AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.speak_up_lead() OR app.speak_up_member(id) OR app.speak_up_reporter(id)
    OR (reply_token_hash IS NOT NULL AND reply_token_hash = app.speak_up_public_token()
        AND reply_token_expires_at > now()));
--> statement-breakpoint
-- The application raises only anonymous concerns, on a public request. A named or confidential
-- concern is raised only by app.raise_speak_up, which claims it for its reporter in one step.
CREATE POLICY speak_up_concern_raise ON public.speak_up_concern AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (created_by IS NULL AND updated_by IS NULL AND state = 'received'
    AND acknowledged_at IS NULL AND outcome IS NULL AND closed_at IS NULL
    AND identity = 'anonymous' AND app.current_user_id() IS NULL
    AND current_setting('app.speak_up', true) = 'true');
--> statement-breakpoint
CREATE POLICY speak_up_concern_raise_named ON public.speak_up_concern AS RESTRICTIVE FOR INSERT
  TO harbour_silo_owner
  WITH CHECK (created_by IS NULL AND updated_by IS NULL AND state = 'received'
    AND acknowledged_at IS NULL AND outcome IS NULL AND closed_at IS NULL
    AND identity IN ('named', 'confidential') AND app.current_user_id() IS NOT NULL
    AND reply_token_hash IS NULL);
--> statement-breakpoint
CREATE POLICY speak_up_concern_manage ON public.speak_up_concern AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (app.speak_up_lead()) WITH CHECK (app.speak_up_lead());
--> statement-breakpoint
-- Who raised a named or confidential concern: the lead and the reporter always; case members only
-- for a named one. Written only by app.raise_speak_up, for the concern it has just raised.
CREATE POLICY speak_up_reporter_read ON public.speak_up_reporter AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.speak_up_lead() OR tenant_user_id = app.current_user_id()
    OR (app.speak_up_member(concern_id) AND EXISTS (
      SELECT 1 FROM public.speak_up_concern c WHERE c.id = concern_id AND c.identity = 'named')));
--> statement-breakpoint
CREATE POLICY speak_up_reporter_no_claim ON public.speak_up_reporter AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY speak_up_reporter_claim ON public.speak_up_reporter AS RESTRICTIVE FOR INSERT
  TO harbour_silo_owner
  WITH CHECK (tenant_user_id = app.current_user_id()
    AND concern_id::text = current_setting('app.speak_up_claim', true));
--> statement-breakpoint
-- Case members: the lead names and removes them; a member sees their own membership.
CREATE POLICY speak_up_case_member_read ON public.speak_up_case_member AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner USING (app.speak_up_lead() OR tenant_user_id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY speak_up_case_member_add ON public.speak_up_case_member AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner WITH CHECK (app.speak_up_lead() AND added_by = app.current_user_id()
    AND removed_at IS NULL);
--> statement-breakpoint
CREATE POLICY speak_up_case_member_change ON public.speak_up_case_member AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner USING (app.speak_up_lead()) WITH CHECK (app.speak_up_lead());
--> statement-breakpoint
-- Messages follow their concern; a reporter's carries no author, a lead's or member's their own.
CREATE POLICY speak_up_message_read ON public.speak_up_message AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (EXISTS (SELECT 1 FROM public.speak_up_concern c WHERE c.id = concern_id));
--> statement-breakpoint
CREATE POLICY speak_up_message_write ON public.speak_up_message AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
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
      NEW.reply_token_hash, NEW.reply_token_expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.identity, OLD.received_on, OLD.created_at, OLD.created_by,
      OLD.reply_token_hash, OLD.reply_token_expires_at) THEN
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
GRANT SELECT ON public.speak_up_reporter TO harbour_app;
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
-- The guards run as harbour_silo_owner (security definer), so the caller's own row-level scope never
-- hides an assignment from the check.
CREATE OR REPLACE FUNCTION app.silo_role_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_admin text[] := ARRAY['platform.user.manage', 'platform.role.manage']::text[];
BEGIN
  IF NEW.permissions && app.silo_permissions() AND NOT (NEW.permissions <@ app.silo_permissions()) THEN
    RAISE EXCEPTION 'A role carrying a silo permission carries nothing else (ADR-0089)'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Editing a role someone already holds (security review M4): the same rules as appointing them.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.permissions && app.silo_permissions() THEN
      IF EXISTS (SELECT 1 FROM public.role_assignment ra
                  WHERE ra.tenant_id = NEW.tenant_id AND ra.role_id = NEW.id
                    AND ra.deleted_at IS NULL AND (ra.valid_to IS NULL OR ra.valid_to > now())
                    AND ra.tenant_user_id = app.current_user_id()) THEN
        RAISE EXCEPTION 'Nobody appoints themselves to a silo role (ADR-0089)'
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM public.role_assignment ra
                   JOIN public.role_assignment other
                     ON other.tenant_id = ra.tenant_id AND other.tenant_user_id = ra.tenant_user_id
                    AND other.id <> ra.id AND other.deleted_at IS NULL
                    AND (other.valid_to IS NULL OR other.valid_to > now())
                   JOIN public.role r ON r.tenant_id = other.tenant_id AND r.id = other.role_id
                  WHERE ra.tenant_id = NEW.tenant_id AND ra.role_id = NEW.id
                    AND ra.deleted_at IS NULL AND (ra.valid_to IS NULL OR ra.valid_to > now())
                    AND r.id <> NEW.id AND r.permissions && v_admin) THEN
        RAISE EXCEPTION 'A silo role is never held with user or role management (ADR-0089)'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW.permissions && v_admin THEN
      IF EXISTS (SELECT 1 FROM public.role_assignment ra
                   JOIN public.role_assignment other
                     ON other.tenant_id = ra.tenant_id AND other.tenant_user_id = ra.tenant_user_id
                    AND other.id <> ra.id AND other.deleted_at IS NULL
                    AND (other.valid_to IS NULL OR other.valid_to > now())
                   JOIN public.role r ON r.tenant_id = other.tenant_id AND r.id = other.role_id
                  WHERE ra.tenant_id = NEW.tenant_id AND ra.role_id = NEW.id
                    AND ra.deleted_at IS NULL AND (ra.valid_to IS NULL OR ra.valid_to > now())
                    AND r.id <> NEW.id AND r.permissions && app.silo_permissions()) THEN
        RAISE EXCEPTION 'A silo role is never held with user or role management (ADR-0089)'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
--> statement-breakpoint

-- Public intake counts (security review H1). Only a public request (no member, app.speak_up set)
-- counts and reads them; the lead reads the daily count only, to see a possible flood.
CREATE POLICY speak_up_intake_read ON public.speak_up_intake AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING ((app.current_user_id() IS NULL AND current_setting('app.speak_up', true) = 'true')
    OR (bucket = 'day' AND app.speak_up_lead()));
--> statement-breakpoint
CREATE POLICY speak_up_intake_count ON public.speak_up_intake AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.current_user_id() IS NULL AND current_setting('app.speak_up', true) = 'true');
--> statement-breakpoint
CREATE POLICY speak_up_intake_update ON public.speak_up_intake AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (app.current_user_id() IS NULL AND current_setting('app.speak_up', true) = 'true')
  WITH CHECK (app.current_user_id() IS NULL AND current_setting('app.speak_up', true) = 'true');
--> statement-breakpoint
-- Windows that have passed are swept hourly by the worker, across organisations.
CREATE POLICY speak_up_intake_sweep ON public.speak_up_intake AS PERMISSIVE FOR ALL
  TO harbour_worker USING (window_end < now()) WITH CHECK (false);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.speak_up_intake TO harbour_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON public.speak_up_intake TO harbour_worker;
--> statement-breakpoint

-- A named or confidential concern and its reporter, in one step (security review L7: no
-- transaction-age test). Runs as harbour_silo_owner, the only role that may write a reporter, and
-- only for the concern it has just raised, for the member making the request.
CREATE OR REPLACE FUNCTION app.raise_speak_up(p_id uuid, p_identity text, p_category text,
  p_summary text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.current_user_id() IS NULL OR p_identity NOT IN ('named', 'confidential') THEN
    RAISE EXCEPTION 'Only a member raises a named or confidential concern'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.speak_up_concern (id, identity, category, summary, received_on, created_by,
    updated_by)
  VALUES (p_id, p_identity, p_category, p_summary,
    (now() AT TIME ZONE 'Europe/London')::date, NULL, NULL);
  PERFORM set_config('app.speak_up_claim', p_id::text, true);
  INSERT INTO public.speak_up_reporter (concern_id, tenant_user_id)
  VALUES (p_id, app.current_user_id());
  PERFORM set_config('app.speak_up_claim', '', true);
END
$$;
--> statement-breakpoint

-- Appointing or removing the Freedom to Speak Up lead (security review L5): by a member who manages
-- users, without holding the silo permission. The assignment guard still refuses self-appointment
-- and the lead holding user or role management. The application audits each call.
CREATE OR REPLACE FUNCTION app.set_speak_up_lead(p_member uuid, p_appoint boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_role uuid;
  v_changed integer;
BEGIN
  IF app.current_user_id() IS NULL
     OR NOT app.holds_role_permission_somewhere('platform.user.manage') THEN
    RAISE EXCEPTION 'Only a member who manages users appoints the Freedom to Speak Up lead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT r.id INTO v_role FROM public.role r
   WHERE r.tenant_id = app.current_tenant_id() AND r.key = 'speak_up_guardian'
     AND r.permissions <@ app.silo_permissions() AND r.permissions && app.silo_permissions();
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'The organisation has no Freedom to Speak Up lead role'
      USING ERRCODE = 'no_data_found';
  END IF;
  IF p_appoint THEN
    IF NOT EXISTS (SELECT 1 FROM public.tenant_user u
                    WHERE u.tenant_id = app.current_tenant_id() AND u.id = p_member
                      AND u.status = 'active') THEN
      RAISE EXCEPTION 'Only an active member is appointed' USING ERRCODE = 'no_data_found';
    END IF;
    IF EXISTS (SELECT 1 FROM public.role_assignment ra
                WHERE ra.tenant_id = app.current_tenant_id() AND ra.tenant_user_id = p_member
                  AND ra.role_id = v_role AND ra.deleted_at IS NULL
                  AND (ra.valid_to IS NULL OR ra.valid_to > now())) THEN
      RETURN false;
    END IF;
    INSERT INTO public.role_assignment (tenant_user_id, role_id, reason)
    VALUES (p_member, v_role, 'Appointed Freedom to Speak Up lead');
    RETURN true;
  END IF;
  UPDATE public.role_assignment ra SET deleted_at = now()
   WHERE ra.tenant_id = app.current_tenant_id() AND ra.tenant_user_id = p_member
     AND ra.role_id = v_role AND ra.deleted_at IS NULL;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed > 0;
END
$$;
--> statement-breakpoint

-- Speak-up audit events are read only by the lead (security review M3): their times would line
-- up with what an anonymous reporter did. They stay in the organisation's hash chain; the chain is
-- verified as harbour_silo_owner, which sees every event and returns only a position.
CREATE POLICY audit_speak_up_silo ON public.audit_event AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner, harbour_worker
  USING (resource_type IS DISTINCT FROM 'speak_up_concern' OR (SELECT app.speak_up_lead()));
--> statement-breakpoint
ALTER FUNCTION app.verify_audit_chain() SECURITY DEFINER;
--> statement-breakpoint

GRANT CREATE, USAGE ON SCHEMA app TO harbour_silo_owner;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO harbour_silo_owner;
--> statement-breakpoint
GRANT INSERT ON public.speak_up_concern, public.speak_up_reporter TO harbour_silo_owner;
--> statement-breakpoint
GRANT SELECT ON public.role, public.role_assignment, public.access_grant, public.audit_event,
  public.location TO harbour_silo_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, status) ON public.tenant_user TO harbour_silo_owner;
--> statement-breakpoint
GRANT INSERT, UPDATE ON public.role_assignment TO harbour_silo_owner;
--> statement-breakpoint
GRANT INSERT ON public.record_version TO harbour_silo_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_role_permission_somewhere(text), app.holds_role_permission_at(text, uuid)
  TO harbour_silo_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.raise_speak_up(uuid, text, text, text),
  app.set_speak_up_lead(uuid, boolean), app.verify_audit_chain() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.verify_audit_chain() TO harbour_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.raise_speak_up(uuid, text, text, text),
  app.set_speak_up_lead(uuid, boolean) TO harbour_app;
--> statement-breakpoint
ALTER FUNCTION app.raise_speak_up(uuid, text, text, text) OWNER TO harbour_silo_owner;
--> statement-breakpoint
ALTER FUNCTION app.set_speak_up_lead(uuid, boolean) OWNER TO harbour_silo_owner;
--> statement-breakpoint
ALTER FUNCTION app.silo_role_guard() OWNER TO harbour_silo_owner;
--> statement-breakpoint
ALTER FUNCTION app.silo_assignment_guard() OWNER TO harbour_silo_owner;
--> statement-breakpoint
ALTER FUNCTION app.verify_audit_chain() OWNER TO harbour_silo_owner;
--> statement-breakpoint
-- The owner role keeps running the chain check (tests and operators) now that it no longer owns it.
SET ROLE harbour_silo_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.verify_audit_chain() TO harbour_owner;
--> statement-breakpoint
RESET ROLE;
