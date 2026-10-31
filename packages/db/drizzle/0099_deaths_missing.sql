CREATE TABLE "death_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"exit_record_id" uuid NOT NULL,
	"incident_id" uuid,
	"died_at" timestamp with time zone NOT NULL,
	"expected" boolean,
	"possibly_unnatural" boolean,
	"judged_by" text,
	"learning_disability_or_autism" boolean NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"review_due_at" timestamp with time zone NOT NULL,
	"review_findings" text,
	"review_lessons" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"withdrawn_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "death_record_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "death_record_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "death_record_exit_key" UNIQUE("tenant_id","exit_record_id"),
	CONSTRAINT "death_record_status" CHECK (status IN ('open', 'closed', 'withdrawn')),
	CONSTRAINT "death_record_judged_by" CHECK (judged_by IS NULL OR char_length(btrim(judged_by)) BETWEEN 3 AND 200),
	CONSTRAINT "death_record_review" CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL)
        AND (reviewed_at IS NULL OR (coalesce(char_length(btrim(review_findings)), 0) BETWEEN 20 AND 10000
          AND coalesce(char_length(btrim(review_lessons)), 0) BETWEEN 20 AND 10000))),
	CONSTRAINT "death_record_closed" CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL)
        AND (status = 'withdrawn') = (withdrawn_reason IS NOT NULL)
        AND (withdrawn_reason IS NULL OR char_length(btrim(withdrawn_reason)) BETWEEN 3 AND 1000))
);
--> statement-breakpoint
CREATE TABLE "death_step" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"death_record_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"step" text NOT NULL,
	"outcome" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"note" text,
	"reference" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "death_step_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "death_step_step" CHECK (step IN ('verification_of_death', 'family_informed', 'medical_examiner_pack', 'cqc_reg16_notification', 'leder_notification', 'police_informed', 'preserve_room_and_equipment')),
	CONSTRAINT "death_step_outcome" CHECK (outcome IN ('done', 'not_needed')),
	CONSTRAINT "death_step_text" CHECK ((note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 2000)
        AND (reference IS NULL OR char_length(btrim(reference)) BETWEEN 1 AND 100)
        AND (outcome = 'done' OR coalesce(char_length(btrim(note)), 0) >= 20))
);
--> statement-breakpoint
CREATE TABLE "herbert_profile" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"photo_document_id" uuid,
	"physical_description" text NOT NULL,
	"distinguishing_features" text,
	"usual_clothing" text,
	"medical_needs" text,
	"mobility" text,
	"communication" text,
	"places_likely" text NOT NULL,
	"people_likely" text,
	"routines" text,
	"phone_or_tracker" text,
	"previous_episodes" text,
	"approach" text,
	"reviewed_with" text,
	"reviewed_on" date NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "herbert_profile_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "herbert_profile_person_key" UNIQUE("tenant_id","person_id"),
	CONSTRAINT "herbert_profile_required" CHECK (char_length(btrim(physical_description)) BETWEEN 10 AND 4000
        AND char_length(btrim(places_likely)) BETWEEN 10 AND 4000),
	CONSTRAINT "herbert_profile_text" CHECK ((distinguishing_features IS NULL OR char_length(distinguishing_features) <= 4000)
        AND (usual_clothing IS NULL OR char_length(usual_clothing) <= 4000)
        AND (medical_needs IS NULL OR char_length(medical_needs) <= 4000)
        AND (mobility IS NULL OR char_length(mobility) <= 4000)
        AND (communication IS NULL OR char_length(communication) <= 4000)
        AND (people_likely IS NULL OR char_length(people_likely) <= 4000)
        AND (routines IS NULL OR char_length(routines) <= 4000)
        AND (phone_or_tracker IS NULL OR char_length(phone_or_tracker) <= 1000)
        AND (previous_episodes IS NULL OR char_length(previous_episodes) <= 4000)
        AND (approach IS NULL OR char_length(approach) <= 4000)
        AND (reviewed_with IS NULL OR char_length(reviewed_with) <= 500))
);
--> statement-breakpoint
CREATE TABLE "missing_episode" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"immediate_risk" boolean DEFAULT false NOT NULL,
	"under_dols_or_mha" boolean DEFAULT false NOT NULL,
	"herbert_profile_version" integer,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "missing_episode_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "missing_episode_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "missing_episode_status" CHECK (status IN ('open', 'found', 'closed')),
	CONSTRAINT "missing_episode_closed" CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "missing_event" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"episode_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"reference" text,
	"area" text,
	"note" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "missing_event_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "missing_event_kind" CHECK (kind IN ('last_seen', 'noticed_missing', 'search_started', 'search', 'sighting', 'police_called', 'found', 'welfare_check', 'debrief', 'note')),
	CONSTRAINT "missing_event_text" CHECK ((kind <> 'police_called' OR coalesce(char_length(btrim(reference)), 0) BETWEEN 1 AND 100)
        AND (reference IS NULL OR kind = 'police_called')
        AND (kind <> 'search' OR coalesce(char_length(btrim(area)), 0) BETWEEN 1 AND 500)
        AND (area IS NULL OR kind = 'search')
        AND (note IS NULL OR char_length(note) <= 4000)
        AND (kind NOT IN ('found', 'welfare_check', 'debrief', 'sighting', 'note')
          OR coalesce(char_length(btrim(note)), 0) >= 10))
);
--> statement-breakpoint
ALTER TABLE "death_record" ADD CONSTRAINT "death_record_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_record" ADD CONSTRAINT "death_record_exit_fk" FOREIGN KEY ("tenant_id","person_id","exit_record_id") REFERENCES "public"."exit_record"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_record" ADD CONSTRAINT "death_record_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_record" ADD CONSTRAINT "death_record_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incident"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_record" ADD CONSTRAINT "death_record_reviewed_by_fk" FOREIGN KEY ("tenant_id","reviewed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_record" ADD CONSTRAINT "death_record_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_step" ADD CONSTRAINT "death_step_record_fk" FOREIGN KEY ("tenant_id","person_id","death_record_id") REFERENCES "public"."death_record"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_step" ADD CONSTRAINT "death_step_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_step" ADD CONSTRAINT "death_step_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "herbert_profile" ADD CONSTRAINT "herbert_profile_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "herbert_profile" ADD CONSTRAINT "herbert_profile_photo_fk" FOREIGN KEY ("tenant_id","photo_document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "herbert_profile" ADD CONSTRAINT "herbert_profile_reviewed_by_fk" FOREIGN KEY ("tenant_id","reviewed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missing_episode" ADD CONSTRAINT "missing_episode_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missing_episode" ADD CONSTRAINT "missing_episode_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missing_episode" ADD CONSTRAINT "missing_episode_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incident"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missing_episode" ADD CONSTRAINT "missing_episode_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missing_event" ADD CONSTRAINT "missing_event_episode_fk" FOREIGN KEY ("tenant_id","person_id","episode_id") REFERENCES "public"."missing_episode"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missing_event" ADD CONSTRAINT "missing_event_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missing_event" ADD CONSTRAINT "missing_event_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "death_record_open_idx" ON "death_record" USING btree ("tenant_id","status","died_at");--> statement-breakpoint
CREATE INDEX "death_step_record_idx" ON "death_step" USING btree ("tenant_id","death_record_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "missing_episode_one_open" ON "missing_episode" USING btree ("tenant_id","person_id") WHERE status <> 'closed' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "missing_episode_incident_idx" ON "missing_episode" USING btree ("tenant_id","incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "missing_event_once" ON "missing_event" USING btree ("tenant_id","episode_id","kind") WHERE kind IN ('last_seen', 'noticed_missing', 'search_started', 'police_called', 'found', 'welfare_check', 'debrief');--> statement-breakpoint
CREATE INDEX "missing_event_episode_idx" ON "missing_event" USING btree ("tenant_id","episode_id","at");--> statement-breakpoint

-- Slice 37 (SAFE-014, SAFE-015; safety.md slice 37; HZ-013, HZ-127). Everything below is what
-- Drizzle cannot express: forced row-level security with the person scope every record about a
-- person has (app.person_visible), guards that keep a finished record finished and its subject
-- fixed, append-only steps and timelines, grants, record history, and the sample data removal
-- list. Permissions are the API's to check (safety.incident.read, .report and .manage, where they
-- reach the person; ADR-0071); restrictive policies bind harbour_owner as well as harbour_app.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['death_record', 'death_step', 'missing_episode', 'missing_event',
    'herbert_profile'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', t);
    EXECUTE format(
      'CREATE POLICY person_child_scope ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner '
      'USING (app.person_visible(person_id)) WITH CHECK (app.person_visible(person_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- A death record that is closed or withdrawn never changes; its person, exit, location, time of
-- death and review due date never change; whoever records the review or closes it is the person
-- doing it (the worker, with no user, only withdraws a death recorded in error).
CREATE OR REPLACE FUNCTION app.death_record_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_me uuid := app.current_user_id();
BEGIN
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'death_record_finished' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.exit_record_id IS DISTINCT FROM OLD.exit_record_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.died_at IS DISTINCT FROM OLD.died_at
     OR NEW.review_due_at IS DISTINCT FROM OLD.review_due_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'death_record_fixed_fields' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at AND NEW.reviewed_by IS DISTINCT FROM v_me THEN
    RAISE EXCEPTION 'death_record_reviewer_not_you' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'closed' AND NEW.closed_by IS DISTINCT FROM v_me THEN
    RAISE EXCEPTION 'death_record_closer_not_you' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER death_record_guard BEFORE UPDATE ON public.death_record
  FOR EACH ROW EXECUTE FUNCTION app.death_record_guard();
--> statement-breakpoint

-- A closed episode never changes; its person, incident and location never change; whoever closes
-- it is the person doing it.
CREATE OR REPLACE FUNCTION app.missing_episode_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'missing_episode_closed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.incident_id IS DISTINCT FROM OLD.incident_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'missing_episode_fixed_fields' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'closed' AND NEW.closed_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'missing_episode_closer_not_you' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER missing_episode_guard BEFORE UPDATE ON public.missing_episode
  FOR EACH ROW EXECUTE FUNCTION app.missing_episode_guard();
--> statement-breakpoint

-- A profile stays the person's; whoever reviews it is the person doing it.
CREATE OR REPLACE FUNCTION app.herbert_profile_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'herbert_profile_fixed_fields' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.reviewed_on IS DISTINCT FROM OLD.reviewed_on OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by)
     AND NEW.reviewed_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'herbert_profile_reviewer_not_you' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER herbert_profile_guard BEFORE UPDATE ON public.herbert_profile
  FOR EACH ROW EXECUTE FUNCTION app.herbert_profile_guard();
--> statement-breakpoint
-- A new profile is reviewed by whoever writes it.
CREATE POLICY herbert_profile_write ON public.herbert_profile AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (reviewed_by = app.current_user_id());
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['death_record', 'missing_episode', 'herbert_profile'] LOOP
    EXECUTE format(
      'CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format(
      'CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO harbour_app', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON public.%I FROM harbour_app', t);
  END LOOP;
  -- The steps of a death and the timeline of an episode are append-only: a correction is a new
  -- entry (the latest step counts; a note on the timeline).
  FOREACH t IN ARRAY ARRAY['death_step', 'missing_event'] LOOP
    EXECUTE format(
      'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format(
      'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO harbour_app', t);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM harbour_app', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Sample data (migration 0069): records about a removed sample person go with them, children
-- before parents. The list is migration 0069's with slice 37's tables first.
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
    -- 'outbreak_case' carried over from migration 0093, which this redefinition follows.
    'outbreak_case',
    'death_step', 'missing_event', 'death_record', 'missing_episode', 'herbert_profile',
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
GRANT SELECT, DELETE ON public.death_step, public.missing_event, public.death_record,
  public.missing_episode, public.herbert_profile TO harbour_sample_owner;
