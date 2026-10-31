CREATE TABLE "dependency_assessment" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"scale_id" uuid NOT NULL,
	"scale_version_id" uuid NOT NULL,
	"category_key" text NOT NULL,
	"one_to_one" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kind" text NOT NULL,
	"effective_from" date NOT NULL,
	"reason" text NOT NULL,
	"decided_by" uuid NOT NULL,
	"supersedes_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "dependency_assessment_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "dependency_assessment_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "dependency_assessment_kind" CHECK (kind IN ('initial', 'review', 'correction')),
	CONSTRAINT "dependency_assessment_chain" CHECK ((kind = 'initial') = (supersedes_id IS NULL)),
	CONSTRAINT "dependency_assessment_reason" CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
	CONSTRAINT "dependency_assessment_category_key" CHECK (category_key ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "dependency_assessment_one_to_one" CHECK (jsonb_typeof(one_to_one) = 'array')
);
--> statement-breakpoint
CREATE TABLE "dependency_scale" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid,
	"name" text NOT NULL,
	"archive_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "dependency_scale_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "dependency_scale_name" CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
	CONSTRAINT "dependency_scale_archived" CHECK ((deleted_at IS NULL) = (archive_reason IS NULL) AND (archive_reason IS NULL OR btrim(archive_reason) <> ''))
);
--> statement-breakpoint
CREATE TABLE "dependency_scale_version" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"scale_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"definition" jsonb NOT NULL,
	"author_id" uuid DEFAULT app.current_user_id() NOT NULL,
	"contributor_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"discard_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "dependency_scale_version_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "dependency_scale_version_scale_id_key" UNIQUE("tenant_id","scale_id","id"),
	CONSTRAINT "dependency_scale_version_number_key" UNIQUE("tenant_id","scale_id","version_number"),
	CONSTRAINT "dependency_scale_version_state" CHECK (state IN ('draft', 'approved', 'superseded', 'discarded')),
	CONSTRAINT "dependency_scale_version_number" CHECK (version_number >= 1),
	CONSTRAINT "dependency_scale_version_definition" CHECK (jsonb_typeof(definition) = 'object'),
	CONSTRAINT "dependency_scale_version_approved" CHECK ((state IN ('approved', 'superseded')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
	CONSTRAINT "dependency_scale_version_superseded" CHECK ((state = 'superseded') = (superseded_at IS NOT NULL)),
	CONSTRAINT "dependency_scale_version_discarded" CHECK ((state = 'discarded') = (discard_reason IS NOT NULL AND btrim(discard_reason) <> ''))
);
--> statement-breakpoint
ALTER TABLE "dependency_assessment" ADD CONSTRAINT "dependency_assessment_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_assessment" ADD CONSTRAINT "dependency_assessment_version_fk" FOREIGN KEY ("tenant_id","scale_id","scale_version_id") REFERENCES "public"."dependency_scale_version"("tenant_id","scale_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_assessment" ADD CONSTRAINT "dependency_assessment_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_assessment" ADD CONSTRAINT "dependency_assessment_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_assessment" ADD CONSTRAINT "dependency_assessment_supersedes_fk" FOREIGN KEY ("tenant_id","person_id","supersedes_id") REFERENCES "public"."dependency_assessment"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_scale" ADD CONSTRAINT "dependency_scale_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_scale_version" ADD CONSTRAINT "dependency_scale_version_scale_fk" FOREIGN KEY ("tenant_id","scale_id") REFERENCES "public"."dependency_scale"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_scale_version" ADD CONSTRAINT "dependency_scale_version_author_fk" FOREIGN KEY ("tenant_id","author_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_scale_version" ADD CONSTRAINT "dependency_scale_version_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_assessment_one_chain_key" ON "dependency_assessment" USING btree ("tenant_id","person_id") WHERE supersedes_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_assessment_superseded_once_key" ON "dependency_assessment" USING btree ("tenant_id","supersedes_id");--> statement-breakpoint
CREATE INDEX "dependency_assessment_person_idx" ON "dependency_assessment" USING btree ("tenant_id","person_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_scale_location_key" ON "dependency_scale" USING btree ("tenant_id","location_id") WHERE deleted_at IS NULL AND location_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_scale_organisation_key" ON "dependency_scale" USING btree ("tenant_id") WHERE deleted_at IS NULL AND location_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_scale_version_one_draft_key" ON "dependency_scale_version" USING btree ("tenant_id","scale_id") WHERE state = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_scale_version_one_approved_key" ON "dependency_scale_version" USING btree ("tenant_id","scale_id") WHERE state = 'approved';
--> statement-breakpoint

-- The dependency tool (scheduling.md section 12; CARE-004, SCHED-001; hazard HZ-123): the
-- organisation's own scale, its versions and each person's category. Runs as harbour_owner.
-- Every table has forced RLS and the tenant policy (ADR-0002). A scale is changed only by a
-- holder of scheduling.dependency.manage where it applies; a version is fixed once approved and is
-- approved by someone who neither wrote nor changed it; a person's category is append-only, in
-- the person's scope, recorded by a holder of care.dependency.assess at their location, only from
-- the approved version of a scale, with a category and periods that version has.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dependency_scale', 'dependency_scale_version', 'dependency_assessment'] LOOP
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

-- Whether the session's member may change a scale: scheduling.dependency.manage at its location,
-- or across the organisation for the organisation-wide scale (app.holds_permission_at with NULL).
CREATE OR REPLACE FUNCTION app.may_manage_dependency_scale(p_scale_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.dependency_scale s
    WHERE s.tenant_id = app.current_tenant_id() AND s.id = p_scale_id
      AND app.holds_permission_at('scheduling.dependency.manage', s.location_id))
$$;
--> statement-breakpoint
CREATE POLICY dependency_scale_write ON public.dependency_scale AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (deleted_at IS NULL
    AND app.holds_permission_at('scheduling.dependency.manage', location_id));
--> statement-breakpoint
CREATE POLICY dependency_scale_change ON public.dependency_scale AS RESTRICTIVE FOR UPDATE
  TO harbour_app
  USING (app.holds_permission_at('scheduling.dependency.manage', location_id))
  WITH CHECK (app.holds_permission_at('scheduling.dependency.manage', location_id));
--> statement-breakpoint
CREATE POLICY dependency_scale_version_write ON public.dependency_scale_version AS RESTRICTIVE
  FOR INSERT TO harbour_app
  WITH CHECK (state = 'draft' AND author_id = app.current_user_id()
    AND app.may_manage_dependency_scale(scale_id));
--> statement-breakpoint
CREATE POLICY dependency_scale_version_change ON public.dependency_scale_version AS RESTRICTIVE
  FOR UPDATE TO harbour_app
  USING (app.may_manage_dependency_scale(scale_id))
  WITH CHECK (app.may_manage_dependency_scale(scale_id));
--> statement-breakpoint

-- A scale keeps its location; archiving is final.
CREATE OR REPLACE FUNCTION app.dependency_scale_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.location_id IS DISTINCT FROM OLD.location_id OR OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'A dependency scale keeps its location, and an archived scale never changes'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER dependency_scale_guard BEFORE UPDATE ON public.dependency_scale
  FOR EACH ROW EXECUTE FUNCTION app.dependency_scale_guard();
--> statement-breakpoint

-- The version workflow (DEPENDENCY_SCALE_WORKFLOW): a draft is made by its author and changed by
-- contributors, who are recorded; it is approved unchanged, in their own name, by a member who
-- neither wrote nor changed it, or discarded with a reason; an approved version is only ever
-- superseded, unchanged; nothing else changes and nothing is deleted.
CREATE OR REPLACE FUNCTION app.dependency_scale_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_me uuid := app.current_user_id();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' AND current_user = 'harbour_app' THEN
      RAISE EXCEPTION 'A dependency scale version starts as a draft'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT (NEW.author_id = ANY (NEW.contributor_ids)) THEN
      NEW.contributor_ids := array_append(NEW.contributor_ids, NEW.author_id);
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.scale_id, NEW.version_number, NEW.author_id, NEW.created_at,
      NEW.created_by) IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.scale_id, OLD.version_number,
      OLD.author_id, OLD.created_at, OLD.created_by)
     OR NEW.deleted_at IS NOT NULL OR NOT (OLD.contributor_ids <@ NEW.contributor_ids) THEN
    RAISE EXCEPTION 'A dependency scale version keeps its identity and contributors, and is never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state <> 'draft' THEN
    IF OLD.state = 'approved' AND NEW.state = 'superseded' AND NEW.superseded_at IS NOT NULL
       AND (NEW.definition, NEW.contributor_ids, NEW.approved_by, NEW.approved_at, NEW.discard_reason)
           IS NOT DISTINCT FROM
           (OLD.definition, OLD.contributor_ids, OLD.approved_by, OLD.approved_at, OLD.discard_reason) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'An approved, superseded or discarded scale version never changes, except to be superseded'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'approved' THEN
    IF NEW.definition IS DISTINCT FROM OLD.definition
       OR NEW.contributor_ids IS DISTINCT FROM OLD.contributor_ids
       OR v_me IS NULL OR NEW.approved_by IS DISTINCT FROM v_me
       OR v_me = OLD.author_id OR v_me = ANY (OLD.contributor_ids) THEN
      RAISE EXCEPTION 'A draft is approved unchanged, in their own name, by a member who neither wrote nor changed it'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state = 'discarded' THEN
    IF NEW.definition IS DISTINCT FROM OLD.definition THEN
      RAISE EXCEPTION 'A draft is discarded unchanged'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state = 'draft' THEN
    IF v_me IS NOT NULL AND NOT (v_me = ANY (NEW.contributor_ids)) THEN
      NEW.contributor_ids := array_append(NEW.contributor_ids, v_me);
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A draft is changed, approved or discarded'
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER dependency_scale_version_guard BEFORE INSERT OR UPDATE
  ON public.dependency_scale_version
  FOR EACH ROW EXECUTE FUNCTION app.dependency_scale_version_guard();
--> statement-breakpoint

-- Mutable aggregates: version bump on every change and a record_version row (history view).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dependency_scale', 'dependency_scale_version'] LOOP
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- A person's category follows the person's scope, and is recorded in the recorder's own name by
-- a holder of care.dependency.assess at the person's location.
CREATE POLICY person_child_scope ON public.dependency_assessment AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.person_visible(person_id)) WITH CHECK (app.person_visible(person_id));
--> statement-breakpoint
CREATE POLICY dependency_assessment_record ON public.dependency_assessment AS RESTRICTIVE
  FOR INSERT TO harbour_app
  WITH CHECK (created_by = app.current_user_id()
    AND app.holds_permission_at('care.dependency.assess',
      (SELECT p.location_id FROM public.person p
        WHERE p.tenant_id = app.current_tenant_id() AND p.id = person_id)));
--> statement-breakpoint

-- Only from the approved version of the scale, with a category and one-to-one periods that version
-- has; a review applies from the superseded record's date or later, a correction from its date
-- (scheduling.md section 12 rule 6). The chain itself is kept by the unique indexes: one record
-- without supersedes_id per person, each record superseded at most once.
CREATE OR REPLACE FUNCTION app.dependency_assessment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_state text;
  v_definition jsonb;
  v_previous date;
BEGIN
  SELECT v.state, v.definition INTO v_state, v_definition
    FROM public.dependency_scale_version v
   WHERE v.tenant_id = NEW.tenant_id AND v.scale_id = NEW.scale_id AND v.id = NEW.scale_version_id;
  IF v_state IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'A dependency category is recorded only from the approved version of a scale'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_definition -> 'categories') c
                  WHERE c ->> 'key' = NEW.category_key) THEN
    RAISE EXCEPTION 'The category is not in the scale version'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.one_to_one) o
     WHERE jsonb_typeof(o) <> 'object'
        OR CASE WHEN jsonb_typeof(o -> 'minutes') = 'number'
                THEN (o ->> 'minutes')::numeric <= 0
                  OR (o ->> 'minutes')::numeric <> trunc((o ->> 'minutes')::numeric)
                ELSE true END
        OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_definition -> 'periods') p
                        WHERE p ->> 'key' = o ->> 'periodKey'))
     OR (SELECT count(*) FROM jsonb_array_elements(NEW.one_to_one))
        <> (SELECT count(DISTINCT o ->> 'periodKey') FROM jsonb_array_elements(NEW.one_to_one) o) THEN
    RAISE EXCEPTION 'One-to-one minutes are whole minutes, once each, for periods in the scale version'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT a.effective_from INTO v_previous FROM public.dependency_assessment a
     WHERE a.tenant_id = NEW.tenant_id AND a.person_id = NEW.person_id AND a.id = NEW.supersedes_id;
    IF (NEW.kind = 'review' AND NEW.effective_from < v_previous)
       OR (NEW.kind = 'correction' AND NEW.effective_from IS DISTINCT FROM v_previous) THEN
      RAISE EXCEPTION 'A review applies from the superseded record''s date or later; a correction from that date'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER dependency_assessment_guard BEFORE INSERT ON public.dependency_assessment
  FOR EACH ROW EXECUTE FUNCTION app.dependency_assessment_guard();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.dependency_assessment
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.dependency_assessment
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.dependency_scale, public.dependency_scale_version
  TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.dependency_assessment TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.dependency_scale, public.dependency_scale_version FROM harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.dependency_assessment FROM harbour_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.may_manage_dependency_scale(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.may_manage_dependency_scale(uuid) TO harbour_app, harbour_owner;
--> statement-breakpoint

-- A sample person's categories go with them when the sample data is removed (migration 0069,
-- platform-completions.md rule 32): the list gains dependency_assessment, children before parents.
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
    'dependency_assessment',
    'about_me', 'about_me_share_link', 'activity_record', 'admission_condition',
    'advance_care_record', 'allergy', 'assessment', 'bed_occupancy', 'body_map_mark',
    'break_glass_event', 'candour_record', 'care_note', 'care_plan_action', 'care_plan_change',
    'consent_record', 'document_signature', 'dols_legal_change_review',
    'entry_device_deletion_flag', 'exit_checklist_item', 'family_portal_user',
    'feed_item_withdrawal', 'feed_view', 'handover_note', 'incident_person', 'key_issue',
    'legal_hold', 'letter', 'notification_delivery', 'observation', 'person_assignment',
    'person_care_profile', 'property_item', 'refused_entry', 'sharing_decision_suspension',
    'statutory_notification', 'visit_log', 'welcome_checklist_item', 'workflow_transition',
    'care_plan_section', 'dols_authorisation', 'exit_record', 'feed_item', 'handover_item',
    'hospital_transfer', 'notification', 'placement', 'review_record', 'risk_assessment',
    'sharing_decision', 'task', 'admission_decision', 'best_interests_decision', 'care_plan',
    'document', 'task_series', 'workflow_instance', 'capacity_assessment', 'contact',
    'pre_admission_assessment'
  ]::text[]
$$;
--> statement-breakpoint
GRANT SELECT, DELETE ON public.dependency_assessment TO harbour_sample_owner;
--> statement-breakpoint

-- Data migration: existing tenants' copies of the built-in roles gain the permissions the
-- built-in definitions (packages/domain/src/platform/roles.ts) added with the dependency tool:
-- scheduling.dependency.manage and care.dependency.assess for the owner, the Registered Manager
-- and the deputy; care.dependency.assess for the clinical lead and the team leader. Each change is
-- a new version of the role, made in that tenant's context and audited in the same transaction
-- (platform.role.permissions_migrated, naming what it gained), as migration 0031 does. Idempotent.
ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.role WHERE is_builtin ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    WITH grants(key, add) AS (VALUES
        ('owner', ARRAY['scheduling.dependency.manage', 'care.dependency.assess']),
        ('registered_manager', ARRAY['scheduling.dependency.manage', 'care.dependency.assess']),
        ('deputy_manager', ARRAY['scheduling.dependency.manage', 'care.dependency.assess']),
        ('clinical_lead', ARRAY['care.dependency.assess']),
        ('team_leader', ARRAY['care.dependency.assess'])
      ),
      targets AS (
        SELECT r.id, r.tenant_id, r.key,
          ARRAY(SELECT p FROM unnest(g.add) WITH ORDINALITY AS a(p, n)
                WHERE p <> ALL (r.permissions) ORDER BY n) AS missing
        FROM public.role r JOIN grants g ON g.key = r.key
        WHERE r.tenant_id = t AND r.is_builtin AND NOT (r.permissions @> g.add)
      ),
      changed AS (
        UPDATE public.role r SET permissions = r.permissions || x.missing
          FROM targets x WHERE r.id = x.id
          RETURNING r.id
      )
    INSERT INTO public.audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action,
        outcome, resource_type, resource_id, scope, reason)
      SELECT x.tenant_id, 'system', ARRAY['system'], 'platform.role.permissions_migrated',
        'success', 'role', x.id::text,
        jsonb_build_object('migration', '0074_dependency_tool', 'roleKey', x.key,
          'added', to_jsonb(x.missing)),
        'Existing tenants'' built-in role copies gained the dependency tool permissions their built-in definitions added (migration 0074)'
      FROM targets x JOIN changed c ON c.id = x.id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.role FORCE ROW LEVEL SECURITY;