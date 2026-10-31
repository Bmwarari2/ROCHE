CREATE TABLE "agency" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"name" text NOT NULL,
	"contact_email" text,
	"framework_ref" text,
	"default_charge_pence_per_hour" integer,
	"archive_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agency_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "agency_name" CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
	CONSTRAINT "agency_charge" CHECK (default_charge_pence_per_hour IS NULL OR default_charge_pence_per_hour BETWEEN 1 AND 1000000),
	CONSTRAINT "agency_archived" CHECK ((deleted_at IS NULL) = (archive_reason IS NULL) AND (archive_reason IS NULL OR btrim(archive_reason) <> ''))
);
--> statement-breakpoint
CREATE TABLE "agency_booking" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"shift_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"agency_id" uuid,
	"kind" text NOT NULL,
	"booking_ref" text,
	"charge_pence_per_hour" integer NOT NULL,
	"cost_pence" integer NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"cancel_reason" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agency_booking_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "agency_booking_kind" CHECK (kind IN ('agency', 'bank')),
	CONSTRAINT "agency_booking_agency" CHECK ((kind = 'agency') = (agency_id IS NOT NULL)),
	CONSTRAINT "agency_booking_status" CHECK (status IN ('confirmed', 'cancelled')),
	CONSTRAINT "agency_booking_money" CHECK (charge_pence_per_hour BETWEEN 0 AND 1000000 AND cost_pence >= 0),
	CONSTRAINT "agency_booking_cancelled" CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL) AND (status = 'cancelled') = (cancel_reason IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "agency_worker" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"agency_id" uuid,
	"role_title" text NOT NULL,
	"dbs_confirmed_on" date,
	"dbs_enhanced_barred" boolean DEFAULT false NOT NULL,
	"right_to_work_confirmed_on" date,
	"right_to_work_expires_on" date,
	"registration_body" text,
	"registration_valid_until" date,
	"confirmed_by" uuid,
	"do_not_book" boolean DEFAULT false NOT NULL,
	"do_not_book_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agency_worker_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "agency_worker_member_key" UNIQUE("tenant_id","tenant_user_id"),
	CONSTRAINT "agency_worker_kind" CHECK (kind IN ('agency', 'bank')),
	CONSTRAINT "agency_worker_agency" CHECK ((kind = 'agency') = (agency_id IS NOT NULL)),
	CONSTRAINT "agency_worker_role_title" CHECK (char_length(btrim(role_title)) BETWEEN 1 AND 80),
	CONSTRAINT "agency_worker_registration" CHECK (registration_body IS NULL OR registration_body IN ('nmc', 'hcpc', 'swe', 'gmc')),
	CONSTRAINT "agency_worker_confirmed" CHECK (confirmed_by IS NULL OR confirmed_by <> tenant_user_id),
	CONSTRAINT "agency_worker_do_not_book" CHECK (do_not_book = (do_not_book_reason IS NOT NULL) AND (do_not_book_reason IS NULL OR btrim(do_not_book_reason) <> ''))
);
--> statement-breakpoint
CREATE TABLE "agency_worker_feedback" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"worker_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"notes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "agency_worker_feedback_kind" CHECK (kind IN ('positive', 'concern', 'do_not_rebook')),
	CONSTRAINT "agency_worker_feedback_notes" CHECK (char_length(btrim(notes)) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "location_induction" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"worker_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"inducted_on" date NOT NULL,
	"items" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "location_induction_items" CHECK (cardinality(items) BETWEEN 1 AND 40)
);
--> statement-breakpoint
ALTER TABLE "agency_booking" ADD CONSTRAINT "agency_booking_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shift"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_booking" ADD CONSTRAINT "agency_booking_assignment_fk" FOREIGN KEY ("tenant_id","assignment_id") REFERENCES "public"."shift_assignment"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_booking" ADD CONSTRAINT "agency_booking_agency_fk" FOREIGN KEY ("tenant_id","agency_id") REFERENCES "public"."agency"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_booking" ADD CONSTRAINT "agency_booking_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_booking" ADD CONSTRAINT "agency_booking_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_worker" ADD CONSTRAINT "agency_worker_member_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_worker" ADD CONSTRAINT "agency_worker_confirmed_by_fk" FOREIGN KEY ("tenant_id","confirmed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_worker" ADD CONSTRAINT "agency_worker_agency_fk" FOREIGN KEY ("tenant_id","agency_id") REFERENCES "public"."agency"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_worker_feedback" ADD CONSTRAINT "agency_worker_feedback_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_worker_feedback" ADD CONSTRAINT "agency_worker_feedback_booking_fk" FOREIGN KEY ("tenant_id","booking_id") REFERENCES "public"."agency_booking"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_worker_feedback" ADD CONSTRAINT "agency_worker_feedback_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_induction" ADD CONSTRAINT "location_induction_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_induction" ADD CONSTRAINT "location_induction_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agency_booking_live_key" ON "agency_booking" USING btree ("tenant_id","assignment_id") WHERE status = 'confirmed';--> statement-breakpoint
CREATE INDEX "agency_booking_worker_idx" ON "agency_booking" USING btree ("tenant_id","worker_id");--> statement-breakpoint
CREATE INDEX "location_induction_worker_idx" ON "location_induction" USING btree ("tenant_id","worker_id","location_id");--> statement-breakpoint

-- Bank and agency workers (scheduling.md section 15; SCHED-009; ADR-0088; HZ-124, HZ-011).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agency', 'agency_worker', 'agency_booking', 'location_induction',
      'agency_worker_feedback'] LOOP
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

-- Agencies and their workers: read by rota readers anywhere, written by rota builders.
CREATE OR REPLACE FUNCTION app.reads_rotas_anywhere() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.is_system()
    OR app.holds_permission_anywhere('scheduling.rota.read')
    OR app.holds_permission_anywhere('scheduling.rota.manage')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.manages_rotas_anywhere() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.is_system() OR app.holds_permission_anywhere('scheduling.rota.manage')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reads_rotas_anywhere(), app.manages_rotas_anywhere() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reads_rotas_anywhere(), app.manages_rotas_anywhere()
  TO harbour_app, harbour_owner;
--> statement-breakpoint
CREATE POLICY agency_read ON public.agency AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.reads_rotas_anywhere());
--> statement-breakpoint
CREATE POLICY agency_insert ON public.agency AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.manages_rotas_anywhere());
--> statement-breakpoint
CREATE POLICY agency_update ON public.agency AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.manages_rotas_anywhere()) WITH CHECK (app.manages_rotas_anywhere());
--> statement-breakpoint
-- The agency's confirmation (DBS, right to work) and do-not-book are read only by rota builders,
-- never by rota readers (security review of slice 27, M3).
CREATE POLICY agency_worker_read ON public.agency_worker AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.manages_rotas_anywhere());
--> statement-breakpoint
-- Never by the worker about themselves; a confirmation in the recorder's own name.
-- Registering changes what the member may hold: it also needs platform.user.manage (review M5).
CREATE POLICY agency_worker_insert ON public.agency_worker AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.manages_rotas_anywhere() AND tenant_user_id <> app.current_user_id()
    AND app.holds_role_permission_somewhere('platform.user.manage'));
--> statement-breakpoint
CREATE POLICY agency_worker_update ON public.agency_worker AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.manages_rotas_anywhere() AND tenant_user_id <> app.current_user_id())
  WITH CHECK (app.manages_rotas_anywhere() AND tenant_user_id <> app.current_user_id());
--> statement-breakpoint
CREATE POLICY rota_read ON public.agency_booking AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.reads_rota(location_id));
--> statement-breakpoint
CREATE POLICY rota_insert ON public.agency_booking AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.manages_rota(location_id));
--> statement-breakpoint
CREATE POLICY rota_update ON public.agency_booking AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.manages_rota(location_id)) WITH CHECK (app.manages_rota(location_id));
--> statement-breakpoint
CREATE POLICY rota_read ON public.location_induction AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.reads_rota(location_id));
--> statement-breakpoint
CREATE POLICY induction_insert ON public.location_induction AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.manages_rota(location_id) AND worker_id <> app.current_user_id()
    AND created_by = app.current_user_id());
--> statement-breakpoint
-- Feedback about a worker is read by those who build the rota there, never by rota readers alone.
CREATE POLICY feedback_read ON public.agency_worker_feedback AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.is_system() OR app.holds_permission_at('scheduling.rota.manage', location_id));
--> statement-breakpoint
CREATE POLICY feedback_insert ON public.agency_worker_feedback AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.manages_rota(location_id) AND worker_id <> app.current_user_id()
    AND created_by = app.current_user_id());
--> statement-breakpoint

-- A bank or agency worker is a member who holds no role but agency_worker; registering one flags
-- the member `is_agency` (ADR-0088). Definer: it reads the member's roles and sets the flag, which
-- the rota builder may not do through tenant_user's own policies.
CREATE OR REPLACE FUNCTION app.agency_worker_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- A confirmation is recorded in the recorder's own name (the table refuses the worker).
  IF NEW.confirmed_by IS NOT NULL AND NOT app.is_system()
      AND (TG_OP = 'INSERT' OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by)
      AND NEW.confirmed_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A confirmation is recorded in the recorder''s own name'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The agency's confirmation is of checks already made: never dated after today (UK; clinical
  -- safety review of slice 27, H4).
  IF GREATEST(NEW.dbs_confirmed_on, NEW.right_to_work_confirmed_on)
       > (now() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'A confirmation is dated no later than today' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_user_id IS DISTINCT FROM OLD.tenant_user_id OR NEW.kind IS DISTINCT FROM OLD.kind
        OR NEW.agency_id IS DISTINCT FROM OLD.agency_id THEN
      RAISE EXCEPTION 'A bank or agency worker keeps their member, kind and agency'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- Lock the member so a role given at the same moment is seen by one guard or the other (M5).
  PERFORM 1 FROM public.tenant_user u
   WHERE u.tenant_id = NEW.tenant_id AND u.id = NEW.tenant_user_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.access_grant g
    WHERE g.tenant_id = NEW.tenant_id AND g.tenant_user_id = NEW.tenant_user_id
      AND g.deleted_at IS NULL AND g.revoked_at IS NULL AND g.valid_to > now()) THEN
    RAISE EXCEPTION 'Only a member with no role but agency or bank worker can be registered'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.role_assignment ra
    JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
    WHERE ra.tenant_id = NEW.tenant_id AND ra.tenant_user_id = NEW.tenant_user_id
      AND ra.deleted_at IS NULL AND (ra.valid_to IS NULL OR ra.valid_to > now())
      AND r.key <> 'agency_worker') THEN
    RAISE EXCEPTION 'Only a member with no role but agency or bank worker can be registered'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.registering_agency_worker', 'on', true);
  UPDATE public.tenant_user SET is_agency = true
   WHERE tenant_id = NEW.tenant_id AND id = NEW.tenant_user_id AND NOT is_agency;
  PERFORM set_config('app.registering_agency_worker', 'off', true);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER agency_worker_guard BEFORE INSERT OR UPDATE ON public.agency_worker
  FOR EACH ROW EXECUTE FUNCTION app.agency_worker_guard();
--> statement-breakpoint
-- An agency or bank member is given no role but agency_worker (their access comes from bookings).
CREATE OR REPLACE FUNCTION app.agency_member_role_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM 1 FROM public.tenant_user u
   WHERE u.tenant_id = NEW.tenant_id AND u.id = NEW.tenant_user_id FOR UPDATE;
  IF NEW.deleted_at IS NULL AND EXISTS (
      SELECT 1 FROM public.tenant_user u
      WHERE u.tenant_id = NEW.tenant_id AND u.id = NEW.tenant_user_id AND u.is_agency)
    AND EXISTS (
      SELECT 1 FROM public.role r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.role_id AND r.key <> 'agency_worker') THEN
    RAISE EXCEPTION 'A bank or agency worker holds only the agency worker role'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER agency_member_role_guard BEFORE INSERT OR UPDATE ON public.role_assignment
  FOR EACH ROW EXECUTE FUNCTION app.agency_member_role_guard();
--> statement-breakpoint

-- A booking is the live assignment of its worker on its shift, at the shift's location, for a
-- registered worker of the same kind and agency who is not marked do-not-book; what it is about
-- never changes.
CREATE OR REPLACE FUNCTION app.agency_booking_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_worker public.agency_worker%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.shift_id IS DISTINCT FROM OLD.shift_id OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
        OR NEW.worker_id IS DISTINCT FROM OLD.worker_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
        OR NEW.agency_id IS DISTINCT FROM OLD.agency_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
      RAISE EXCEPTION 'A booking keeps its shift, worker and agency'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'A cancelled booking stays cancelled' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.shift_assignment a JOIN public.shift s
      ON s.tenant_id = a.tenant_id AND s.id = a.shift_id
    WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.assignment_id AND a.shift_id = NEW.shift_id
      AND a.worker_id = NEW.worker_id AND a.deleted_at IS NULL AND s.deleted_at IS NULL
      AND s.location_id = NEW.location_id) THEN
    RAISE EXCEPTION 'A booking is the live assignment of its worker on its shift'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT * INTO v_worker FROM public.agency_worker w
   WHERE w.tenant_id = NEW.tenant_id AND w.tenant_user_id = NEW.worker_id;
  IF NOT FOUND OR v_worker.kind <> NEW.kind OR v_worker.agency_id IS DISTINCT FROM NEW.agency_id THEN
    RAISE EXCEPTION 'A booking is for a registered worker of its kind and agency'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_worker.do_not_book THEN
    RAISE EXCEPTION 'This worker is not to be booked' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.agency_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.agency g
      WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.agency_id AND g.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'An archived agency is not booked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER agency_booking_guard BEFORE INSERT OR UPDATE ON public.agency_booking
  FOR EACH ROW EXECUTE FUNCTION app.agency_booking_guard();
--> statement-breakpoint

-- ADR-0088: an agency or bank member's access comes only from a confirmed booking of a live shift
-- at the location of each role or grant (security review of slice 27, M2), from the shift's start
-- to its end plus access.agency.post_shift_hours (rate table; none recorded gives no hours after),
-- and never for a worker marked do not book. A role or grant across the organisation opens with a
-- booking anywhere. Definer: it reads bookings and shifts the member may not read, and so cannot
-- recurse through the rota policies. A member who is not an agency or bank worker is always open;
-- a member whose row cannot be found is closed (review L2).
CREATE OR REPLACE FUNCTION app.member_is_agency(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_user IS NOT NULL AND COALESCE((SELECT u.is_agency FROM public.tenant_user u
                        WHERE u.tenant_id = app.current_tenant_id() AND u.id = p_user), true)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.agency_access_open(p_user uuid, p_location uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT app.member_is_agency(p_user)
    OR (NOT EXISTS (SELECT 1 FROM public.agency_worker w
                    WHERE w.tenant_id = app.current_tenant_id() AND w.tenant_user_id = p_user
                      AND w.do_not_book)
    AND EXISTS (
      SELECT 1
      FROM public.agency_booking b
      JOIN public.shift s ON s.tenant_id = b.tenant_id AND s.id = b.shift_id
      JOIN public.shift_assignment a ON a.tenant_id = b.tenant_id AND a.id = b.assignment_id
      WHERE b.tenant_id = app.current_tenant_id() AND b.worker_id = p_user
        AND (p_location IS NULL OR b.location_id = p_location)
        AND b.status = 'confirmed' AND s.deleted_at IS NULL AND a.deleted_at IS NULL
        AND s.starts_at <= now()
        AND now() < s.ends_at + COALESCE(app.quality_rate('access.agency.post_shift_hours', now()), 0)
          * interval '1 hour'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.member_is_agency(uuid), app.agency_access_open(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.member_is_agency(uuid), app.agency_access_open(uuid, uuid)
  TO harbour_app, harbour_owner;
--> statement-breakpoint
-- Every permission check (app.holds_* and the API's accessRowsOf) reads the caller's own role rows
-- with invoker rights, so hiding an agency member's own rows outside the window closes every door
-- at once. Other members' rows are read through the API, which applies the same function
-- (accessRowsOf). The member test runs once per statement (an initplan), so members who are not
-- agency workers pay nothing per row (review L3). Owner-run definer functions see the same window
-- (review L1).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['role_assignment', 'access_grant'] LOOP
    EXECUTE format(
      'CREATE POLICY agency_window ON public.%I AS RESTRICTIVE FOR SELECT TO harbour_app, harbour_owner '
      'USING (tenant_user_id IS DISTINCT FROM app.current_user_id() '
      'OR NOT (SELECT app.member_is_agency(app.current_user_id())) '
      'OR app.agency_access_open(tenant_user_id, location_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Only the registration guard sets is_agency, and it is never cleared by the application (security
-- review of slice 27, M4): the guard sets a transaction-local flag around its own update.
CREATE OR REPLACE FUNCTION app.is_agency_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_agency IS DISTINCT FROM OLD.is_agency
     AND NOT (NEW.is_agency
       AND COALESCE(current_setting('app.registering_agency_worker', true), '') = 'on') THEN
    RAISE EXCEPTION 'Only registering a bank or agency worker sets this, and nothing clears it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER is_agency_guard BEFORE UPDATE OF is_agency ON public.tenant_user
  FOR EACH ROW EXECUTE FUNCTION app.is_agency_guard();
--> statement-breakpoint

-- An agency or bank member is on a shift only through a booking (security review H1, clinical H2):
-- at the end of the transaction a live assignment of theirs needs a confirmed booking of it.
CREATE OR REPLACE FUNCTION app.agency_assignment_booked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.deleted_at IS NULL AND app.member_is_agency(NEW.worker_id) AND NOT EXISTS (
      SELECT 1 FROM public.agency_booking b
      WHERE b.tenant_id = NEW.tenant_id AND b.assignment_id = NEW.id AND b.status = 'confirmed') THEN
    RAISE EXCEPTION 'A bank or agency worker is put on a shift by booking them'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER agency_assignment_booked AFTER INSERT ON public.shift_assignment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.agency_assignment_booked();
--> statement-breakpoint
-- A booking ends with its assignment or its shift (review L4): taking the worker off, or cancelling
-- the shift, cancels the booking, so access closes and cost and the AWR clock stop counting it.
CREATE OR REPLACE FUNCTION app.agency_booking_follows() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    IF TG_TABLE_NAME = 'shift_assignment' THEN
      UPDATE public.agency_booking SET status = 'cancelled', cancelled_at = now(),
        cancel_reason = 'Taken off the shift'
       WHERE tenant_id = NEW.tenant_id AND assignment_id = NEW.id AND status = 'confirmed';
    ELSE
      UPDATE public.agency_booking SET status = 'cancelled', cancelled_at = now(),
        cancel_reason = 'The shift was cancelled'
       WHERE tenant_id = NEW.tenant_id AND shift_id = NEW.id AND status = 'confirmed';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER agency_booking_follows AFTER UPDATE OF deleted_at ON public.shift_assignment
  FOR EACH ROW EXECUTE FUNCTION app.agency_booking_follows();
--> statement-breakpoint
CREATE TRIGGER agency_booking_follows AFTER UPDATE OF deleted_at ON public.shift
  FOR EACH ROW EXECUTE FUNCTION app.agency_booking_follows();
--> statement-breakpoint
-- Feedback is about the booking's worker at the booking's location (review L5).
CREATE OR REPLACE FUNCTION app.agency_feedback_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.agency_booking b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.booking_id
        AND b.worker_id = NEW.worker_id AND b.location_id = NEW.location_id) THEN
    RAISE EXCEPTION 'Feedback is about the booking''s worker at its location'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER agency_feedback_guard BEFORE INSERT ON public.agency_worker_feedback
  FOR EACH ROW EXECUTE FUNCTION app.agency_feedback_guard();
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agency', 'agency_worker', 'agency_booking'] LOOP
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['location_induction', 'agency_worker_feedback'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.agency, public.agency_worker, public.agency_booking
  TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.location_induction, public.agency_worker_feedback TO harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.agency, public.agency_worker, public.agency_booking FROM harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.location_induction, public.agency_worker_feedback
  FROM harbour_app;
--> statement-breakpoint
-- Earlier versions follow the tables' own read rules.
CREATE POLICY record_version_agency ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (table_name NOT IN ('agency', 'agency_worker', 'agency_booking')
    OR (table_name = 'agency_booking' AND app.reads_rota((data->>'location_id')::uuid))
    OR (table_name = 'agency' AND app.reads_rotas_anywhere())
    OR (table_name = 'agency_worker' AND app.manages_rotas_anywhere()));
