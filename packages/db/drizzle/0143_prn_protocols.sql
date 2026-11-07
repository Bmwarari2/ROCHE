CREATE TABLE "medicine_list_item" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"list" text NOT NULL,
	"vmp_id" text NOT NULL,
	"product_name" text NOT NULL,
	"reason" text,
	"removed_at" timestamp with time zone,
	"removed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "medicine_list_item_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medicine_list_item_list" CHECK (list IN ('time_critical', 'paracetamol', 'bisphosphonate', 'psychotropic')),
	CONSTRAINT "medicine_list_item_vmp" CHECK (vmp_id ~ '^[0-9]{6,18}$'),
	CONSTRAINT "medicine_list_item_removed" CHECK ((removed_at IS NULL) = (removed_reason IS NULL))
);
--> statement-breakpoint
CREATE TABLE "prn_outcome" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"administration_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"note" text,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_id" uuid,
	"correction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "prn_outcome_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "prn_outcome_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "prn_outcome_outcome" CHECK (outcome IN ('effective', 'partly_effective', 'not_effective', 'person_asleep', 'could_not_assess')),
	CONSTRAINT "prn_outcome_correction" CHECK ((supersedes_id IS NULL AND correction_reason IS NULL)
       OR (supersedes_id IS NOT NULL AND supersedes_id <> id
           AND length(btrim(coalesce(correction_reason, ''))) > 0))
);
--> statement-breakpoint
CREATE TABLE "prn_protocol" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"medication_id" uuid NOT NULL,
	"medicine_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"triggers" text[] NOT NULL,
	"non_drug_alternatives" text[] NOT NULL,
	"purpose_group" text,
	"order_of_use" integer,
	"expected_effect" text NOT NULL,
	"agreed_with_name" text NOT NULL,
	"agreed_with_role" text NOT NULL,
	"agreed_on" date NOT NULL,
	"review_on" date NOT NULL,
	"withdrawn_on" date,
	"withdrawn_reason" text,
	"change_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "prn_protocol_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "prn_protocol_words" CHECK (length(btrim(purpose)) > 0 AND length(btrim(expected_effect)) > 0
        AND cardinality(triggers) > 0),
	CONSTRAINT "prn_protocol_role" CHECK (agreed_with_role IN ('prescriber', 'pharmacist')),
	CONSTRAINT "prn_protocol_order" CHECK (order_of_use IS NULL OR (order_of_use >= 1 AND length(btrim(coalesce(purpose_group, ''))) > 0)),
	CONSTRAINT "prn_protocol_review" CHECK (review_on > agreed_on),
	CONSTRAINT "prn_protocol_withdrawn" CHECK ((withdrawn_on IS NULL) = (withdrawn_reason IS NULL))
);
--> statement-breakpoint
ALTER TABLE "prn_outcome" ADD CONSTRAINT "prn_outcome_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prn_outcome" ADD CONSTRAINT "prn_outcome_administration_fk" FOREIGN KEY ("tenant_id","person_id","administration_id") REFERENCES "public"."medication_administration"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prn_outcome" ADD CONSTRAINT "prn_outcome_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prn_outcome" ADD CONSTRAINT "prn_outcome_supersedes_fk" FOREIGN KEY ("tenant_id","person_id","supersedes_id") REFERENCES "public"."prn_outcome"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prn_protocol" ADD CONSTRAINT "prn_protocol_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prn_protocol" ADD CONSTRAINT "prn_protocol_medication_fk" FOREIGN KEY ("tenant_id","person_id","medication_id") REFERENCES "public"."medication"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "medicine_list_item_open_key" ON "medicine_list_item" USING btree ("tenant_id","list","vmp_id") WHERE removed_at IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "prn_outcome_dose_key" ON "prn_outcome" USING btree ("tenant_id","administration_id") WHERE supersedes_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "prn_outcome_supersedes_key" ON "prn_outcome" USING btree ("tenant_id","supersedes_id") WHERE supersedes_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "prn_outcome_person_idx" ON "prn_outcome" USING btree ("tenant_id","person_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prn_protocol_open_key" ON "prn_protocol" USING btree ("tenant_id","medicine_id") WHERE withdrawn_on IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "prn_protocol_order_key" ON "prn_protocol" USING btree ("tenant_id","person_id","purpose_group","order_of_use") WHERE withdrawn_on IS NULL AND deleted_at IS NULL AND order_of_use IS NOT NULL;--> statement-breakpoint
CREATE INDEX "prn_protocol_person_idx" ON "prn_protocol" USING btree ("tenant_id","person_id");
--> statement-breakpoint
-- PRN protocols, outcomes and medicine lists security (ADR-0002 patterns; medicines.md section 16;
-- slice 28). Runs as harbour_owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['medicine_list_item', 'prn_protocol', 'prn_outcome'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['prn_protocol', 'prn_outcome'] LOOP
    EXECUTE format(
      'CREATE POLICY person_child_scope ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner '
      'USING (app.person_visible(person_id)) WITH CHECK (app.person_visible(person_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- Who may write about a person: the permission at the person's home, or through an assigned role
-- (care workers), whose people the person scope policy already limits. The same function, word
-- for word, as slice 38's migration defines; whichever runs last leaves it unchanged.
CREATE OR REPLACE FUNCTION app.may_record_for_person(p_permission text, p_person_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.current_user_id() IS NOT NULL AND (
    app.holds_permission_at(p_permission,
      (SELECT p.location_id FROM public.person p
        WHERE p.tenant_id = app.current_tenant_id() AND p.id = p_person_id))
    OR EXISTS (
      SELECT 1
      FROM public.role_assignment ra
      JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
      WHERE ra.tenant_id = app.current_tenant_id()
        AND ra.tenant_user_id = app.current_user_id()
        AND ra.deleted_at IS NULL
        AND r.archived_at IS NULL
        AND ra.valid_from <= now()
        AND (ra.valid_to IS NULL OR ra.valid_to > now())
        AND r.scope_kind::text = 'assigned'
        AND NOT (r.permissions && ARRAY['comms.portal.family', 'comms.portal.self', 'comms.feed.read',
          'comms.notification.subscribe', 'comms.visit_booking.request']::text[])
        AND p_permission = ANY (r.permissions)))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.may_record_for_person(text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.may_record_for_person(text, uuid) TO harbour_app;
--> statement-breakpoint
-- The organisation's lists: read by every member (the psychotropic count needs them), written by a
-- holder of medicines.list.manage.
CREATE POLICY medicine_list_item_write ON public.medicine_list_item AS RESTRICTIVE
  FOR INSERT TO harbour_app
  WITH CHECK (app.holds_permission_anywhere('medicines.list.manage'));
--> statement-breakpoint
CREATE POLICY medicine_list_item_change ON public.medicine_list_item AS RESTRICTIVE
  FOR UPDATE TO harbour_app
  USING (app.holds_permission_anywhere('medicines.list.manage'))
  WITH CHECK (app.holds_permission_anywhere('medicines.list.manage'));
--> statement-breakpoint
CREATE POLICY prn_protocol_write ON public.prn_protocol AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.may_record_for_person('medicines.record.manage', person_id));
--> statement-breakpoint
CREATE POLICY prn_protocol_change ON public.prn_protocol AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.may_record_for_person('medicines.record.manage', person_id))
  WITH CHECK (app.may_record_for_person('medicines.record.manage', person_id));
--> statement-breakpoint
CREATE POLICY prn_outcome_write ON public.prn_outcome AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.may_record_for_person('medicines.emar.administer', person_id)
    OR app.may_record_for_person('medicines.record.manage', person_id));
--> statement-breakpoint

-- A list item's list and product never change; removal is set once and closes it.
CREATE OR REPLACE FUNCTION app.medicine_list_item_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.list, NEW.vmp_id, NEW.product_name) IS DISTINCT FROM (OLD.list, OLD.vmp_id, OLD.product_name) THEN
    RAISE EXCEPTION 'medicine_list_item: the list and product never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.removed_at IS NOT NULL OR OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'medicine_list_item_closed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medicine_list_item_guard BEFORE UPDATE ON public.medicine_list_item
  FOR EACH ROW EXECUTE FUNCTION app.medicine_list_item_guard();
--> statement-breakpoint

-- A protocol is for one of the person's current when-required entries; its medicine never changes;
-- every change has a new reason; a withdrawn protocol is closed (HZ-117).
CREATE OR REPLACE FUNCTION app.prn_protocol_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE e public.medication;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO e FROM public.medication m
     WHERE m.tenant_id = NEW.tenant_id AND m.person_id = NEW.person_id AND m.id = NEW.medication_id;
    IF NOT FOUND OR e.directions <> 'when_required'
       OR e.state NOT IN ('not_yet_checked', 'checked', 'difference_found') THEN
      RAISE EXCEPTION 'prn_protocol_needs_current_when_required_entry'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.medicine_id := e.medicine_id;
    IF NEW.change_reason IS NOT NULL OR NEW.withdrawn_on IS NOT NULL THEN
      RAISE EXCEPTION 'prn_protocol: a new protocol is in use' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.person_id, NEW.medication_id, NEW.medicine_id)
     IS DISTINCT FROM (OLD.person_id, OLD.medication_id, OLD.medicine_id) THEN
    RAISE EXCEPTION 'prn_protocol: the person and medicine never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.withdrawn_on IS NOT NULL OR OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'prn_protocol_closed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.change_reason IS NULL OR length(btrim(NEW.change_reason)) = 0
     OR NEW.change_reason IS NOT DISTINCT FROM OLD.change_reason THEN
    RAISE EXCEPTION 'prn_protocol_change_needs_reason' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER prn_protocol_guard BEFORE INSERT OR UPDATE ON public.prn_protocol
  FOR EACH ROW EXECUTE FUNCTION app.prn_protocol_guard();
--> statement-breakpoint

-- An outcome is recorded by the member recording it, at the server's time, for a when-required
-- dose that was given or taken, seen after the dose and not in the future; a correction stays with
-- its dose (HZ-117).
CREATE OR REPLACE FUNCTION app.prn_outcome_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE d public.medication_administration;
DECLARE original public.prn_outcome;
BEGIN
  NEW.recorded_at := now();
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'prn_outcome_not_the_recorder' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO d FROM public.medication_administration a
   WHERE a.tenant_id = NEW.tenant_id AND a.person_id = NEW.person_id AND a.id = NEW.administration_id;
  IF NOT FOUND OR d.due_at IS NOT NULL
     OR d.outcome NOT IN ('given', 'self_administered', 'given_by_family')
     OR NEW.observed_at < d.given_at OR NEW.observed_at > now() THEN
    RAISE EXCEPTION 'prn_outcome_not_for_this_dose' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO original FROM public.prn_outcome o
     WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.supersedes_id;
    IF NOT FOUND OR original.administration_id <> NEW.administration_id THEN
      RAISE EXCEPTION 'prn_outcome: a correction stays with its dose'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER prn_outcome_insert BEFORE INSERT ON public.prn_outcome
  FOR EACH ROW EXECUTE FUNCTION app.prn_outcome_insert();
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['medicine_list_item', 'prn_protocol'] LOOP
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.prn_outcome
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.prn_outcome
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.medicine_list_item, public.prn_protocol TO harbour_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.prn_outcome TO harbour_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.medicine_list_item, public.prn_protocol FROM harbour_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.prn_outcome FROM harbour_app;
--> statement-breakpoint
-- Not published to devices yet: PRN protocols reach devices in slice 68.
--> statement-breakpoint
-- Sample data mode (migration 0069, HZ-072): a sample person's PRN outcomes and protocols go with
-- them, before the administrations and entries they reference. Every table migration 0123 listed
-- is kept.
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
    'prn_outcome', 'prn_protocol',
    'medication_administration_witness', 'medication_administration', 'medication_dosing_record',
    'medication_reconciliation_decision', 'medication_reconciliation_item',
    'medication_reconciliation_source', 'medication_schedule', 'medication',
    'medication_reconciliation',
    'dependency_assessment',
    'about_me', 'about_me_share_link', 'activity_record', 'admission_condition',
    'advance_care_record', 'allergy', 'assessment', 'bed_occupancy', 'body_map_mark',
    'break_glass_event', 'candour_record', 'care_note', 'care_plan_action', 'care_plan_change',
    'consent_record', 'document_signature', 'dols_legal_change_review',
    'entry_device_deletion_flag', 'exit_checklist_item', 'family_portal_user',
    'feed_item_withdrawal', 'feed_view', 'handover_note', 'incident_person', 'key_issue',
    'legal_hold', 'letter', 'notification_delivery', 'observation', 'person_assignment',
    'person_care_profile', 'property_item', 'refused_entry', 'sharing_decision_suspension',
    'safeguarding_concern', 'statutory_notification', 'visit_log', 'welcome_checklist_item', 'workflow_transition',
    'care_plan_section', 'dols_authorisation', 'exit_record', 'feed_item', 'handover_item',
    'hospital_transfer', 'notification', 'placement', 'review_record', 'risk_assessment',
    'sharing_decision', 'task', 'admission_decision', 'best_interests_decision', 'care_plan',
    'document', 'task_series', 'workflow_instance', 'capacity_assessment', 'contact',
    'pre_admission_assessment'
  ]::text[]
$$;--> statement-breakpoint
GRANT SELECT, DELETE ON public.prn_outcome, public.prn_protocol TO harbour_sample_owner;

--> statement-breakpoint
-- Data migration: existing tenants' copies of the built-in roles gain medicines.list.manage, as the
-- built-in definitions (packages/domain/src/platform/roles.ts) now give it: the owner, the
-- Registered Manager and the deputy. Each change is audited in the same transaction
-- (platform.role.permissions_migrated), as migration 0074 does. Idempotent.
ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.role WHERE is_builtin ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    WITH grants(key, add) AS (VALUES
        ('owner', ARRAY['medicines.list.manage']),
        ('registered_manager', ARRAY['medicines.list.manage']),
        ('deputy_manager', ARRAY['medicines.list.manage'])
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
        jsonb_build_object('migration', '0143_prn_protocols', 'roleKey', x.key,
          'added', to_jsonb(x.missing)),
        'Existing tenants'' built-in role copies gained the medicine lists permission their built-in definitions added (migration 0143)'
      FROM targets x JOIN changed c ON c.id = x.id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.role FORCE ROW LEVEL SECURITY;
