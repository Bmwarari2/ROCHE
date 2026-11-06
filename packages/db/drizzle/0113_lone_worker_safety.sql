CREATE TABLE "lone_worker_alarm" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"session_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"worker_tenant_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone,
	"raised_at" timestamp with time zone NOT NULL,
	"trigger_event_id" uuid,
	"last_alerted_at" timestamp with time zone NOT NULL,
	"alert_count" integer DEFAULT 1 NOT NULL,
	"escalation_step" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_event_id" uuid,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"outcome" text,
	"note" text,
	"incident_id" uuid,
	"retention_class" text DEFAULT 'lone_worker' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "lone_worker_alarm_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "lone_worker_alarm_reason" CHECK (reason IN ('overdue', 'not_finished', 'duress', 'help')),
	CONSTRAINT "lone_worker_alarm_state" CHECK (state IN ('open', 'acknowledged', 'resolved_by_check_in', 'resolved_late_check_in', 'resolved_by_finish')),
	CONSTRAINT "lone_worker_alarm_outcome" CHECK (outcome IS NULL OR outcome IN ('safe_confirmed', 'help_sent', 'emergency_services_called', 'other')),
	CONSTRAINT "lone_worker_alarm_trigger" CHECK ((reason IN ('duress', 'help')) = (trigger_event_id IS NOT NULL)
        AND (reason IN ('overdue', 'not_finished')) = (due_at IS NOT NULL)),
	CONSTRAINT "lone_worker_alarm_acknowledged" CHECK ((state = 'acknowledged') = (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL
        AND outcome IS NOT NULL AND note IS NOT NULL AND btrim(note) <> '')),
	CONSTRAINT "lone_worker_alarm_not_self" CHECK (acknowledged_by IS NULL OR acknowledged_by <> worker_tenant_user_id),
	CONSTRAINT "lone_worker_alarm_resolved" CHECK ((state IN ('resolved_by_check_in', 'resolved_late_check_in', 'resolved_by_finish'))
        = (resolved_at IS NOT NULL AND resolved_by_event_id IS NOT NULL)),
	CONSTRAINT "lone_worker_alarm_worker_raised" CHECK (reason NOT IN ('duress', 'help') OR state IN ('open', 'acknowledged')),
	CONSTRAINT "lone_worker_alarm_escalation_step" CHECK (escalation_step >= 1),
	CONSTRAINT "lone_worker_alarm_note_length" CHECK (note IS NULL OR char_length(note) <= 2000),
	CONSTRAINT "lone_worker_alarm_retention_class" CHECK (retention_class IN ('lone_worker'))
);--> statement-breakpoint
CREATE TABLE "lone_worker_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"device_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"late" boolean NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "lone_worker_event_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "lone_worker_event_kind" CHECK (kind IN ('check_in', 'duress', 'help', 'finish')),
	CONSTRAINT "lone_worker_event_effective" CHECK (effective_at <= received_at)
);--> statement-breakpoint
CREATE TABLE "lone_worker_location" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"event_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"latitude" numeric(8, 5),
	"longitude" numeric(8, 5),
	"accuracy_metres" integer,
	"delete_after" timestamp with time zone NOT NULL,
	"cleared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lone_worker_location_event_key" UNIQUE("tenant_id","event_id"),
	CONSTRAINT "lone_worker_location_latitude" CHECK (latitude BETWEEN -90 AND 90),
	CONSTRAINT "lone_worker_location_longitude" CHECK (longitude BETWEEN -180 AND 180),
	CONSTRAINT "lone_worker_location_accuracy" CHECK (accuracy_metres IS NULL OR accuracy_metres BETWEEN 0 AND 100000),
	CONSTRAINT "lone_worker_location_cleared" CHECK ((cleared_at IS NULL) = (latitude IS NOT NULL AND longitude IS NOT NULL)
        AND (cleared_at IS NULL OR accuracy_metres IS NULL))
);--> statement-breakpoint
CREATE TABLE "lone_worker_session" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"worker_tenant_user_id" uuid DEFAULT app.current_user_id() NOT NULL,
	"work_kind" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"planned_end_at" timestamp with time zone NOT NULL,
	"interval_minutes" integer NOT NULL,
	"finished_at" timestamp with time zone,
	"reminder_sent_for" timestamp with time zone,
	"retention_class" text DEFAULT 'lone_worker' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "lone_worker_session_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "lone_worker_session_work_kind" CHECK (work_kind IN ('domiciliary_visit', 'night_shift', 'other')),
	CONSTRAINT "lone_worker_session_end" CHECK (planned_end_at > started_at),
	CONSTRAINT "lone_worker_session_interval" CHECK (interval_minutes > 0),
	CONSTRAINT "lone_worker_session_retention_class" CHECK (retention_class IN ('lone_worker'))
);--> statement-breakpoint
ALTER TABLE "lone_worker_alarm" ADD CONSTRAINT "lone_worker_alarm_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."lone_worker_session"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lone_worker_alarm" ADD CONSTRAINT "lone_worker_alarm_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lone_worker_alarm" ADD CONSTRAINT "lone_worker_alarm_worker_fk" FOREIGN KEY ("tenant_id","worker_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lone_worker_alarm" ADD CONSTRAINT "lone_worker_alarm_acknowledged_by_fk" FOREIGN KEY ("tenant_id","acknowledged_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lone_worker_alarm" ADD CONSTRAINT "lone_worker_alarm_trigger_event_fk" FOREIGN KEY ("tenant_id","trigger_event_id") REFERENCES "public"."lone_worker_event"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lone_worker_alarm" ADD CONSTRAINT "lone_worker_alarm_resolved_event_fk" FOREIGN KEY ("tenant_id","resolved_by_event_id") REFERENCES "public"."lone_worker_event"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lone_worker_alarm" ADD CONSTRAINT "lone_worker_alarm_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incident"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lone_worker_event" ADD CONSTRAINT "lone_worker_event_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."lone_worker_session"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lone_worker_location" ADD CONSTRAINT "lone_worker_location_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."lone_worker_event"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lone_worker_location" ADD CONSTRAINT "lone_worker_location_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."lone_worker_session"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lone_worker_session" ADD CONSTRAINT "lone_worker_session_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lone_worker_session" ADD CONSTRAINT "lone_worker_session_worker_fk" FOREIGN KEY ("tenant_id","worker_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lone_worker_alarm_overdue_due_key" ON "lone_worker_alarm" USING btree ("tenant_id","session_id","due_at") WHERE reason IN ('overdue', 'not_finished');--> statement-breakpoint
CREATE UNIQUE INDEX "lone_worker_alarm_open_worker_raised_key" ON "lone_worker_alarm" USING btree ("tenant_id","session_id","reason") WHERE state = 'open' AND reason IN ('duress', 'help');--> statement-breakpoint
CREATE UNIQUE INDEX "lone_worker_alarm_trigger_event_key" ON "lone_worker_alarm" USING btree ("tenant_id","trigger_event_id") WHERE trigger_event_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "lone_worker_alarm_open_idx" ON "lone_worker_alarm" USING btree ("tenant_id","state","last_alerted_at");--> statement-breakpoint
CREATE INDEX "lone_worker_event_session_idx" ON "lone_worker_event" USING btree ("tenant_id","session_id","effective_at");--> statement-breakpoint
CREATE INDEX "lone_worker_location_expiry_idx" ON "lone_worker_location" USING btree ("delete_after") WHERE cleared_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "lone_worker_session_open_key" ON "lone_worker_session" USING btree ("tenant_id","worker_tenant_user_id") WHERE finished_at IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "lone_worker_session_open_idx" ON "lone_worker_session" USING btree ("tenant_id","location_id") WHERE finished_at IS NULL;
--> statement-breakpoint

-- Security (ADR-0002, one self-contained file as since migration 0054). Runs as harbour_owner.
-- Lone-worker safety (SCHED-012, scheduling.md section 14, HZ-125): a worker reads and writes
-- their own sessions; holders of scheduling.lone_worker.monitor read the sessions at the
-- locations where they hold it and acknowledge alarms there; the worker sweep (no user, tenant
-- scope: app.is_system()) raises alarms and deletes expired location evidence. Nothing else
-- widens access: the helper runs with the caller's rights.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lone_worker_session', 'lone_worker_event', 'lone_worker_alarm',
                           'lone_worker_location'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Whether the caller may watch lone workers at a location (invoker rights).
CREATE OR REPLACE FUNCTION app.lone_worker_monitor_at(p_location_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.holds_permission_at('scheduling.lone_worker.monitor', p_location_id)
    OR app.holds_permission_at('scheduling.lone_worker.monitor', NULL)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lone_worker_monitor_at(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lone_worker_monitor_at(uuid) TO harbour_app;--> statement-breakpoint

-- The worker of a session, as the caller can see it (invoker rights: the session's own
-- policies); null when the caller cannot see the session.
CREATE OR REPLACE FUNCTION app.lone_worker_session_worker(p_session_id uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT s.worker_tenant_user_id FROM public.lone_worker_session s WHERE s.id = p_session_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lone_worker_session_worker(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lone_worker_session_worker(uuid) TO harbour_app;--> statement-breakpoint

-- Whether the caller holds scheduling.lone_worker.check_in at a location, by any role scope
-- (care workers' roles are scoped to assigned people, which holds_permission_at does not count)
-- or a grant there; the database's own check of where a worker may start (security review L2).
-- Invoker rights: the caller's own role assignments and grants.
CREATE OR REPLACE FUNCTION app.lone_worker_works_at(p_location_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.current_user_id() IS NOT NULL AND (
    EXISTS (
      SELECT 1
      FROM public.role_assignment ra
      JOIN public.role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
      WHERE ra.tenant_id = app.current_tenant_id()
        AND ra.tenant_user_id = app.current_user_id()
        AND ra.deleted_at IS NULL AND r.archived_at IS NULL
        AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
        AND 'scheduling.lone_worker.check_in' = ANY (r.permissions)
        AND (ra.location_id = p_location_id
          OR (ra.location_id IS NULL AND (r.scope_kind = 'tenant' OR ra.organisation_wide))))
    OR EXISTS (
      SELECT 1
      FROM public.access_grant g
      WHERE g.tenant_id = app.current_tenant_id()
        AND g.tenant_user_id = app.current_user_id()
        AND g.deleted_at IS NULL AND g.revoked_at IS NULL
        AND g.valid_from <= now() AND g.valid_to > now()
        AND 'scheduling.lone_worker.check_in' = ANY (g.permissions)
        AND (g.location_id = p_location_id OR (g.location_id IS NULL AND g.organisation_wide))))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lone_worker_works_at(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lone_worker_works_at(uuid) TO harbour_app;--> statement-breakpoint

-- Sessions: the worker's own, or a monitor's where they hold the permission. Only the worker
-- starts their own session; the worker finishes it, the sweep records reminders.
CREATE POLICY lone_worker_session_read ON public.lone_worker_session AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.is_system() OR worker_tenant_user_id = app.current_user_id()
    OR app.lone_worker_monitor_at(location_id));--> statement-breakpoint
CREATE POLICY lone_worker_session_insert ON public.lone_worker_session AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (worker_tenant_user_id = app.current_user_id()
    AND app.lone_worker_works_at(location_id));--> statement-breakpoint
CREATE POLICY lone_worker_session_update ON public.lone_worker_session AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (app.is_system() OR worker_tenant_user_id = app.current_user_id())
  WITH CHECK (app.is_system() OR worker_tenant_user_id = app.current_user_id());--> statement-breakpoint

-- The session's worker, location and times are fixed once started; a finished session stays
-- finished (a later check-in needs a new session).
CREATE OR REPLACE FUNCTION app.lone_worker_session_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.worker_tenant_user_id <> OLD.worker_tenant_user_id OR NEW.location_id <> OLD.location_id
     OR NEW.started_at <> OLD.started_at OR NEW.planned_end_at <> OLD.planned_end_at
     OR NEW.interval_minutes <> OLD.interval_minutes OR NEW.work_kind <> OLD.work_kind THEN
    RAISE EXCEPTION 'a lone-working session''s worker, place and times are fixed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at THEN
    RAISE EXCEPTION 'a finished lone-working session stays finished'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- The worker may only finish; nobody but the system removes a session or touches its
  -- reminders, so no session's alarms can be silenced from the application (security review L1).
  IF NOT app.is_system() AND (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     OR NEW.reminder_sent_for IS DISTINCT FROM OLD.reminder_sent_for) THEN
    RAISE EXCEPTION 'only the system changes a lone-working session''s reminders or removes it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER lone_worker_session_guard BEFORE UPDATE ON public.lone_worker_session
  FOR EACH ROW EXECUTE FUNCTION app.lone_worker_session_guard();--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.lone_worker_session
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();--> statement-breakpoint

-- Events: append-only, read with the session, written only by the session's worker (a monitor
-- never checks in on a worker's behalf).
CREATE POLICY lone_worker_event_read ON public.lone_worker_event AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.is_system() OR app.lone_worker_session_worker(session_id) IS NOT NULL);--> statement-breakpoint
CREATE POLICY lone_worker_event_insert ON public.lone_worker_event AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.current_user_id() IS NOT NULL
    AND app.lone_worker_session_worker(session_id) = app.current_user_id()
    AND created_by = app.current_user_id());--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.lone_worker_event
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.lone_worker_event
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();--> statement-breakpoint

-- Alarms: read by the worker and by monitors at the location. Raised and resolved only by the
-- system (the API's system transaction straight after the worker's event, and the per-minute
-- sweep that repairs anything missed), never by the worker, so a worker can neither cancel an
-- alarm nor raise one in someone else's name. Acknowledged by a monitor at the location who is
-- not the worker (a check constraint also refuses the worker).
-- The worker never reads a duress alarm about themself: whoever is standing over them could see
-- it (scheduling.md section 14.3).
CREATE POLICY lone_worker_alarm_read ON public.lone_worker_alarm AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.is_system()
    OR (worker_tenant_user_id = app.current_user_id() AND reason <> 'duress')
    OR (app.lone_worker_monitor_at(location_id) AND worker_tenant_user_id <> app.current_user_id()));--> statement-breakpoint
CREATE POLICY lone_worker_alarm_insert ON public.lone_worker_alarm AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.is_system());--> statement-breakpoint
CREATE POLICY lone_worker_alarm_update ON public.lone_worker_alarm AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (app.is_system()
    OR (state = 'open' AND app.lone_worker_monitor_at(location_id)
        AND worker_tenant_user_id <> app.current_user_id()))
  WITH CHECK (app.is_system()
    OR (state = 'acknowledged' AND acknowledged_by = app.current_user_id()
        AND app.lone_worker_monitor_at(location_id)));--> statement-breakpoint

-- What raised an alarm and whose it is never change; a closed alarm stays closed.
CREATE OR REPLACE FUNCTION app.lone_worker_alarm_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.session_id <> OLD.session_id OR NEW.location_id <> OLD.location_id
     OR NEW.worker_tenant_user_id <> OLD.worker_tenant_user_id OR NEW.reason <> OLD.reason
     OR NEW.raised_at <> OLD.raised_at OR NEW.due_at IS DISTINCT FROM OLD.due_at
     OR NEW.trigger_event_id IS DISTINCT FROM OLD.trigger_event_id THEN
    RAISE EXCEPTION 'what raised a lone-worker alarm is fixed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state <> 'open' AND (NEW.state <> OLD.state OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.outcome IS DISTINCT FROM OLD.outcome) THEN
    RAISE EXCEPTION 'a closed lone-worker alarm stays closed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER lone_worker_alarm_guard BEFORE UPDATE ON public.lone_worker_alarm
  FOR EACH ROW EXECUTE FUNCTION app.lone_worker_alarm_guard();--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.lone_worker_alarm
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();--> statement-breakpoint

-- Location evidence (H-527): read with the session; written by the worker with their own
-- event; erased only by the sweep at delete_after (coordinates cleared, the row kept as proof of
-- the erasure). Nothing else changes it, and the application never deletes it.
CREATE POLICY lone_worker_location_read ON public.lone_worker_location AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.is_system() OR app.lone_worker_session_worker(session_id) IS NOT NULL);--> statement-breakpoint
CREATE POLICY lone_worker_location_insert ON public.lone_worker_location AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (app.current_user_id() IS NOT NULL AND cleared_at IS NULL
    AND app.lone_worker_session_worker(session_id) = app.current_user_id());--> statement-breakpoint
CREATE POLICY lone_worker_location_update ON public.lone_worker_location AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (app.is_system()) WITH CHECK (app.is_system());--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lone_worker_location_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.cleared_at IS NOT NULL OR NEW.cleared_at IS NULL OR NEW.latitude IS NOT NULL
     OR NEW.longitude IS NOT NULL OR NEW.accuracy_metres IS NOT NULL
     OR NEW.event_id <> OLD.event_id OR NEW.session_id <> OLD.session_id
     OR NEW.delete_after <> OLD.delete_after OR NEW.cleared_at > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'lone-worker location evidence is only ever erased'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.delete_after > now() THEN
    RAISE EXCEPTION 'lone-worker location evidence is erased at its date, not before'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER lone_worker_location_guard BEFORE UPDATE ON public.lone_worker_location
  FOR EACH ROW EXECUTE FUNCTION app.lone_worker_location_guard();--> statement-breakpoint

-- Version history without the personal data (as complaints, migration 0080): record_version is
-- read by every member, so only these columns are copied and the rest read '[redacted]'.
CREATE TRIGGER capture_version AFTER UPDATE ON public.lone_worker_session
  FOR EACH ROW EXECUTE FUNCTION app.capture_version_redacted('id', 'tenant_id', 'location_id',
    'started_at', 'planned_end_at', 'finished_at', 'retention_class', 'created_at', 'updated_at',
    'version', 'deleted_at');--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.lone_worker_alarm
  FOR EACH ROW EXECUTE FUNCTION app.capture_version_redacted('id', 'tenant_id', 'session_id',
    'location_id', 'state', 'raised_at', 'resolved_at', 'acknowledged_at', 'retention_class',
    'created_at', 'updated_at', 'version', 'deleted_at');--> statement-breakpoint

-- The on-call route is written only by holders of scheduling.lone_worker.manage (or the system):
-- the database's own check beside the API's (security review L3). Other chains are untouched.
CREATE POLICY lone_worker_route_insert ON public.escalation_chain AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (key <> 'scheduling.lone_worker.alarm' OR app.is_system()
    OR app.holds_permission_anywhere('scheduling.lone_worker.manage'));--> statement-breakpoint
CREATE POLICY lone_worker_route_update ON public.escalation_chain AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (key <> 'scheduling.lone_worker.alarm' OR app.is_system()
    OR app.holds_permission_anywhere('scheduling.lone_worker.manage'))
  WITH CHECK (key <> 'scheduling.lone_worker.alarm' OR app.is_system()
    OR app.holds_permission_anywhere('scheduling.lone_worker.manage'));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.lone_worker_session, public.lone_worker_alarm TO harbour_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.lone_worker_session, public.lone_worker_alarm FROM harbour_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.lone_worker_event TO harbour_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.lone_worker_event FROM harbour_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.lone_worker_location TO harbour_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.lone_worker_location FROM harbour_app;
-- Lone-worker records stay on the server for now: the mobile slice (71) decides what devices get.
--> statement-breakpoint
-- BEGIN role backfill 0113
-- Data migration: existing tenants' copies of the built-in roles gain the lone-worker permissions
-- the built-in definitions (packages/domain/src/platform/roles.ts) added with lone-worker safety:
-- check-in for staff who may work alone, monitor for those who watch check-ins, manage for the
-- managers. A tenant created before this migration would otherwise never hold them. Each change is
-- made in that tenant's context and audited in the same transaction
-- (platform.role.permissions_migrated, naming what the copy gained), as migration 0038 does.
-- Idempotent. packages/db/test/lone-worker.test.ts re-runs this section and checks the list
-- against the domain.
ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM public.role WHERE is_builtin ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM set_config('app.scope', 'tenant', true);
    WITH grants(key, add) AS (VALUES
        ('owner', ARRAY['scheduling.lone_worker.check_in', 'scheduling.lone_worker.monitor', 'scheduling.lone_worker.manage']),
        ('registered_manager', ARRAY['scheduling.lone_worker.check_in', 'scheduling.lone_worker.monitor', 'scheduling.lone_worker.manage']),
        ('deputy_manager', ARRAY['scheduling.lone_worker.check_in', 'scheduling.lone_worker.monitor', 'scheduling.lone_worker.manage']),
        ('clinical_lead', ARRAY['scheduling.lone_worker.check_in']),
        ('team_leader', ARRAY['scheduling.lone_worker.check_in', 'scheduling.lone_worker.monitor']),
        ('care_worker', ARRAY['scheduling.lone_worker.check_in']),
        ('care_coordinator', ARRAY['scheduling.lone_worker.monitor']),
        ('activities', ARRAY['scheduling.lone_worker.check_in']),
        ('catering', ARRAY['scheduling.lone_worker.check_in']),
        ('housekeeping', ARRAY['scheduling.lone_worker.check_in']),
        ('maintenance', ARRAY['scheduling.lone_worker.check_in']),
        ('agency_worker', ARRAY['scheduling.lone_worker.check_in'])
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
        jsonb_build_object('migration', '0113_lone_worker_safety', 'roleKey', x.key,
          'added', to_jsonb(x.missing)),
        'Existing tenants'' built-in role copies gained the lone-worker permissions their built-in definitions added (migration 0113)'
      FROM targets x JOIN changed c ON c.id = x.id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.scope', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE public.role FORCE ROW LEVEL SECURITY;
-- END role backfill 0113
