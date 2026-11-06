CREATE TABLE "elearning_attempt" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"course_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"score" numeric(5, 4),
	"location" text,
	"suspend_data" text,
	"total_seconds" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"training_record_id" uuid,
	"launch_nonce" uuid DEFAULT app.uuid_v7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "elearning_attempt_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "elearning_attempt_training_record_key" UNIQUE("tenant_id","training_record_id"),
	CONSTRAINT "elearning_attempt_status" CHECK (status IN ('in_progress', 'completed', 'passed', 'failed')),
	CONSTRAINT "elearning_attempt_score" CHECK (score IS NULL OR score BETWEEN 0 AND 1),
	CONSTRAINT "elearning_attempt_location" CHECK (location IS NULL OR length(location) <= 1000),
	CONSTRAINT "elearning_attempt_suspend" CHECK (suspend_data IS NULL OR length(suspend_data) <= 64000),
	CONSTRAINT "elearning_attempt_seconds" CHECK (total_seconds >= 0),
	CONSTRAINT "elearning_attempt_record" CHECK (training_record_id IS NULL OR status IN ('completed', 'passed'))
);
--> statement-breakpoint
CREATE TABLE "elearning_course" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"title" text NOT NULL,
	"topic" text NOT NULL,
	"tier" integer,
	"standard" text NOT NULL,
	"document_id" uuid NOT NULL,
	"package_sha256" text NOT NULL,
	"launch_path" text NOT NULL,
	"launch_query" text DEFAULT '' NOT NULL,
	"package_identifier" text,
	"file_count" integer NOT NULL,
	"unpacked_bytes" integer NOT NULL,
	"package_index" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "elearning_course_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "elearning_course_title" CHECK (length(btrim(title)) BETWEEN 2 AND 160),
	CONSTRAINT "elearning_course_topic" CHECK (topic IN ('care_certificate', 'safeguarding_adults', 'safeguarding_children', 'moving_and_handling', 'infection_prevention_and_control', 'fire_safety', 'health_and_safety', 'basic_life_support', 'food_hygiene', 'medicines', 'mental_capacity_and_dols', 'equality_diversity_and_human_rights', 'information_governance', 'dementia_awareness', 'fluids_and_nutrition', 'oliver_mcgowan')),
	CONSTRAINT "elearning_course_tier" CHECK ((tier IS NULL) = (topic <> 'oliver_mcgowan') AND (tier IS NULL OR tier IN (1, 2))),
	CONSTRAINT "elearning_course_standard" CHECK (standard IN ('scorm_1_2', 'scorm_2004', 'xapi')),
	CONSTRAINT "elearning_course_status" CHECK (status IN ('active', 'retired')),
	CONSTRAINT "elearning_course_sha256" CHECK (package_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "elearning_course_launch_path" CHECK (length(launch_path) BETWEEN 1 AND 240 AND launch_path !~ '(^/|\\|(^|/)\.\.?(/|$))'),
	CONSTRAINT "elearning_course_launch_query" CHECK (length(launch_query) <= 500),
	CONSTRAINT "elearning_course_counts" CHECK (file_count > 0 AND unpacked_bytes >= 0),
	CONSTRAINT "elearning_course_index" CHECK (jsonb_typeof(package_index) = 'array' AND jsonb_array_length(package_index) = file_count)
);
--> statement-breakpoint
CREATE TABLE "elearning_statement" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"verb" text NOT NULL,
	"statement" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "elearning_statement_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "elearning_statement_once_key" UNIQUE("tenant_id","attempt_id","statement_id"),
	CONSTRAINT "elearning_statement_verb" CHECK (verb ~ '^https?://' AND length(verb) <= 300),
	CONSTRAINT "elearning_statement_size" CHECK (octet_length(statement::text) <= 32768)
);
--> statement-breakpoint
ALTER TABLE "elearning_attempt" ADD CONSTRAINT "elearning_attempt_course_fk" FOREIGN KEY ("tenant_id","course_id") REFERENCES "public"."elearning_course"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elearning_attempt" ADD CONSTRAINT "elearning_attempt_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elearning_attempt" ADD CONSTRAINT "elearning_attempt_training_record_fk" FOREIGN KEY ("tenant_id","training_record_id") REFERENCES "public"."training_record"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elearning_course" ADD CONSTRAINT "elearning_course_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elearning_statement" ADD CONSTRAINT "elearning_statement_attempt_fk" FOREIGN KEY ("tenant_id","attempt_id") REFERENCES "public"."elearning_attempt"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "elearning_attempt_worker_idx" ON "elearning_attempt" USING btree ("tenant_id","worker_id","course_id");--> statement-breakpoint
CREATE INDEX "elearning_statement_attempt_idx" ON "elearning_statement" USING btree ("tenant_id","attempt_id");--> statement-breakpoint
-- Security (workforce.md section 14; ADR-0093; slice 43). Forced row-level security on every table.
-- Courses: read by staff (workforce.self.read) and training leads, written by
-- workforce.training.manage. Attempts and statements: a member's own, read by those who read
-- development records (app.reads_development, migration 0079); the link to the training record a
-- completion made is set only by the organisation's system context. Nothing is deleted.
-- Runs as harbour_owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['elearning_course', 'elearning_attempt', 'elearning_statement'] LOOP
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
CREATE POLICY elearning_course_read ON public.elearning_course AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (app.is_system() OR app.holds_staff_permission('workforce.training.manage')
    OR app.holds_staff_permission('workforce.self.read'));
--> statement-breakpoint
CREATE POLICY elearning_course_write ON public.elearning_course AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.is_system() OR app.holds_staff_permission('workforce.training.manage'));
--> statement-breakpoint
CREATE POLICY elearning_course_change ON public.elearning_course AS RESTRICTIVE FOR UPDATE
  TO harbour_app
  USING (app.is_system() OR app.holds_staff_permission('workforce.training.manage'))
  WITH CHECK (app.is_system() OR app.holds_staff_permission('workforce.training.manage'));
--> statement-breakpoint
CREATE POLICY elearning_attempt_read ON public.elearning_attempt AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (app.is_system() OR app.reads_development() OR app.reads_own_development(worker_id));
--> statement-breakpoint
CREATE POLICY elearning_attempt_write ON public.elearning_attempt AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.is_system() OR app.reads_own_development(worker_id));
--> statement-breakpoint
CREATE POLICY elearning_attempt_change ON public.elearning_attempt AS RESTRICTIVE FOR UPDATE
  TO harbour_app
  USING (app.is_system() OR app.reads_own_development(worker_id))
  WITH CHECK (app.is_system() OR app.reads_own_development(worker_id));
--> statement-breakpoint
-- The member an attempt is for, as the caller can see it (invoker rights); null when hidden.
CREATE OR REPLACE FUNCTION app.elearning_attempt_worker(p_attempt_id uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT a.worker_id FROM public.elearning_attempt a WHERE a.id = p_attempt_id
$$;
--> statement-breakpoint
CREATE POLICY elearning_statement_read ON public.elearning_statement AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (app.is_system() OR app.reads_development()
    OR app.reads_own_development(app.elearning_attempt_worker(attempt_id)));
--> statement-breakpoint
CREATE POLICY elearning_statement_write ON public.elearning_statement AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.is_system()
    OR app.reads_own_development(app.elearning_attempt_worker(attempt_id)));
--> statement-breakpoint
-- An attempt keeps its member and course; only the system links the training record it made;
-- a settled outcome (completed, passed or failed) is never changed: a retake is a new attempt
-- (review M1).
CREATE OR REPLACE FUNCTION app.elearning_attempt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.worker_id IS DISTINCT FROM OLD.worker_id OR NEW.course_id IS DISTINCT FROM OLD.course_id THEN
    RAISE EXCEPTION 'an attempt keeps its member and course' USING ERRCODE = '42501';
  END IF;
  IF NEW.training_record_id IS DISTINCT FROM OLD.training_record_id AND NOT app.is_system() THEN
    RAISE EXCEPTION 'only the system records a completion' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('completed', 'passed', 'failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a settled outcome is kept' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.elearning_attempt_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.training_record_id IS NOT NULL AND NOT app.is_system() THEN
    RAISE EXCEPTION 'only the system records a completion' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER elearning_attempt_guard BEFORE UPDATE ON public.elearning_attempt
  FOR EACH ROW EXECUTE FUNCTION app.elearning_attempt_guard();
--> statement-breakpoint
CREATE TRIGGER elearning_attempt_insert_guard BEFORE INSERT ON public.elearning_attempt
  FOR EACH ROW EXECUTE FUNCTION app.elearning_attempt_insert_guard();
--> statement-breakpoint
-- A course's package is an e-learning package document, never another document (review L1).
CREATE OR REPLACE FUNCTION app.elearning_course_document_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.document_id IS DISTINCT FROM OLD.document_id)
     AND NOT EXISTS (SELECT 1 FROM public.document d
                      WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.document_id
                        AND d.category = 'elearning_package') THEN
    RAISE EXCEPTION 'a course''s package is an e-learning package' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER elearning_course_document_guard BEFORE INSERT OR UPDATE OF document_id
  ON public.elearning_course
  FOR EACH ROW EXECUTE FUNCTION app.elearning_course_document_guard();
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['elearning_course', 'elearning_attempt'] LOOP
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
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.elearning_statement
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.elearning_statement
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.elearning_course, public.elearning_attempt TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.elearning_statement TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.elearning_statement FROM harbour_app;
--> statement-breakpoint
-- Earlier versions of attempts follow the attempt's own read rule.
CREATE POLICY record_version_elearning ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (table_name <> 'elearning_attempt'
    OR app.is_system() OR app.reads_development()
    OR app.reads_own_development((data->>'worker_id')::uuid));
