CREATE TABLE "competence_sign_off" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"worker_id" uuid NOT NULL,
	"competence" text NOT NULL,
	"observed_on" date NOT NULL,
	"observer_id" uuid DEFAULT app.current_user_id() NOT NULL,
	"valid_until" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "competence_sign_off_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "competence_sign_off_competence" CHECK (competence IN ('medicines_administration', 'controlled_drugs', 'insulin_administration', 'epilepsy_rescue_medication', 'moving_and_handling_hoist', 'catheter_care', 'enteral_feeding', 'oxygen_therapy')),
	CONSTRAINT "competence_sign_off_valid_until" CHECK (valid_until > observed_on),
	CONSTRAINT "competence_sign_off_not_self" CHECK (observer_id <> worker_id)
);
--> statement-breakpoint
CREATE TABLE "competence_withdrawal" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"sign_off_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"withdrawn_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "competence_withdrawal_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "competence_withdrawal_sign_off_key" UNIQUE("tenant_id","sign_off_id"),
	CONSTRAINT "competence_withdrawal_reason" CHECK (length(btrim(reason)) BETWEEN 10 AND 500)
);
--> statement-breakpoint
CREATE TABLE "revalidation_evidence" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"worker_id" uuid NOT NULL,
	"cycle_due_on" date NOT NULL,
	"practice_hours" integer DEFAULT 0 NOT NULL,
	"cpd_hours" integer DEFAULT 0 NOT NULL,
	"participatory_cpd_hours" integer DEFAULT 0 NOT NULL,
	"feedback_pieces" integer DEFAULT 0 NOT NULL,
	"reflective_accounts" integer DEFAULT 0 NOT NULL,
	"reflective_discussion" boolean DEFAULT false NOT NULL,
	"health_and_character" boolean DEFAULT false NOT NULL,
	"professional_indemnity" boolean DEFAULT false NOT NULL,
	"confirmation" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "revalidation_evidence_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "revalidation_evidence_cycle_key" UNIQUE("tenant_id","worker_id","cycle_due_on"),
	CONSTRAINT "revalidation_evidence_counts" CHECK (practice_hours BETWEEN 0 AND 10000 AND cpd_hours BETWEEN 0 AND 1000
        AND participatory_cpd_hours BETWEEN 0 AND cpd_hours
        AND feedback_pieces BETWEEN 0 AND 100 AND reflective_accounts BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "supervision_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"worker_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"held_on" date NOT NULL,
	"held_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "supervision_record_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "supervision_record_kind" CHECK (kind IN ('supervision', 'appraisal', 'spot_check')),
	CONSTRAINT "supervision_record_not_self" CHECK (held_by <> worker_id)
);
--> statement-breakpoint
CREATE TABLE "training_record" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"worker_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"tier" integer,
	"completed_on" date NOT NULL,
	"expires_on" date,
	"provider" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "training_record_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "training_record_topic" CHECK (topic IN ('care_certificate', 'safeguarding_adults', 'safeguarding_children', 'moving_and_handling', 'infection_prevention_and_control', 'fire_safety', 'health_and_safety', 'basic_life_support', 'food_hygiene', 'medicines', 'mental_capacity_and_dols', 'equality_diversity_and_human_rights', 'information_governance', 'dementia_awareness', 'fluids_and_nutrition', 'oliver_mcgowan')),
	CONSTRAINT "training_record_tier" CHECK ((tier IS NULL) = (topic <> 'oliver_mcgowan') AND (tier IS NULL OR tier IN (1, 2))),
	CONSTRAINT "training_record_expiry" CHECK (expires_on IS NULL OR expires_on >= completed_on),
	CONSTRAINT "training_record_provider" CHECK (provider IS NULL OR length(btrim(provider)) BETWEEN 2 AND 160)
);
--> statement-breakpoint
CREATE TABLE "training_requirement" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"role_key" text NOT NULL,
	"topic" text NOT NULL,
	"refresh_years" integer,
	"tier" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "training_requirement_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "training_requirement_role_topic_key" UNIQUE("tenant_id","role_key","topic"),
	CONSTRAINT "training_requirement_topic" CHECK (topic IN ('care_certificate', 'safeguarding_adults', 'safeguarding_children', 'moving_and_handling', 'infection_prevention_and_control', 'fire_safety', 'health_and_safety', 'basic_life_support', 'food_hygiene', 'medicines', 'mental_capacity_and_dols', 'equality_diversity_and_human_rights', 'information_governance', 'dementia_awareness', 'fluids_and_nutrition', 'oliver_mcgowan')),
	CONSTRAINT "training_requirement_role_key" CHECK (role_key ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "training_requirement_refresh" CHECK (refresh_years IS NULL OR refresh_years BETWEEN 1 AND 10),
	CONSTRAINT "training_requirement_tier" CHECK ((tier IS NULL) = (topic <> 'oliver_mcgowan') AND (tier IS NULL OR tier IN (1, 2)))
);
--> statement-breakpoint
ALTER TABLE "competence_sign_off" ADD CONSTRAINT "competence_sign_off_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competence_sign_off" ADD CONSTRAINT "competence_sign_off_observer_fk" FOREIGN KEY ("tenant_id","observer_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competence_withdrawal" ADD CONSTRAINT "competence_withdrawal_sign_off_fk" FOREIGN KEY ("tenant_id","sign_off_id") REFERENCES "public"."competence_sign_off"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competence_withdrawal" ADD CONSTRAINT "competence_withdrawal_by_fk" FOREIGN KEY ("tenant_id","withdrawn_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revalidation_evidence" ADD CONSTRAINT "revalidation_evidence_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_record" ADD CONSTRAINT "supervision_record_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_record" ADD CONSTRAINT "supervision_record_held_by_fk" FOREIGN KEY ("tenant_id","held_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_record" ADD CONSTRAINT "training_record_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competence_sign_off_worker_idx" ON "competence_sign_off" USING btree ("tenant_id","worker_id","competence");--> statement-breakpoint
CREATE INDEX "supervision_record_worker_idx" ON "supervision_record" USING btree ("tenant_id","worker_id");--> statement-breakpoint
CREATE INDEX "training_record_worker_idx" ON "training_record" USING btree ("tenant_id","worker_id");
--> statement-breakpoint

-- Training, observed competence, supervision and revalidation (slice 17; workforce.md sections 2b,
-- 3 and 5; ADR-0085; hazards HZ-119 and HZ-124): the ADR-0002 patterns; read by holders of the
-- workforce read permissions organisation-wide and by the member for their own rows; written as
-- section 2b says, never by the member about themselves; sign-offs and withdrawals append-only and
-- in the signer's own name; and workforce reminder tasks visible to holders of their permission.
-- Runs as harbour_owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['training_requirement', 'training_record', 'competence_sign_off',
      'competence_withdrawal', 'supervision_record', 'revalidation_evidence'] LOOP
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

-- Whether the member reads members' development records: training, competence, supervision or the
-- staff file, organisation-wide as the staff file (app.holds_staff_permission, migration 0073).
CREATE OR REPLACE FUNCTION app.reads_development() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.holds_staff_permission('workforce.training.manage')
    OR app.holds_staff_permission('workforce.competence.observe')
    OR app.holds_staff_permission('workforce.supervision.manage')
    OR app.holds_staff_permission('workforce.staff_file.read')
$$;
--> statement-breakpoint
-- A member's own row, read with workforce.self.read.
CREATE OR REPLACE FUNCTION app.reads_own_development(p_worker_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_worker_id = app.current_user_id() AND app.holds_staff_permission('workforce.self.read')
$$;
--> statement-breakpoint
-- The member a sign-off is about, as the caller can see it (invoker rights); null when hidden.
CREATE OR REPLACE FUNCTION app.sign_off_worker(p_sign_off_id uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT s.worker_id FROM public.competence_sign_off s WHERE s.id = p_sign_off_id
$$;
--> statement-breakpoint

CREATE POLICY training_requirement_read ON public.training_requirement AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (app.is_system() OR app.reads_development()
    OR app.holds_staff_permission('workforce.self.read'));
--> statement-breakpoint
CREATE POLICY training_requirement_write ON public.training_requirement AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.is_system() OR app.holds_staff_permission('workforce.training.manage'));
--> statement-breakpoint
CREATE POLICY training_requirement_change ON public.training_requirement AS RESTRICTIVE FOR UPDATE
  TO harbour_app
  USING (app.is_system() OR app.holds_staff_permission('workforce.training.manage'))
  WITH CHECK (app.is_system() OR app.holds_staff_permission('workforce.training.manage'));
--> statement-breakpoint

-- Read rules for the member-keyed tables; write rules per table below.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['training_record', 'competence_sign_off', 'supervision_record',
      'revalidation_evidence'] LOOP
    EXECUTE format(
      'CREATE POLICY development_read ON public.%I AS RESTRICTIVE FOR SELECT TO harbour_app '
      'USING (app.is_system() OR app.reads_development() OR app.reads_own_development(worker_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE POLICY development_read ON public.competence_withdrawal AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (app.is_system() OR app.reads_development()
    OR app.reads_own_development(app.sign_off_worker(sign_off_id)));
--> statement-breakpoint

CREATE POLICY training_record_insert ON public.training_record AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.is_system() OR (app.holds_staff_permission('workforce.training.manage')
    AND worker_id <> app.current_user_id()));
--> statement-breakpoint
CREATE POLICY training_record_update ON public.training_record AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.is_system() OR (app.holds_staff_permission('workforce.training.manage')
    AND worker_id <> app.current_user_id()))
  WITH CHECK (app.is_system() OR (app.holds_staff_permission('workforce.training.manage')
    AND worker_id <> app.current_user_id()));
--> statement-breakpoint
CREATE POLICY revalidation_evidence_insert ON public.revalidation_evidence AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.is_system() OR (app.holds_staff_permission('workforce.training.manage')
    AND worker_id <> app.current_user_id()));
--> statement-breakpoint
CREATE POLICY revalidation_evidence_update ON public.revalidation_evidence AS RESTRICTIVE FOR UPDATE
  TO harbour_app
  USING (app.is_system() OR (app.holds_staff_permission('workforce.training.manage')
    AND worker_id <> app.current_user_id()))
  WITH CHECK (app.is_system() OR (app.holds_staff_permission('workforce.training.manage')
    AND worker_id <> app.current_user_id()));
--> statement-breakpoint
-- A supervision is recorded by the holder who held it, in their own name, never for themselves.
CREATE POLICY supervision_record_insert ON public.supervision_record AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.is_system() OR (app.holds_staff_permission('workforce.supervision.manage')
    AND worker_id <> app.current_user_id() AND held_by = app.current_user_id()));
--> statement-breakpoint
CREATE POLICY supervision_record_update ON public.supervision_record AS RESTRICTIVE FOR UPDATE
  TO harbour_app
  USING (app.is_system() OR (app.holds_staff_permission('workforce.supervision.manage')
    AND worker_id <> app.current_user_id()))
  WITH CHECK (app.is_system() OR (app.holds_staff_permission('workforce.supervision.manage')
    AND worker_id <> app.current_user_id()));
--> statement-breakpoint
-- HZ-119: a sign-off is observed in the observer's own name by a holder of the observe permission,
-- never for themselves, on a UK date no later than today.
CREATE POLICY competence_sign_off_insert ON public.competence_sign_off AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.is_system() OR (app.holds_staff_permission('workforce.competence.observe')
    AND observer_id = app.current_user_id() AND worker_id <> app.current_user_id()
    AND observed_on <= (now() AT TIME ZONE 'Europe/London')::date));
--> statement-breakpoint
CREATE POLICY competence_withdrawal_insert ON public.competence_withdrawal AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.is_system() OR ((app.holds_staff_permission('workforce.competence.observe')
      OR app.holds_staff_permission('workforce.training.manage'))
    AND withdrawn_by = app.current_user_id()
    AND app.sign_off_worker(sign_off_id) <> app.current_user_id()));
--> statement-breakpoint

-- Who and whom a record is about never change; a supervision keeps who held it.
CREATE OR REPLACE FUNCTION app.development_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN
    RAISE EXCEPTION 'A development record keeps its member of staff'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_TABLE_NAME = 'supervision_record' AND NEW.held_by IS DISTINCT FROM OLD.held_by THEN
    RAISE EXCEPTION 'A supervision keeps who held it'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['training_record', 'supervision_record', 'revalidation_evidence'] LOOP
    EXECUTE format('CREATE TRIGGER development_guard BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.development_guard()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['training_requirement', 'training_record', 'supervision_record',
      'revalidation_evidence'] LOOP
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['competence_sign_off', 'competence_withdrawal'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.training_requirement, public.training_record,
  public.supervision_record, public.revalidation_evidence TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.competence_sign_off, public.competence_withdrawal TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.competence_sign_off, public.competence_withdrawal
  FROM harbour_app;
--> statement-breakpoint

-- Task visibility (workforce.md section 11, closing slice 11's gap): a task about no person and no
-- location whose required permission is a workforce one is also visible to holders of that
-- permission, so HR's role (no person scope) sees the reminders raised for it. Otherwise as
-- app.task_visible (migration 0008).
CREATE OR REPLACE FUNCTION app.task_visible_with(p_person_id uuid, p_location_id uuid,
  p_assignee uuid, p_required_permission text)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.task_visible(p_person_id, p_location_id, p_assignee)
    OR (p_person_id IS NULL AND p_location_id IS NULL
        AND p_required_permission LIKE 'workforce.%'
        AND app.holds_staff_permission(p_required_permission))
$$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['task_series', 'task'] LOOP
    EXECUTE format('DROP POLICY task_scope ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY task_scope ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner '
      'USING (app.task_visible_with(person_id, location_id, assignee_tenant_user_id, required_permission)) '
      'WITH CHECK (app.task_visible_with(person_id, location_id, assignee_tenant_user_id, required_permission))', t);
  END LOOP;
END
$$;

