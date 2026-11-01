CREATE TABLE "lms_course_map" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"source_id" uuid NOT NULL,
	"course_code" text NOT NULL,
	"topic" text NOT NULL,
	"tier" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "lms_course_map_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "lms_course_map_code_key" UNIQUE("tenant_id","source_id","course_code"),
	CONSTRAINT "lms_course_map_code" CHECK (course_code ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$'),
	CONSTRAINT "lms_course_map_topic" CHECK (topic IN ('care_certificate', 'safeguarding_adults', 'safeguarding_children', 'moving_and_handling', 'infection_prevention_and_control', 'fire_safety', 'health_and_safety', 'basic_life_support', 'food_hygiene', 'medicines', 'mental_capacity_and_dols', 'equality_diversity_and_human_rights', 'information_governance', 'dementia_awareness', 'fluids_and_nutrition', 'oliver_mcgowan')),
	CONSTRAINT "lms_course_map_tier" CHECK ((tier IS NULL) = (topic <> 'oliver_mcgowan') AND (tier IS NULL OR tier IN (1, 2)))
);
--> statement-breakpoint
CREATE TABLE "lms_import" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"source_id" uuid NOT NULL,
	"format" text NOT NULL,
	"row_count" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"dry_run_number" integer DEFAULT 0 NOT NULL,
	"dry_run_at" timestamp with time zone,
	"dry_run_by" uuid,
	"dry_run_counts" jsonb,
	"dry_run_sha256" text,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "lms_import_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "lms_import_format" CHECK (format IN ('csv', 'json', 'api')),
	CONSTRAINT "lms_import_status" CHECK (status IN ('open', 'closed', 'discarded')),
	CONSTRAINT "lms_import_closed" CHECK ((status = 'open') = (closed_at IS NULL)),
	CONSTRAINT "lms_import_rows" CHECK (row_count BETWEEN 1 AND 5000),
	CONSTRAINT "lms_import_hash" CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "lms_import_dry_run" CHECK (dry_run_number >= 0
        AND (dry_run_number = 0) = (dry_run_at IS NULL)
        AND (dry_run_at IS NULL) = (dry_run_by IS NULL)
        AND (dry_run_at IS NULL) = (dry_run_counts IS NULL)
        AND (dry_run_at IS NULL) = (dry_run_sha256 IS NULL)
        AND (dry_run_sha256 IS NULL OR dry_run_sha256 ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "lms_import_row" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"import_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"learner_id" text NOT NULL,
	"course_code" text NOT NULL,
	"completed_on" date,
	"expires_on" date,
	"record_id" text NOT NULL,
	"provider" text,
	"problems" text[] NOT NULL,
	"class" text,
	"worker_id" uuid,
	"topic" text,
	"tier" integer,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"training_record_id" uuid,
	"skip_reason" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "lms_import_row_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "lms_import_row_number_key" UNIQUE("tenant_id","import_id","row_number"),
	CONSTRAINT "lms_import_row_number" CHECK (row_number BETWEEN 1 AND 5000),
	CONSTRAINT "lms_import_row_ids" CHECK ((learner_id = '' OR learner_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$')
        AND (course_code = '' OR course_code ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$')
        AND length(record_id) BETWEEN 1 AND 240 AND position('@' in record_id) = 0),
	CONSTRAINT "lms_import_row_provider" CHECK (provider IS NULL OR length(btrim(provider)) BETWEEN 2 AND 160),
	CONSTRAINT "lms_import_row_class" CHECK (class IS NULL OR class IN ('ready', 'unmatched_learner', 'unmapped_course', 'already_recorded', 'own_record', 'invalid')),
	CONSTRAINT "lms_import_row_outcome" CHECK (outcome IN ('pending', 'imported', 'skipped')),
	CONSTRAINT "lms_import_row_topic" CHECK ((topic IS NULL OR topic IN ('care_certificate', 'safeguarding_adults', 'safeguarding_children', 'moving_and_handling', 'infection_prevention_and_control', 'fire_safety', 'health_and_safety', 'basic_life_support', 'food_hygiene', 'medicines', 'mental_capacity_and_dols', 'equality_diversity_and_human_rights', 'information_governance', 'dementia_awareness', 'fluids_and_nutrition', 'oliver_mcgowan'))
        AND (tier IS NULL OR tier IN (1, 2))),
	CONSTRAINT "lms_import_row_resolved" CHECK ((outcome = 'pending') = (resolved_at IS NULL)
        AND (resolved_at IS NULL) = (resolved_by IS NULL)
        AND (outcome = 'imported') = (training_record_id IS NOT NULL)
        AND (outcome = 'skipped') = (skip_reason IS NOT NULL)
        AND (skip_reason IS NULL OR length(btrim(skip_reason)) BETWEEN 3 AND 500))
);
--> statement-breakpoint
CREATE TABLE "lms_learner_link" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"source_id" uuid NOT NULL,
	"learner_id" text NOT NULL,
	"worker_id" uuid NOT NULL,
	"linked_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "lms_learner_link_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "lms_learner_link_learner" CHECK (learner_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$')
);
--> statement-breakpoint
CREATE TABLE "lms_source" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"external_organisation_id" text,
	"secret_ref" text,
	"status" text DEFAULT 'active' NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "lms_source_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "lms_source_kind" CHECK (kind IN ('file', 'api')),
	CONSTRAINT "lms_source_status" CHECK (status IN ('active', 'ended')),
	CONSTRAINT "lms_source_ended" CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
	CONSTRAINT "lms_source_name" CHECK (length(btrim(name)) BETWEEN 2 AND 80),
	CONSTRAINT "lms_source_api" CHECK ((kind = 'api') = (external_organisation_id IS NOT NULL)
        AND (external_organisation_id IS NULL OR external_organisation_id ~ '^[A-Za-z0-9-]{1,64}$')
        AND secret_ref IS NOT DISTINCT FROM
          CASE WHEN kind = 'api' THEN 'lms/' || tenant_id::text || '/' || id::text END)
);
--> statement-breakpoint
ALTER TABLE "lms_course_map" ADD CONSTRAINT "lms_course_map_source_fk" FOREIGN KEY ("tenant_id","source_id") REFERENCES "public"."lms_source"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lms_import" ADD CONSTRAINT "lms_import_source_fk" FOREIGN KEY ("tenant_id","source_id") REFERENCES "public"."lms_source"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lms_import" ADD CONSTRAINT "lms_import_uploaded_by_fk" FOREIGN KEY ("tenant_id","uploaded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lms_import" ADD CONSTRAINT "lms_import_dry_run_by_fk" FOREIGN KEY ("tenant_id","dry_run_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lms_import" ADD CONSTRAINT "lms_import_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lms_import_row" ADD CONSTRAINT "lms_import_row_import_fk" FOREIGN KEY ("tenant_id","import_id") REFERENCES "public"."lms_import"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lms_import_row" ADD CONSTRAINT "lms_import_row_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lms_import_row" ADD CONSTRAINT "lms_import_row_resolved_by_fk" FOREIGN KEY ("tenant_id","resolved_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lms_learner_link" ADD CONSTRAINT "lms_learner_link_source_fk" FOREIGN KEY ("tenant_id","source_id") REFERENCES "public"."lms_source"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lms_learner_link" ADD CONSTRAINT "lms_learner_link_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lms_learner_link" ADD CONSTRAINT "lms_learner_link_linked_by_fk" FOREIGN KEY ("tenant_id","linked_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "lms_import_source_idx" ON "lms_import" USING btree ("tenant_id","source_id","uploaded_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "lms_learner_link_learner_key" ON "lms_learner_link" USING btree ("tenant_id","source_id","learner_id") WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "lms_learner_link_worker_key" ON "lms_learner_link" USING btree ("tenant_id","source_id","worker_id") WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "lms_source_name_key" ON "lms_source" USING btree ("tenant_id",lower(name)) WHERE status = 'active' AND deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE "training_record" ADD COLUMN "source" text DEFAULT 'harbour' NOT NULL;
--> statement-breakpoint
ALTER TABLE "training_record" ADD COLUMN "lms_source_id" uuid;
--> statement-breakpoint
ALTER TABLE "training_record" ADD COLUMN "lms_import_row_id" uuid;
--> statement-breakpoint
ALTER TABLE "training_record" ADD COLUMN "external_record_id" text;
--> statement-breakpoint
ALTER TABLE "training_record" ADD CONSTRAINT "training_record_source" CHECK (source IN ('harbour', 'lms'));
--> statement-breakpoint
ALTER TABLE "training_record" ADD CONSTRAINT "training_record_imported" CHECK ((source = 'lms') = (lms_source_id IS NOT NULL)
        AND (source = 'lms') = (lms_import_row_id IS NOT NULL)
        AND (source = 'lms') = (external_record_id IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX "training_record_external_key" ON "training_record" USING btree ("tenant_id","lms_source_id","external_record_id") WHERE external_record_id IS NOT NULL;
--> statement-breakpoint

-- Imports of external training records from a learning platform (workforce.md section 13;
-- WORK-006, slice 78; ADR-0102). Forced RLS with the tenant policy on every new table (ADR-0002),
-- and only holders of workforce.training.manage reach them, as the training matrix (slice 17). An
-- API source's secret is named by the database, never by a caller. A learner is linked to a member
-- by a person, by the platform's stable id. An imported completion is a new training record that
-- names its source and import row and keeps its completion as imported; an import never changes a
-- record made in Harbour, and nobody imports their own record. Training certificates are
-- documents of their own category, read like the training record they belong to. Runs as
-- harbour_owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lms_source', 'lms_course_map', 'lms_learner_link', 'lms_import',
      'lms_import_row'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
    EXECUTE format(
      'CREATE POLICY lms_training_manage ON public.%I AS RESTRICTIVE FOR ALL '
      'TO harbour_app, harbour_owner '
      'USING (app.is_system() OR app.holds_staff_permission(''workforce.training.manage'')) '
      'WITH CHECK (app.is_system() OR app.holds_staff_permission(''workforce.training.manage''))', t);
    EXECUTE format(
      'CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format(
      'CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format(
      'CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO harbour_app', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON public.%I FROM harbour_app', t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- A learner is linked to someone else, in the linker's own name (rule 3).
CREATE POLICY lms_learner_link_insert ON public.lms_learner_link AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.is_system() OR (worker_id <> app.current_user_id()
    AND linked_by = app.current_user_id()));
--> statement-breakpoint
CREATE POLICY lms_import_insert ON public.lms_import AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.is_system() OR uploaded_by = app.current_user_id());
--> statement-breakpoint

-- Rule 1: a source keeps its kind, its platform id and its secret, which the database names; it
-- ends once, at the database's time.
CREATE OR REPLACE FUNCTION app.lms_source_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.secret_ref := CASE WHEN NEW.kind = 'api'
    THEN 'lms/' || NEW.tenant_id::text || '/' || NEW.id::text END;
  NEW.status := 'active';
  NEW.ended_at := NULL;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER lms_source_insert_guard BEFORE INSERT ON public.lms_source
  FOR EACH ROW EXECUTE FUNCTION app.lms_source_insert_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lms_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.external_organisation_id IS DISTINCT FROM OLD.external_organisation_id
     OR NEW.secret_ref IS DISTINCT FROM OLD.secret_ref THEN
    RAISE EXCEPTION 'lms_source_fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'ended' AND (NEW.status <> 'ended' OR NEW.ended_at IS DISTINCT FROM OLD.ended_at) THEN
    RAISE EXCEPTION 'lms_source_ended' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'ended' THEN
    NEW.ended_at := now();
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER lms_source_guard BEFORE UPDATE ON public.lms_source
  FOR EACH ROW EXECUTE FUNCTION app.lms_source_guard();
--> statement-breakpoint

-- Rule 4: a mapping keeps its source and course code; only its topic, tier and whether it is in
-- use change.
CREATE OR REPLACE FUNCTION app.lms_course_map_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.course_code IS DISTINCT FROM OLD.course_code THEN
    RAISE EXCEPTION 'lms_course_map_fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER lms_course_map_guard BEFORE UPDATE ON public.lms_course_map
  FOR EACH ROW EXECUTE FUNCTION app.lms_course_map_guard();
--> statement-breakpoint

-- Rule 3: a link is fixed; it is only ended (deleted_at), once. A new link is a new row.
CREATE OR REPLACE FUNCTION app.lms_learner_link_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.learner_id IS DISTINCT FROM OLD.learner_id
     OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
     OR NEW.linked_by IS DISTINCT FROM OLD.linked_by
     OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
    RAISE EXCEPTION 'lms_learner_link_fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER lms_learner_link_guard BEFORE UPDATE ON public.lms_learner_link
  FOR EACH ROW EXECUTE FUNCTION app.lms_learner_link_guard();
--> statement-breakpoint

-- Rules 2 and 4: an import keeps what was uploaded; its dry runs count up one at a time in the
-- runner's name at the database's time; it closes or is discarded once.
CREATE OR REPLACE FUNCTION app.lms_import_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.lms_source s
             WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.source_id AND s.status = 'ended') THEN
    RAISE EXCEPTION 'lms_source_ended' USING ERRCODE = 'check_violation';
  END IF;
  NEW.status := 'open';
  NEW.uploaded_at := now();
  NEW.dry_run_number := 0;
  NEW.dry_run_at := NULL;
  NEW.dry_run_by := NULL;
  NEW.dry_run_counts := NULL;
  NEW.dry_run_sha256 := NULL;
  NEW.closed_at := NULL;
  NEW.closed_by := NULL;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER lms_import_insert_guard BEFORE INSERT ON public.lms_import
  FOR EACH ROW EXECUTE FUNCTION app.lms_import_insert_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lms_import_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.format IS DISTINCT FROM OLD.format
     OR NEW.row_count IS DISTINCT FROM OLD.row_count
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
     OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at THEN
    RAISE EXCEPTION 'lms_import_fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'lms_import_closed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.dry_run_number <> OLD.dry_run_number THEN
    IF NEW.dry_run_number <> OLD.dry_run_number + 1 THEN
      RAISE EXCEPTION 'lms_import_dry_run_number' USING ERRCODE = 'check_violation';
    END IF;
    NEW.dry_run_at := now();
    NEW.dry_run_by := app.current_user_id();
  ELSIF NEW.dry_run_at IS DISTINCT FROM OLD.dry_run_at
     OR NEW.dry_run_by IS DISTINCT FROM OLD.dry_run_by
     OR NEW.dry_run_counts IS DISTINCT FROM OLD.dry_run_counts
     OR NEW.dry_run_sha256 IS DISTINCT FROM OLD.dry_run_sha256 THEN
    RAISE EXCEPTION 'lms_import_dry_run_number' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'open' THEN
    NEW.closed_at := now();
    NEW.closed_by := app.current_user_id();
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER lms_import_guard BEFORE UPDATE ON public.lms_import
  FOR EACH ROW EXECUTE FUNCTION app.lms_import_guard();
--> statement-breakpoint

-- Rules 2, 3 and 5: a row is added only to an open import and keeps what it was given; its class
-- changes only while it is pending in an open import; it is imported (naming the training record
-- made from it) or skipped (with a reason) once, in the resolver's name at the database's time.
CREATE OR REPLACE FUNCTION app.lms_import_is_open(p_import_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.lms_import i
                 WHERE i.id = p_import_id AND i.status = 'open')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lms_import_row_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.lms_import_is_open(NEW.import_id) THEN
    RAISE EXCEPTION 'lms_import_closed' USING ERRCODE = 'check_violation';
  END IF;
  NEW.outcome := 'pending';
  NEW.training_record_id := NULL;
  NEW.skip_reason := NULL;
  NEW.resolved_by := NULL;
  NEW.resolved_at := NULL;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER lms_import_row_insert_guard BEFORE INSERT ON public.lms_import_row
  FOR EACH ROW EXECUTE FUNCTION app.lms_import_row_insert_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lms_import_row_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.import_id IS DISTINCT FROM OLD.import_id OR NEW.row_number IS DISTINCT FROM OLD.row_number
     OR NEW.learner_id IS DISTINCT FROM OLD.learner_id
     OR NEW.course_code IS DISTINCT FROM OLD.course_code
     OR NEW.completed_on IS DISTINCT FROM OLD.completed_on
     OR NEW.expires_on IS DISTINCT FROM OLD.expires_on
     OR NEW.record_id IS DISTINCT FROM OLD.record_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.problems IS DISTINCT FROM OLD.problems
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'lms_import_row_fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.outcome <> 'pending' OR NOT app.lms_import_is_open(OLD.import_id) THEN
    RAISE EXCEPTION 'lms_import_row_resolved' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.outcome = 'imported' AND NOT EXISTS (
      SELECT 1 FROM public.training_record r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.training_record_id
        AND r.lms_import_row_id = NEW.id) THEN
    RAISE EXCEPTION 'lms_import_row_not_imported' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.outcome <> 'pending' THEN
    NEW.resolved_by := app.current_user_id();
    NEW.resolved_at := now();
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER lms_import_row_guard BEFORE UPDATE ON public.lms_import_row
  FOR EACH ROW EXECUTE FUNCTION app.lms_import_row_guard();
--> statement-breakpoint

-- Rule 6: an imported training record is made only from a pending ready row of an open import of
-- its source, exactly as the row says; afterwards it keeps its source and its completion. A
-- record made in Harbour stays Harbour's.
CREATE OR REPLACE FUNCTION app.training_record_import_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.source = 'lms' AND NOT EXISTS (
      SELECT 1 FROM public.lms_import_row r
      JOIN public.lms_import i ON i.tenant_id = r.tenant_id AND i.id = r.import_id
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.lms_import_row_id
        AND r.outcome = 'pending' AND r.class = 'ready' AND i.status = 'open'
        AND i.source_id = NEW.lms_source_id
        AND r.worker_id = NEW.worker_id AND r.topic = NEW.topic
        AND r.tier IS NOT DISTINCT FROM NEW.tier
        AND r.completed_on = NEW.completed_on
        AND r.expires_on IS NOT DISTINCT FROM NEW.expires_on
        AND r.record_id = NEW.external_record_id) THEN
    RAISE EXCEPTION 'training_record_import_mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER training_record_import_guard BEFORE INSERT ON public.training_record
  FOR EACH ROW EXECUTE FUNCTION app.training_record_import_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.training_record_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.source IS DISTINCT FROM OLD.source
     OR NEW.lms_source_id IS DISTINCT FROM OLD.lms_source_id
     OR NEW.lms_import_row_id IS DISTINCT FROM OLD.lms_import_row_id
     OR NEW.external_record_id IS DISTINCT FROM OLD.external_record_id THEN
    RAISE EXCEPTION 'training_record_source_fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.source = 'lms' AND (NEW.worker_id IS DISTINCT FROM OLD.worker_id
     OR NEW.topic IS DISTINCT FROM OLD.topic OR NEW.tier IS DISTINCT FROM OLD.tier
     OR NEW.completed_on IS DISTINCT FROM OLD.completed_on
     OR NEW.expires_on IS DISTINCT FROM OLD.expires_on
     OR NEW.provider IS DISTINCT FROM OLD.provider) THEN
    RAISE EXCEPTION 'training_record_imported_fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER training_record_source_guard BEFORE UPDATE ON public.training_record
  FOR EACH ROW EXECUTE FUNCTION app.training_record_source_guard();
--> statement-breakpoint
ALTER TABLE public.training_record ADD CONSTRAINT training_record_lms_source_fk
  FOREIGN KEY (tenant_id, lms_source_id) REFERENCES public.lms_source (tenant_id, id);
--> statement-breakpoint
ALTER TABLE public.training_record ADD CONSTRAINT training_record_lms_import_row_fk
  FOREIGN KEY (tenant_id, lms_import_row_id) REFERENCES public.lms_import_row (tenant_id, id);
--> statement-breakpoint
ALTER TABLE public.lms_import_row ADD CONSTRAINT lms_import_row_training_record_fk
  FOREIGN KEY (tenant_id, training_record_id) REFERENCES public.training_record (tenant_id, id);
--> statement-breakpoint

-- Rule 8: a training certificate (category training_certificate) belongs to a training record
-- and is read as that record is: by readers of development records, or by the member it is about;
-- added only by a holder of workforce.training.manage, for someone else's record.
CREATE OR REPLACE FUNCTION app.training_record_worker(p_record_id uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT r.worker_id FROM public.training_record r WHERE r.id = p_record_id
$$;
--> statement-breakpoint
CREATE POLICY document_training_certificate ON public.document AS RESTRICTIVE FOR ALL
  TO harbour_app
  USING (category <> 'training_certificate' OR app.is_system()
    OR (subject_type = 'training_record' AND (app.reads_development()
        OR app.reads_own_development(app.training_record_worker(subject_id)))))
  WITH CHECK (category <> 'training_certificate' OR app.is_system()
    OR (app.holds_staff_permission('workforce.training.manage')
        AND person_id IS NULL
        AND subject_type = 'training_record'
        AND app.training_record_worker(subject_id) <> app.current_user_id()));
