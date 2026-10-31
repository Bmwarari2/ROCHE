CREATE TABLE "dmd_amp" (
	"id" text PRIMARY KEY NOT NULL,
	"vmp_id" text NOT NULL,
	"name" text NOT NULL,
	"abbreviated_name" text,
	"description" text NOT NULL,
	"invalid" boolean DEFAULT false NOT NULL,
	"licensed_route_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"release_id" uuid NOT NULL,
	"search_name" "tsvector" GENERATED ALWAYS AS (app.search_vector(description)) STORED,
	CONSTRAINT "dmd_amp_id" CHECK ("id" ~ '^[1-9][0-9]{5,17}$')
);
--> statement-breakpoint
CREATE TABLE "dmd_ampp" (
	"id" text PRIMARY KEY NOT NULL,
	"vmpp_id" text NOT NULL,
	"amp_id" text NOT NULL,
	"name" text NOT NULL,
	"abbreviated_name" text,
	"legal_category_code" text,
	"discontinued" boolean DEFAULT false NOT NULL,
	"discontinued_on" date,
	"invalid" boolean DEFAULT false NOT NULL,
	"release_id" uuid NOT NULL,
	CONSTRAINT "dmd_ampp_id" CHECK ("id" ~ '^[1-9][0-9]{5,17}$')
);
--> statement-breakpoint
CREATE TABLE "dmd_gtin" (
	"id" text PRIMARY KEY NOT NULL,
	"ampp_id" text NOT NULL,
	"gtin" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"withdrawn_release_id" uuid,
	"release_id" uuid NOT NULL,
	CONSTRAINT "dmd_gtin_gtin" CHECK ("dmd_gtin"."gtin" ~ '^[0-9]{14}$'),
	CONSTRAINT "dmd_gtin_key" CHECK ("dmd_gtin"."id" = "dmd_gtin"."ampp_id" || ':' || "dmd_gtin"."gtin" || ':' || to_char("dmd_gtin"."start_date", 'YYYY-MM-DD')),
	CONSTRAINT "dmd_gtin_dates" CHECK ("dmd_gtin"."end_date" IS NULL OR "dmd_gtin"."end_date" >= "dmd_gtin"."start_date")
);
--> statement-breakpoint
CREATE TABLE "dmd_lookup" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"previous_code" text,
	"release_id" uuid NOT NULL,
	CONSTRAINT "dmd_lookup_kind" CHECK ("dmd_lookup"."kind" IN ('unit_of_measure', 'form', 'route', 'control_drug_category', 'legal_category')),
	CONSTRAINT "dmd_lookup_id" CHECK ("dmd_lookup"."id" = "dmd_lookup"."kind" || ':' || "dmd_lookup"."code"),
	CONSTRAINT "dmd_lookup_code" CHECK ("dmd_lookup"."code" ~ '^[0-9A-Za-z]{1,20}$')
);
--> statement-breakpoint
CREATE TABLE "dmd_release" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"name" text NOT NULL,
	"released_on" date NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"checksum" text,
	"file_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"problem_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"loaded_by" text DEFAULT session_user NOT NULL,
	CONSTRAINT "dmd_release_name" CHECK (length("dmd_release"."name") BETWEEN 1 AND 200),
	CONSTRAINT "dmd_release_source" CHECK ("dmd_release"."source" IN ('nhsbsa_trud', 'fixture', 'manual')),
	CONSTRAINT "dmd_release_status" CHECK ("dmd_release"."status" IN ('loading', 'loaded', 'refused', 'failed')),
	CONSTRAINT "dmd_release_checksum" CHECK ("dmd_release"."checksum" IS NULL OR "dmd_release"."checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "dmd_release_finished" CHECK (("dmd_release"."status" = 'loading') = ("dmd_release"."finished_at" IS NULL)
        AND ("dmd_release"."status" IN ('loading', 'loaded')) = ("dmd_release"."problem_count" = 0))
);
--> statement-breakpoint
CREATE TABLE "dmd_vmp" (
	"id" text PRIMARY KEY NOT NULL,
	"vtm_id" text,
	"name" text NOT NULL,
	"abbreviated_name" text,
	"invalid" boolean DEFAULT false NOT NULL,
	"previous_id" text,
	"superseded_by" text,
	"unit_dose_uom_code" text,
	"udfs" numeric,
	"udfs_uom_code" text,
	"strength_uom_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"form_code" text,
	"route_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"control_drug_category_code" text,
	"release_id" uuid NOT NULL,
	"search_name" "tsvector" GENERATED ALWAYS AS (app.search_vector(name)) STORED,
	CONSTRAINT "dmd_vmp_id" CHECK ("id" ~ '^[1-9][0-9]{5,17}$')
);
--> statement-breakpoint
CREATE TABLE "dmd_vmpp" (
	"id" text PRIMARY KEY NOT NULL,
	"vmp_id" text NOT NULL,
	"name" text NOT NULL,
	"quantity" numeric,
	"quantity_uom_code" text,
	"invalid" boolean DEFAULT false NOT NULL,
	"release_id" uuid NOT NULL,
	CONSTRAINT "dmd_vmpp_id" CHECK ("id" ~ '^[1-9][0-9]{5,17}$')
);
--> statement-breakpoint
CREATE TABLE "dmd_vtm" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"abbreviated_name" text,
	"invalid" boolean DEFAULT false NOT NULL,
	"previous_id" text,
	"superseded_by" text,
	"release_id" uuid NOT NULL,
	CONSTRAINT "dmd_vtm_id" CHECK ("id" ~ '^[1-9][0-9]{5,17}$')
);
--> statement-breakpoint
ALTER TABLE "dmd_amp" ADD CONSTRAINT "dmd_amp_release_fk" FOREIGN KEY ("release_id") REFERENCES "public"."dmd_release"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmd_amp" ADD CONSTRAINT "dmd_amp_vmp_fk" FOREIGN KEY ("vmp_id") REFERENCES "public"."dmd_vmp"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmd_ampp" ADD CONSTRAINT "dmd_ampp_release_fk" FOREIGN KEY ("release_id") REFERENCES "public"."dmd_release"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmd_ampp" ADD CONSTRAINT "dmd_ampp_vmpp_fk" FOREIGN KEY ("vmpp_id") REFERENCES "public"."dmd_vmpp"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmd_ampp" ADD CONSTRAINT "dmd_ampp_amp_fk" FOREIGN KEY ("amp_id") REFERENCES "public"."dmd_amp"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmd_gtin" ADD CONSTRAINT "dmd_gtin_release_fk" FOREIGN KEY ("release_id") REFERENCES "public"."dmd_release"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmd_gtin" ADD CONSTRAINT "dmd_gtin_withdrawn_release_fk" FOREIGN KEY ("withdrawn_release_id") REFERENCES "public"."dmd_release"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmd_gtin" ADD CONSTRAINT "dmd_gtin_ampp_fk" FOREIGN KEY ("ampp_id") REFERENCES "public"."dmd_ampp"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmd_lookup" ADD CONSTRAINT "dmd_lookup_release_fk" FOREIGN KEY ("release_id") REFERENCES "public"."dmd_release"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmd_vmp" ADD CONSTRAINT "dmd_vmp_release_fk" FOREIGN KEY ("release_id") REFERENCES "public"."dmd_release"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmd_vmp" ADD CONSTRAINT "dmd_vmp_vtm_fk" FOREIGN KEY ("vtm_id") REFERENCES "public"."dmd_vtm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmd_vmpp" ADD CONSTRAINT "dmd_vmpp_release_fk" FOREIGN KEY ("release_id") REFERENCES "public"."dmd_release"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmd_vmpp" ADD CONSTRAINT "dmd_vmpp_vmp_fk" FOREIGN KEY ("vmp_id") REFERENCES "public"."dmd_vmp"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmd_vtm" ADD CONSTRAINT "dmd_vtm_release_fk" FOREIGN KEY ("release_id") REFERENCES "public"."dmd_release"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dmd_amp_vmp" ON "dmd_amp" USING btree ("vmp_id");--> statement-breakpoint
CREATE INDEX "dmd_amp_search_name" ON "dmd_amp" USING gin ("search_name");--> statement-breakpoint
CREATE INDEX "dmd_ampp_vmpp" ON "dmd_ampp" USING btree ("vmpp_id");--> statement-breakpoint
CREATE INDEX "dmd_ampp_amp" ON "dmd_ampp" USING btree ("amp_id");--> statement-breakpoint
CREATE INDEX "dmd_gtin_gtin" ON "dmd_gtin" USING btree ("gtin");--> statement-breakpoint
CREATE INDEX "dmd_gtin_ampp" ON "dmd_gtin" USING btree ("ampp_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dmd_release_loaded_name" ON "dmd_release" USING btree ("name") WHERE "dmd_release"."status" = 'loaded';--> statement-breakpoint
CREATE INDEX "dmd_release_released_on" ON "dmd_release" USING btree ("released_on");--> statement-breakpoint
CREATE INDEX "dmd_vmp_vtm" ON "dmd_vmp" USING btree ("vtm_id");--> statement-breakpoint
CREATE INDEX "dmd_vmp_search_name" ON "dmd_vmp" USING gin ("search_name");--> statement-breakpoint
CREATE INDEX "dmd_vmpp_vmp" ON "dmd_vmpp" USING btree ("vmp_id");--> statement-breakpoint

-- dm+d reference data (integrations.md section 11; INTG-006, MEDS-001; ADR-0080; HZ-113). Runs as
-- harbour_owner. Global reference tables with no tenant, like bank_holiday (migration 0015) and the
-- framework tables (0076): forced row-level security with a read policy for every role. The
-- application, the worker and the sync role read them; only harbour_dmd_loader (NOLOGIN) writes,
-- and only inside the loader functions below, which the worker (the monthly job) and the owner (a
-- manual run) may call. Nothing is ever deleted: dm+d marks a concept invalid instead, and the
-- release history never changes once a release is finished. No personal data.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dmd_release', 'dmd_lookup', 'dmd_vtm', 'dmd_vmp', 'dmd_amp',
    'dmd_vmpp', 'dmd_ampp', 'dmd_gtin'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY global_read ON public.%I AS PERMISSIVE FOR SELECT TO PUBLIC '
      'USING (true)', t);
    -- The replication snapshot reads every row (ADR-0080: the device subset, slice 68).
    EXECUTE format('CREATE POLICY sync_replication_read ON public.%I AS PERMISSIVE FOR SELECT '
      'TO harbour_sync USING (true)', t);
    EXECUTE format('CREATE POLICY loader_insert ON public.%I AS PERMISSIVE FOR INSERT '
      'TO harbour_dmd_loader WITH CHECK (true)', t);
    EXECUTE format('CREATE POLICY loader_update ON public.%I AS PERMISSIVE FOR UPDATE '
      'TO harbour_dmd_loader USING (true) WITH CHECK (true)', t);
    -- The default privileges (migration 0002) give the application INSERT and UPDATE: not here.
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.%I '
      'FROM harbour_app, harbour_worker, harbour_sync, harbour_operator, harbour_auth', t);
    EXECUTE format('GRANT SELECT ON public.%I TO harbour_app, harbour_worker, harbour_sync', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO harbour_dmd_loader', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Nothing disappears (rule 4): no role deletes or truncates dm+d rows or the release history.
CREATE FUNCTION app.dmd_never_deleted() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'dm+d reference data and its release history are never deleted.'
    USING ERRCODE = '42501',
          HINT = 'dm+d marks a concept invalid; a release that lacks one is refused.';
END
$$;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dmd_release', 'dmd_lookup', 'dmd_vtm', 'dmd_vmp', 'dmd_amp',
    'dmd_vmpp', 'dmd_ampp', 'dmd_gtin'] LOOP
    EXECUTE format('CREATE TRIGGER dmd_never_deleted BEFORE DELETE ON public.%I FOR EACH ROW '
      'EXECUTE FUNCTION app.dmd_never_deleted()', t);
    EXECUTE format('CREATE TRIGGER dmd_never_truncated BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.dmd_never_deleted()', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- The release history (rule 1): a finished release (loaded, refused or failed) never changes; a
-- loading one changes only its outcome, once, when the loader finishes it.
CREATE FUNCTION app.dmd_release_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'loading' THEN
    RAISE EXCEPTION 'A finished dm+d release never changes.' USING ERRCODE = '42501';
  END IF;
  IF NEW.id <> OLD.id OR NEW.name <> OLD.name OR NEW.released_on <> OLD.released_on
     OR NEW.source <> OLD.source OR NEW.checksum IS DISTINCT FROM OLD.checksum
     OR NEW.started_at <> OLD.started_at OR NEW.loaded_by <> OLD.loaded_by
     OR NEW.file_counts <> OLD.file_counts OR NEW.status <> 'loaded' THEN
    RAISE EXCEPTION 'A loading dm+d release changes only to loaded, with its outcome.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER dmd_release_guard BEFORE UPDATE ON public.dmd_release
  FOR EACH ROW EXECUTE FUNCTION app.dmd_release_guard();
--> statement-breakpoint

-- A release is committed only finished: a transaction that began a load and neither finished nor
-- rolled it back cannot commit, so readers never see a half-loaded release (rule 1).
CREATE FUNCTION app.dmd_release_finished_at_commit() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.dmd_release WHERE id = NEW.id AND status = 'loading') THEN
    RAISE EXCEPTION 'A dm+d release is committed only once it is loaded, refused or failed.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER dmd_release_committed_finished AFTER INSERT ON public.dmd_release
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.dmd_release_finished_at_commit();
--> statement-breakpoint

-- The loader's functions (integrations.md section 11 rules 1 to 4). The worker or the owner calls
-- them in one transaction: begin (under an advisory lock: one load at a time; refuses a release
-- dated before the one in use; a release already loaded under the same name is not loaded again),
-- load the rows file by file in batches (each row written only when new or changed), then finish
-- (identifiers dm+d changed are linked to their successors; a concept in use that the release lacks
-- refuses it; GTIN mappings it lacks are withdrawn). Any refusal raises, the caller rolls back and
-- records the refusal with app.dmd_record_refusal in a transaction of its own, so readers see the
-- previous release or the new one, never a mixture. Messages name dm+d identifiers only.
CREATE FUNCTION app.dmd_begin_release(p_name text, p_released_on date, p_source text,
  p_checksum text, p_file_counts jsonb) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_latest date;
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('harbour.dmd_release', 0));
  IF EXISTS (SELECT 1 FROM public.dmd_release WHERE name = p_name AND status = 'loaded') THEN
    RETURN NULL;
  END IF;
  SELECT max(released_on) INTO v_latest FROM public.dmd_release WHERE status = 'loaded';
  IF v_latest IS NOT NULL AND p_released_on < v_latest THEN
    RAISE EXCEPTION 'The dm+d release is dated %, before the release in use (%).',
      p_released_on, v_latest
      USING ERRCODE = 'P0001', HINT = 'dmd:older_than_current';
  END IF;
  INSERT INTO public.dmd_release (name, released_on, source, status, checksum, file_counts,
    started_at)
  VALUES (p_name, p_released_on, p_source, 'loading', p_checksum,
    coalesce(p_file_counts, '{}'::jsonb), clock_timestamp())
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
--> statement-breakpoint

CREATE FUNCTION app.dmd_load_rows(p_release uuid, p_kind text, p_rows jsonb) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_added integer := 0;
  v_changed integer := 0;
  v_invalidated integer := 0;
BEGIN
  -- A loading release is visible only to the transaction that began it.
  IF NOT EXISTS (SELECT 1 FROM public.dmd_release WHERE id = p_release AND status = 'loading') THEN
    RAISE EXCEPTION 'No dm+d release is loading in this transaction.'
      USING ERRCODE = 'P0001', HINT = 'dmd:not_loading';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'dm+d rows come as an array.' USING ERRCODE = '22023';
  END IF;

  IF p_kind = 'lookup' THEN
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(p_rows)
        AS r(id text, kind text, code text, description text, previous_code text)
    ), written AS (
      INSERT INTO public.dmd_lookup AS t (id, kind, code, description, previous_code, release_id)
      SELECT id, kind, code, description, previous_code, p_release FROM incoming
      ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description,
        previous_code = EXCLUDED.previous_code, release_id = EXCLUDED.release_id
      WHERE (t.description, t.previous_code)
        IS DISTINCT FROM (EXCLUDED.description, EXCLUDED.previous_code)
      RETURNING (t.xmax = 0) AS added
    )
    SELECT count(*) FILTER (WHERE added), count(*) FILTER (WHERE NOT added)
      INTO v_added, v_changed FROM written;

  ELSIF p_kind = 'vtm' THEN
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(p_rows)
        AS r(id text, name text, abbreviated_name text, invalid boolean, previous_id text)
    ), newly_invalid AS (
      SELECT count(*) AS n FROM incoming i JOIN public.dmd_vtm t ON t.id = i.id
       WHERE i.invalid AND NOT t.invalid
    ), written AS (
      INSERT INTO public.dmd_vtm AS t (id, name, abbreviated_name, invalid, previous_id, release_id)
      SELECT id, name, abbreviated_name, invalid, previous_id, p_release FROM incoming
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
        abbreviated_name = EXCLUDED.abbreviated_name, invalid = EXCLUDED.invalid,
        previous_id = EXCLUDED.previous_id, release_id = EXCLUDED.release_id
      WHERE (t.name, t.abbreviated_name, t.invalid, t.previous_id)
        IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.abbreviated_name, EXCLUDED.invalid,
          EXCLUDED.previous_id)
      RETURNING (t.xmax = 0) AS added
    )
    SELECT count(*) FILTER (WHERE added), count(*) FILTER (WHERE NOT added),
           (SELECT n FROM newly_invalid)
      INTO v_added, v_changed, v_invalidated FROM written;

  ELSIF p_kind = 'vmp' THEN
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(p_rows)
        AS r(id text, vtm_id text, name text, abbreviated_name text, invalid boolean,
          previous_id text, unit_dose_uom_code text, udfs numeric, udfs_uom_code text,
          strength_uom_codes text[], form_code text, route_codes text[],
          control_drug_category_code text)
    ), newly_invalid AS (
      SELECT count(*) AS n FROM incoming i JOIN public.dmd_vmp t ON t.id = i.id
       WHERE i.invalid AND NOT t.invalid
    ), written AS (
      INSERT INTO public.dmd_vmp AS t (id, vtm_id, name, abbreviated_name, invalid, previous_id,
        unit_dose_uom_code, udfs, udfs_uom_code, strength_uom_codes, form_code, route_codes,
        control_drug_category_code, release_id)
      SELECT id, vtm_id, name, abbreviated_name, invalid, previous_id, unit_dose_uom_code, udfs,
        udfs_uom_code, coalesce(strength_uom_codes, '{}'), form_code, coalesce(route_codes, '{}'),
        control_drug_category_code, p_release
        FROM incoming
      ON CONFLICT (id) DO UPDATE SET vtm_id = EXCLUDED.vtm_id, name = EXCLUDED.name,
        abbreviated_name = EXCLUDED.abbreviated_name, invalid = EXCLUDED.invalid,
        previous_id = EXCLUDED.previous_id, unit_dose_uom_code = EXCLUDED.unit_dose_uom_code,
        udfs = EXCLUDED.udfs, udfs_uom_code = EXCLUDED.udfs_uom_code,
        strength_uom_codes = EXCLUDED.strength_uom_codes, form_code = EXCLUDED.form_code,
        route_codes = EXCLUDED.route_codes,
        control_drug_category_code = EXCLUDED.control_drug_category_code,
        release_id = EXCLUDED.release_id
      WHERE (t.vtm_id, t.name, t.abbreviated_name, t.invalid, t.previous_id, t.unit_dose_uom_code,
             t.udfs, t.udfs_uom_code, t.strength_uom_codes, t.form_code, t.route_codes,
             t.control_drug_category_code)
        IS DISTINCT FROM (EXCLUDED.vtm_id, EXCLUDED.name, EXCLUDED.abbreviated_name,
          EXCLUDED.invalid, EXCLUDED.previous_id, EXCLUDED.unit_dose_uom_code, EXCLUDED.udfs,
          EXCLUDED.udfs_uom_code, EXCLUDED.strength_uom_codes, EXCLUDED.form_code,
          EXCLUDED.route_codes, EXCLUDED.control_drug_category_code)
      RETURNING (t.xmax = 0) AS added
    )
    SELECT count(*) FILTER (WHERE added), count(*) FILTER (WHERE NOT added),
           (SELECT n FROM newly_invalid)
      INTO v_added, v_changed, v_invalidated FROM written;

  ELSIF p_kind = 'amp' THEN
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(p_rows)
        AS r(id text, vmp_id text, name text, abbreviated_name text, description text,
          invalid boolean, licensed_route_codes text[])
    ), newly_invalid AS (
      SELECT count(*) AS n FROM incoming i JOIN public.dmd_amp t ON t.id = i.id
       WHERE i.invalid AND NOT t.invalid
    ), written AS (
      INSERT INTO public.dmd_amp AS t (id, vmp_id, name, abbreviated_name, description, invalid,
        licensed_route_codes, release_id)
      SELECT id, vmp_id, name, abbreviated_name, description, invalid,
        coalesce(licensed_route_codes, '{}'), p_release
        FROM incoming
      ON CONFLICT (id) DO UPDATE SET vmp_id = EXCLUDED.vmp_id, name = EXCLUDED.name,
        abbreviated_name = EXCLUDED.abbreviated_name, description = EXCLUDED.description,
        invalid = EXCLUDED.invalid, licensed_route_codes = EXCLUDED.licensed_route_codes,
        release_id = EXCLUDED.release_id
      WHERE (t.vmp_id, t.name, t.abbreviated_name, t.description, t.invalid,
             t.licensed_route_codes)
        IS DISTINCT FROM (EXCLUDED.vmp_id, EXCLUDED.name, EXCLUDED.abbreviated_name,
          EXCLUDED.description, EXCLUDED.invalid, EXCLUDED.licensed_route_codes)
      RETURNING (t.xmax = 0) AS added
    )
    SELECT count(*) FILTER (WHERE added), count(*) FILTER (WHERE NOT added),
           (SELECT n FROM newly_invalid)
      INTO v_added, v_changed, v_invalidated FROM written;

  ELSIF p_kind = 'vmpp' THEN
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(p_rows)
        AS r(id text, vmp_id text, name text, quantity numeric, quantity_uom_code text,
          invalid boolean)
    ), newly_invalid AS (
      SELECT count(*) AS n FROM incoming i JOIN public.dmd_vmpp t ON t.id = i.id
       WHERE i.invalid AND NOT t.invalid
    ), written AS (
      INSERT INTO public.dmd_vmpp AS t (id, vmp_id, name, quantity, quantity_uom_code, invalid,
        release_id)
      SELECT id, vmp_id, name, quantity, quantity_uom_code, invalid, p_release FROM incoming
      ON CONFLICT (id) DO UPDATE SET vmp_id = EXCLUDED.vmp_id, name = EXCLUDED.name,
        quantity = EXCLUDED.quantity, quantity_uom_code = EXCLUDED.quantity_uom_code,
        invalid = EXCLUDED.invalid, release_id = EXCLUDED.release_id
      WHERE (t.vmp_id, t.name, t.quantity, t.quantity_uom_code, t.invalid)
        IS DISTINCT FROM (EXCLUDED.vmp_id, EXCLUDED.name, EXCLUDED.quantity,
          EXCLUDED.quantity_uom_code, EXCLUDED.invalid)
      RETURNING (t.xmax = 0) AS added
    )
    SELECT count(*) FILTER (WHERE added), count(*) FILTER (WHERE NOT added),
           (SELECT n FROM newly_invalid)
      INTO v_added, v_changed, v_invalidated FROM written;

  ELSIF p_kind = 'ampp' THEN
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(p_rows)
        AS r(id text, vmpp_id text, amp_id text, name text, abbreviated_name text,
          legal_category_code text, discontinued boolean, discontinued_on date, invalid boolean)
    ), newly_invalid AS (
      SELECT count(*) AS n FROM incoming i JOIN public.dmd_ampp t ON t.id = i.id
       WHERE (i.invalid AND NOT t.invalid) OR (i.discontinued AND NOT t.discontinued)
    ), written AS (
      INSERT INTO public.dmd_ampp AS t (id, vmpp_id, amp_id, name, abbreviated_name,
        legal_category_code, discontinued, discontinued_on, invalid, release_id)
      SELECT id, vmpp_id, amp_id, name, abbreviated_name, legal_category_code, discontinued,
        discontinued_on, invalid, p_release
        FROM incoming
      ON CONFLICT (id) DO UPDATE SET vmpp_id = EXCLUDED.vmpp_id, amp_id = EXCLUDED.amp_id,
        name = EXCLUDED.name, abbreviated_name = EXCLUDED.abbreviated_name,
        legal_category_code = EXCLUDED.legal_category_code,
        discontinued = EXCLUDED.discontinued, discontinued_on = EXCLUDED.discontinued_on,
        invalid = EXCLUDED.invalid, release_id = EXCLUDED.release_id
      WHERE (t.vmpp_id, t.amp_id, t.name, t.abbreviated_name, t.legal_category_code,
             t.discontinued, t.discontinued_on, t.invalid)
        IS DISTINCT FROM (EXCLUDED.vmpp_id, EXCLUDED.amp_id, EXCLUDED.name,
          EXCLUDED.abbreviated_name, EXCLUDED.legal_category_code, EXCLUDED.discontinued,
          EXCLUDED.discontinued_on, EXCLUDED.invalid)
      RETURNING (t.xmax = 0) AS added
    )
    SELECT count(*) FILTER (WHERE added), count(*) FILTER (WHERE NOT added),
           (SELECT n FROM newly_invalid)
      INTO v_added, v_changed, v_invalidated FROM written;

  ELSIF p_kind = 'gtin' THEN
    -- A mapping that a release brings back is in force again.
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(p_rows)
        AS r(id text, ampp_id text, gtin text, start_date date, end_date date)
    ), written AS (
      INSERT INTO public.dmd_gtin AS t (id, ampp_id, gtin, start_date, end_date,
        withdrawn_release_id, release_id)
      SELECT id, ampp_id, gtin, start_date, end_date, NULL, p_release FROM incoming
      ON CONFLICT (id) DO UPDATE SET end_date = EXCLUDED.end_date,
        withdrawn_release_id = NULL, release_id = EXCLUDED.release_id
      WHERE (t.end_date, t.withdrawn_release_id)
        IS DISTINCT FROM (EXCLUDED.end_date, EXCLUDED.withdrawn_release_id)
      RETURNING (t.xmax = 0) AS added
    )
    SELECT count(*) FILTER (WHERE added), count(*) FILTER (WHERE NOT added)
      INTO v_added, v_changed FROM written;

  ELSE
    RAISE EXCEPTION 'Unknown dm+d file %.', p_kind USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('added', v_added, 'changed', v_changed,
    'invalidated', v_invalidated);
END
$$;
--> statement-breakpoint

CREATE FUNCTION app.dmd_finish_release(p_release uuid, p_ids jsonb, p_changes jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_superseded integer := 0;
  v_n integer;
  v_missing text[];
  v_missing_count integer;
  v_unknown integer;
  v_withdrawn integer;
  v_lookups_absent integer;
  v_changes jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.dmd_release WHERE id = p_release AND status = 'loading') THEN
    RAISE EXCEPTION 'No dm+d release is loading in this transaction.'
      USING ERRCODE = 'P0001', HINT = 'dmd:not_loading';
  END IF;

  -- Every identifier the caller says the release holds was written by this load.
  SELECT count(*) INTO v_unknown FROM (
    SELECT jsonb_array_elements_text(p_ids -> 'vtm') EXCEPT SELECT id FROM public.dmd_vtm
    UNION ALL
    (SELECT jsonb_array_elements_text(p_ids -> 'vmp') EXCEPT SELECT id FROM public.dmd_vmp)
    UNION ALL
    (SELECT jsonb_array_elements_text(p_ids -> 'amp') EXCEPT SELECT id FROM public.dmd_amp)
    UNION ALL
    (SELECT jsonb_array_elements_text(p_ids -> 'vmpp') EXCEPT SELECT id FROM public.dmd_vmpp)
    UNION ALL
    (SELECT jsonb_array_elements_text(p_ids -> 'ampp') EXCEPT SELECT id FROM public.dmd_ampp)
    UNION ALL
    (SELECT jsonb_array_elements_text(p_ids -> 'gtin') EXCEPT SELECT id FROM public.dmd_gtin)
  ) unknown;
  IF v_unknown > 0 THEN
    RAISE EXCEPTION 'The dm+d load names % identifiers it did not write.', v_unknown
      USING ERRCODE = 'P0001', HINT = 'dmd:load_failed';
  END IF;

  -- dm+d changes an identifier by naming the old one as the new concept's previous identifier:
  -- the old row stays, pointing to its successor, so a MAR entry naming it is still found.
  WITH s AS (
    UPDATE public.dmd_vtm o SET superseded_by = n.id, release_id = p_release
      FROM public.dmd_vtm n
     WHERE n.previous_id = o.id AND n.id <> o.id AND o.superseded_by IS DISTINCT FROM n.id
    RETURNING 1
  ) SELECT count(*) INTO v_n FROM s;
  v_superseded := v_superseded + v_n;
  WITH s AS (
    UPDATE public.dmd_vmp o SET superseded_by = n.id, release_id = p_release
      FROM public.dmd_vmp n
     WHERE n.previous_id = o.id AND n.id <> o.id AND o.superseded_by IS DISTINCT FROM n.id
    RETURNING 1
  ) SELECT count(*) INTO v_n FROM s;
  v_superseded := v_superseded + v_n;

  -- Nothing disappears (rule 4): a concept in use that this release lacks, and that no concept in
  -- it names as its previous identifier, refuses the release.
  SELECT array_agg(id ORDER BY id), count(*) INTO v_missing, v_missing_count FROM (
    (SELECT id FROM public.dmd_vtm WHERE superseded_by IS NULL
     EXCEPT SELECT jsonb_array_elements_text(p_ids -> 'vtm'))
    UNION ALL
    (SELECT id FROM public.dmd_vmp WHERE superseded_by IS NULL
     EXCEPT SELECT jsonb_array_elements_text(p_ids -> 'vmp'))
    UNION ALL
    (SELECT id FROM public.dmd_amp EXCEPT SELECT jsonb_array_elements_text(p_ids -> 'amp'))
    UNION ALL
    (SELECT id FROM public.dmd_vmpp EXCEPT SELECT jsonb_array_elements_text(p_ids -> 'vmpp'))
    UNION ALL
    (SELECT id FROM public.dmd_ampp EXCEPT SELECT jsonb_array_elements_text(p_ids -> 'ampp'))
  ) missing;
  IF v_missing_count > 0 THEN
    RAISE EXCEPTION '% dm+d concepts in use are missing from the release.', v_missing_count
      USING ERRCODE = 'P0001', HINT = 'dmd:concepts_missing',
            DETAIL = array_to_string(v_missing[1:10], ', ');
  END IF;

  -- A GTIN mapping the release lacks is kept, withdrawn by it, and no longer matches a scan.
  WITH w AS (
    UPDATE public.dmd_gtin g SET withdrawn_release_id = p_release
     WHERE g.id IN (SELECT id FROM public.dmd_gtin WHERE withdrawn_release_id IS NULL
                    EXCEPT SELECT jsonb_array_elements_text(p_ids -> 'gtin'))
    RETURNING 1
  ) SELECT count(*) INTO v_withdrawn FROM w;

  SELECT count(*) INTO v_lookups_absent FROM (
    SELECT id FROM public.dmd_lookup EXCEPT SELECT jsonb_array_elements_text(p_ids -> 'lookup')
  ) absent;

  v_changes := coalesce(p_changes, '{}'::jsonb) || jsonb_build_object(
    'superseded', v_superseded, 'gtins_withdrawn', v_withdrawn,
    'lookups_absent', v_lookups_absent);
  UPDATE public.dmd_release SET status = 'loaded', finished_at = clock_timestamp(),
    changes = v_changes
   WHERE id = p_release;
  -- A platform event (no tenant) in the audit chain, beside the release history (section 5.5).
  INSERT INTO public.audit_event (action, outcome, resource_type, resource_id, scope)
  SELECT 'medicines.dmd_release.loaded', 'success', 'dmd_release', r.id::text,
         jsonb_build_object('name', r.name, 'released_on', r.released_on, 'source', r.source,
           'loaded_by', r.loaded_by, 'changes', v_changes)
    FROM public.dmd_release r WHERE r.id = p_release;
  RETURN v_changes;
END
$$;
--> statement-breakpoint

-- A refused or failed release, recorded in a transaction of its own after the load rolled back.
CREATE FUNCTION app.dmd_record_refusal(p_name text, p_released_on date, p_source text,
  p_status text, p_checksum text, p_file_counts jsonb, p_problems jsonb, p_problem_count integer)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_status NOT IN ('refused', 'failed') OR p_problem_count < 1
     OR jsonb_typeof(p_problems) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_problems) NOT BETWEEN 1 AND 50
     OR octet_length(p_problems::text) > 65536 THEN
    RAISE EXCEPTION 'A refused dm+d release is recorded with its problems.'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('harbour.dmd_release', 0));
  INSERT INTO public.dmd_release (name, released_on, source, status, checksum, file_counts,
    problems, problem_count, started_at, finished_at)
  VALUES (p_name, p_released_on, p_source, p_status, p_checksum,
    coalesce(p_file_counts, '{}'::jsonb), p_problems, p_problem_count, clock_timestamp(),
    clock_timestamp())
  RETURNING id INTO v_id;
  INSERT INTO public.audit_event (action, outcome, resource_type, resource_id, scope, reason)
  VALUES ('medicines.dmd_release.' || p_status, 'error', 'dmd_release', v_id::text,
    jsonb_build_object('name', p_name, 'released_on', p_released_on, 'source', p_source,
      'loaded_by', session_user, 'problem_count', p_problem_count),
    (SELECT string_agg(DISTINCT e ->> 'code', ', ') FROM jsonb_array_elements(p_problems) e));
  RETURN v_id;
END
$$;
--> statement-breakpoint

-- What harbour_dmd_loader's functions need, and nothing else. Execute rights are set before the
-- owner changes (ADR-0002).
GRANT USAGE ON SCHEMA public, app TO harbour_dmd_loader;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.search_vector(text), app.search_terms(text), app.uuid_v7()
  TO harbour_dmd_loader;
--> statement-breakpoint
-- Each load's outcome goes into the audit chain as a platform event (no tenant).
GRANT INSERT ON public.audit_event TO harbour_dmd_loader;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.dmd_begin_release(text, date, text, text, jsonb),
  app.dmd_load_rows(uuid, text, jsonb), app.dmd_finish_release(uuid, jsonb, jsonb),
  app.dmd_record_refusal(text, date, text, text, text, jsonb, jsonb, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.dmd_begin_release(text, date, text, text, jsonb),
  app.dmd_load_rows(uuid, text, jsonb), app.dmd_finish_release(uuid, jsonb, jsonb),
  app.dmd_record_refusal(text, date, text, text, text, jsonb, jsonb, integer)
  TO harbour_worker;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_dmd_loader;
--> statement-breakpoint
ALTER FUNCTION app.dmd_begin_release(text, date, text, text, jsonb) OWNER TO harbour_dmd_loader;
--> statement-breakpoint
ALTER FUNCTION app.dmd_load_rows(uuid, text, jsonb) OWNER TO harbour_dmd_loader;
--> statement-breakpoint
ALTER FUNCTION app.dmd_finish_release(uuid, jsonb, jsonb) OWNER TO harbour_dmd_loader;
--> statement-breakpoint
ALTER FUNCTION app.dmd_record_refusal(text, date, text, text, text, jsonb, jsonb, integer)
  OWNER TO harbour_dmd_loader;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_dmd_loader;
--> statement-breakpoint
-- The owner may run a load by hand (`pnpm --filter @harbour/db dmd:load`). Granted by the new
-- owner: harbour_owner's own grant would have gone with its ownership (migration 0068).
SET ROLE harbour_dmd_loader;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.dmd_begin_release(text, date, text, text, jsonb),
  app.dmd_load_rows(uuid, text, jsonb), app.dmd_finish_release(uuid, jsonb, jsonb),
  app.dmd_record_refusal(text, date, text, text, text, jsonb, jsonb, integer)
  TO harbour_owner;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint

-- In the PowerSync publication with SELECT for the sync role (ADR-0080): slice 68 streams each
-- device its subset (packages/domain/src/medicines/dmd-subset.ts).
ALTER PUBLICATION powersync ADD TABLE public.dmd_release, public.dmd_lookup, public.dmd_vtm,
  public.dmd_vmp, public.dmd_amp, public.dmd_vmpp, public.dmd_ampp, public.dmd_gtin;
