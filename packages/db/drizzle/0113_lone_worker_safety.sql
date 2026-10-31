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
	CONSTRAINT "lone_worker_alarm_state" CHECK (state IN ('open', 'acknowledged', 'resolved_by_check_in', 'resolved_late_check_in')),
	CONSTRAINT "lone_worker_alarm_outcome" CHECK (outcome IS NULL OR outcome IN ('safe_confirmed', 'help_sent', 'emergency_services_called', 'other')),
	CONSTRAINT "lone_worker_alarm_trigger" CHECK ((reason IN ('duress', 'help')) = (trigger_event_id IS NOT NULL)
        AND (reason IN ('overdue', 'not_finished')) = (due_at IS NOT NULL)),
	CONSTRAINT "lone_worker_alarm_acknowledged" CHECK ((state = 'acknowledged') = (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL
        AND outcome IS NOT NULL AND note IS NOT NULL AND btrim(note) <> '')),
	CONSTRAINT "lone_worker_alarm_not_self" CHECK (acknowledged_by IS NULL OR acknowledged_by <> worker_tenant_user_id),
	CONSTRAINT "lone_worker_alarm_resolved" CHECK ((state IN ('resolved_by_check_in', 'resolved_late_check_in'))
        = (resolved_at IS NOT NULL AND resolved_by_event_id IS NOT NULL)),
	CONSTRAINT "lone_worker_alarm_worker_raised" CHECK (reason NOT IN ('duress', 'help') OR state IN ('open', 'acknowledged')),
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
	CONSTRAINT "lone_worker_event_kind" CHECK (kind IN ('check_in', 'duress', 'help', 'finish'))
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
CREATE UNIQUE INDEX "lone_worker_alarm_open_overdue_key" ON "lone_worker_alarm" USING btree ("tenant_id","session_id") WHERE state = 'open' AND reason IN ('overdue', 'not_finished');--> statement-breakpoint
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

-- Sessions: the worker's own, or a monitor's where they hold the permission. Only the worker
-- starts their own session; the worker finishes it, the sweep records reminders.
CREATE POLICY lone_worker_session_read ON public.lone_worker_session AS RESTRICTIVE FOR SELECT
  TO harbour_app, harbour_owner
  USING (app.is_system() OR worker_tenant_user_id = app.current_user_id()
    OR app.lone_worker_monitor_at(location_id));--> statement-breakpoint
CREATE POLICY lone_worker_session_insert ON public.lone_worker_session AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (worker_tenant_user_id = app.current_user_id());--> statement-breakpoint
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

GRANT SELECT, INSERT, UPDATE ON public.lone_worker_session, public.lone_worker_alarm TO harbour_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.lone_worker_session, public.lone_worker_alarm FROM harbour_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.lone_worker_event TO harbour_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.lone_worker_event FROM harbour_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.lone_worker_location TO harbour_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.lone_worker_location FROM harbour_app;
-- Lone-worker records stay on the server for now: the mobile slice (71) decides what devices get.
