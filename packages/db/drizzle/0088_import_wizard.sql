CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"record_type" text NOT NULL,
	"location_id" uuid NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"row_count" integer NOT NULL,
	"uploaded_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"dry_run_at" timestamp with time zone,
	"dry_run_by" uuid,
	"dry_run_errors" integer,
	"dry_run_warnings" integer,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "import_batch_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "import_batch_record_type" CHECK (record_type IN ('people')),
	CONSTRAINT "import_batch_status" CHECK (status IN ('staged', 'committed', 'undone', 'discarded', 'expired')),
	CONSTRAINT "import_batch_rows" CHECK (row_count >= 1),
	CONSTRAINT "import_batch_closed" CHECK ((status = 'staged') = (closed_at IS NULL)),
	CONSTRAINT "import_batch_dry_run" CHECK ((dry_run_at IS NULL) = (dry_run_errors IS NULL)
        AND (dry_run_at IS NULL) = (dry_run_warnings IS NULL)
        AND coalesce(dry_run_errors, 0) >= 0 AND coalesce(dry_run_warnings, 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "import_commit" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"batch_id" uuid NOT NULL,
	"record_ids" uuid[] NOT NULL,
	"record_count" integer NOT NULL,
	"committed_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "import_commit_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "import_commit_batch_key" UNIQUE("tenant_id","batch_id"),
	CONSTRAINT "import_commit_count" CHECK (record_count = cardinality(record_ids) AND record_count >= 1),
	CONSTRAINT "import_commit_undone" CHECK ((undone_at IS NULL) = (undone_by IS NULL))
);
--> statement-breakpoint
CREATE TABLE "import_row" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"cells" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "import_row_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "import_row_batch_row_key" UNIQUE("tenant_id","batch_id","row_number"),
	CONSTRAINT "import_row_number" CHECK (row_number >= 1),
	CONSTRAINT "import_row_cells" CHECK (jsonb_typeof(cells) = 'object')
);
--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_uploaded_by_fk" FOREIGN KEY ("tenant_id","uploaded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_dry_run_by_fk" FOREIGN KEY ("tenant_id","dry_run_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_commit" ADD CONSTRAINT "import_commit_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_commit" ADD CONSTRAINT "import_commit_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."import_batch"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_commit" ADD CONSTRAINT "import_commit_committed_by_fk" FOREIGN KEY ("tenant_id","committed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_commit" ADD CONSTRAINT "import_commit_undone_by_fk" FOREIGN KEY ("tenant_id","undone_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."import_batch"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_batch_staged_idx" ON "import_batch" USING btree ("tenant_id","expires_at") WHERE status = 'staged';--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_import_batch_fk" FOREIGN KEY ("tenant_id","import_batch_id") REFERENCES "public"."import_batch"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_import_batch_idx" ON "person" USING btree ("tenant_id","import_batch_id") WHERE import_batch_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_event_tenant_action_idx" ON "audit_event" USING btree ("tenant_id","action","occurred_at");--> statement-breakpoint

-- The import wizard (PLAT-014; platform.md rules 18 to 26; ADR-0092; HZ-130, HZ-011). A batch,
-- its staged rows and its commit record are reached only in a request scoped to the whole
-- organisation by a member holding platform.import.run across it (rule 18: NHS numbers are unique
-- per organisation, so an import by someone who sees only some homes could tell them a person they
-- cannot see exists), or by a job with no member in the organisation's view (the expiry sweep).
-- Staged rows are personal data in quarantine: inserted with their batch, never changed, and
-- deleted in the transaction that closes the batch. Nothing here syncs to devices.
ALTER TABLE public.import_batch ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.import_batch FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.import_row ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.import_row FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.import_commit ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.import_commit FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.import_batch AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.import_row AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.import_commit AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint

-- Who reaches an import (rule 18). Invoker rights: it reads the caller's own roles and grants. A
-- member needs platform.import.run and the permissions to create and to read the batch's records
-- (people: people.person.create and people.person.read; a dry run names the existing records a row
-- matches), all across the organisation, for every command: reading, the dry run, the commit and
-- discarding alike (#150 security review L1 and round 2).
CREATE OR REPLACE FUNCTION app.import_reachable(p_record_type text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.current_scope() = 'tenant' AND (
    app.current_user_id() IS NULL
    OR (app.holds_permission_at('platform.import.run', NULL)
        AND CASE p_record_type
              WHEN 'people' THEN app.holds_permission_at('people.person.create', NULL)
                AND app.holds_permission_at('people.person.read', NULL)
              ELSE false
            END))
$$;
--> statement-breakpoint
CREATE POLICY import_batch_reach ON public.import_batch AS RESTRICTIVE FOR ALL TO harbour_app
  USING (app.import_reachable(record_type)) WITH CHECK (app.import_reachable(record_type));
--> statement-breakpoint
-- A batch is uploaded staged, in the uploader's own name.
CREATE POLICY import_batch_upload ON public.import_batch AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (status = 'staged' AND uploaded_by = app.current_user_id()
    AND dry_run_at IS NULL AND closed_at IS NULL AND closed_by IS NULL);
--> statement-breakpoint
-- Staged rows and the commit record follow their batch; rows go only into a staged batch, by its
-- uploader; a commit record only for a committed batch, in the committer's own name.
CREATE POLICY import_row_reach ON public.import_row AS RESTRICTIVE FOR ALL TO harbour_app
  USING (EXISTS (SELECT 1 FROM public.import_batch b WHERE b.id = batch_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.import_batch b
                       WHERE b.id = batch_id AND b.status = 'staged'
                         AND b.uploaded_by = app.current_user_id()));
--> statement-breakpoint
CREATE POLICY import_commit_reach ON public.import_commit AS RESTRICTIVE FOR ALL TO harbour_app
  USING (EXISTS (SELECT 1 FROM public.import_batch b WHERE b.id = batch_id))
  WITH CHECK (committed_by = app.current_user_id() AND undone_at IS NULL AND undone_by IS NULL
    AND EXISTS (SELECT 1 FROM public.import_batch b
                 WHERE b.id = batch_id AND b.status = 'committed'));
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.import_batch, public.import_row, public.import_commit
  FROM harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.import_batch, public.import_row, public.import_commit TO harbour_app;
--> statement-breakpoint
-- What the application may change on a batch: its dry run and its closing (the guard decides how).
GRANT UPDATE (status, dry_run_at, dry_run_by, dry_run_errors, dry_run_warnings, closed_at,
  closed_by) ON public.import_batch TO harbour_app;
--> statement-breakpoint

-- The batch guard (rules 22 to 25): who uploaded what, where and when never changes; the status
-- moves forward only (staged to committed, discarded or expired; committed to undone, only by
-- app.undo_import_batch); a dry run is recorded in the member's own name while staged; a batch is
-- committed only after a dry run, committed or discarded in the member's own name, and expired
-- only by the system once its time has passed; a closed batch keeps its dry run and its closing.
CREATE OR REPLACE FUNCTION app.import_batch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.record_type, NEW.location_id, NEW.row_count, NEW.uploaded_by,
      NEW.uploaded_at, NEW.expires_at, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.record_type, OLD.location_id, OLD.row_count, OLD.uploaded_by,
      OLD.uploaded_at, OLD.expires_at, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'import_batch_fixed' USING ERRCODE = 'integrity_constraint_violation',
      DETAIL = 'A batch keeps who uploaded what, where and when.';
  END IF;
  IF (NEW.dry_run_at, NEW.dry_run_by, NEW.dry_run_errors, NEW.dry_run_warnings)
     IS DISTINCT FROM (OLD.dry_run_at, OLD.dry_run_by, OLD.dry_run_errors, OLD.dry_run_warnings)
     AND (OLD.status <> 'staged' OR app.current_user_id() IS NULL
       OR NEW.dry_run_by IS DISTINCT FROM app.current_user_id()) THEN
    RAISE EXCEPTION 'import_dry_run_own_name' USING ERRCODE = 'integrity_constraint_violation',
      DETAIL = 'A dry run is recorded while the batch is staged, in the member''s own name.';
  END IF;
  IF OLD.status <> 'staged' AND (NEW.closed_at, NEW.closed_by)
     IS DISTINCT FROM (OLD.closed_at, OLD.closed_by) THEN
    RAISE EXCEPTION 'import_batch_closed' USING ERRCODE = 'integrity_constraint_violation',
      DETAIL = 'A closed batch keeps when and by whom it closed.';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'staged' AND NEW.status IN ('committed', 'discarded', 'expired'))
         OR (OLD.status = 'committed' AND NEW.status = 'undone')) THEN
      RAISE EXCEPTION 'import_status_forward_only' USING ERRCODE = 'integrity_constraint_violation',
        DETAIL = format('A batch cannot move from %s to %s.', OLD.status, NEW.status);
    END IF;
    IF NEW.status IN ('committed', 'discarded')
       AND (app.current_user_id() IS NULL OR NEW.closed_by IS DISTINCT FROM app.current_user_id()) THEN
      RAISE EXCEPTION 'import_closed_own_name' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status = 'committed' AND NEW.dry_run_at IS NULL THEN
      RAISE EXCEPTION 'dry_run_first' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- A batch past its expiry is never committed: its rows are due to be deleted (#150 L2).
    IF NEW.status = 'committed' AND OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'import_expired' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status = 'expired' AND (NEW.closed_by IS NOT NULL OR OLD.expires_at > now()) THEN
      RAISE EXCEPTION 'import_not_expired' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status = 'undone' AND current_user <> 'harbour_import_owner' THEN
      RAISE EXCEPTION 'import_undone_by_function' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER import_batch_guard BEFORE UPDATE ON public.import_batch
  FOR EACH ROW EXECUTE FUNCTION app.import_batch_guard();
--> statement-breakpoint
-- A staged row is never changed (the grants already refuse it; this holds for every role).
CREATE TRIGGER import_row_fixed BEFORE UPDATE ON public.import_row
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- Staged rows go with the batch's closing (rule 25): every row of a batch is deleted in the
-- transaction that commits, discards or expires it, whichever role closes it. Runs as
-- harbour_import_owner, which may delete staged rows and nothing else of the application's.
CREATE OR REPLACE FUNCTION app.import_batch_closed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.import_row r WHERE r.tenant_id = NEW.tenant_id AND r.batch_id = NEW.id;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER import_batch_closed AFTER UPDATE OF status ON public.import_batch
  FOR EACH ROW WHEN (OLD.status = 'staged' AND NEW.status <> 'staged')
  EXECUTE FUNCTION app.import_batch_closed();
--> statement-breakpoint

-- Imported people are tied to the batch that created them (#150 security review M1): a person is
-- given an import batch only as it is created, only while that batch is staged after its dry run
-- (the commit creates people before it closes the batch), and the import batch never changes after.
-- Invoker rights: under the application's row-level security only an importer sees the batch.
CREATE OR REPLACE FUNCTION app.person_import_batch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id THEN
      RAISE EXCEPTION 'import_batch_fixed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.import_batch_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.import_batch b
        WHERE b.id = NEW.import_batch_id AND b.tenant_id = NEW.tenant_id
          AND b.status = 'staged' AND b.dry_run_at IS NOT NULL) THEN
    RAISE EXCEPTION 'import_batch_not_committing' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER person_import_batch_guard BEFORE INSERT OR UPDATE ON public.person
  FOR EACH ROW EXECUTE FUNCTION app.person_import_batch_guard();
--> statement-breakpoint

-- Undo (rules 14 and 24): a holder of platform.import.run, people.person.create and
-- people.person.read across the organisation, in a request scoped to the whole organisation, undoes
-- a committed batch once:
-- - within `import.undo_window_days` of the commit, read here from the rate table for the
--   batch's home as the API reads it (`app.location_rate`), failing closed when there is none;
-- - before any phone may hold its people (#150 clinical review H2): refused once a sync token
--   carrying people at any home was issued in the organisation from one token's lifetime
--   (SYNC_TOKEN_TTL_SECONDS, 900 seconds) before the commit, because a phone that received them
--   can record care for them without a signal, and an undo would strand those entries;
-- - only while every person it created is unchanged (version 1, not soft-deleted) and nothing
--   refers to any of them by a foreign key (a note, task, document, allergy, contact, legal hold).
-- Only people created by this batch are removed (`person.import_batch_id`), and they must be
-- exactly the commit's record ids, the whole batch or nothing: the check is made again by the
-- DELETE itself, so a save that lands first makes the count fall short and the undo is refused.
-- The allergy status checks the commit raised for them (HZ-007) go with them while still open
-- (escalating an overdue one is the system's, not a person's); one someone has started or done
-- refers to its person and refuses the undo. Audited with the count only; audit events about the
-- people stay.
CREATE OR REPLACE FUNCTION app.undo_import_batch(p_batch uuid, p_request_id text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_me uuid := app.current_user_id();
  v_tenant uuid := app.current_tenant_id();
  v_commit uuid;
  v_ids uuid[];
  v_undone timestamptz;
  v_committed timestamptz;
  v_location uuid;
  v_days numeric;
  v_removed integer;
BEGIN
  IF v_me IS NULL OR app.current_scope() IS DISTINCT FROM 'tenant'
     OR NOT app.holds_permission_at('platform.import.run', NULL)
     OR NOT app.holds_permission_at('people.person.create', NULL)
     OR NOT app.holds_permission_at('people.person.read', NULL) THEN
    RAISE EXCEPTION 'missing_permission' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT c.id, c.record_ids, c.undone_at, c.committed_at INTO v_commit, v_ids, v_undone, v_committed
    FROM public.import_commit c
   WHERE c.tenant_id = v_tenant AND c.batch_id = p_batch
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'nothing_to_undo' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_undone IS NOT NULL THEN
    RAISE EXCEPTION 'already_undone' USING ERRCODE = 'check_violation';
  END IF;
  SELECT b.location_id INTO v_location FROM public.import_batch b
   WHERE b.id = p_batch AND b.tenant_id = v_tenant;
  v_days := app.location_rate(v_location, 'import.undo_window_days', now());
  IF v_days IS NULL OR now() > v_committed + make_interval(days => v_days::integer) THEN
    RAISE EXCEPTION 'window_passed' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.audit_event a
        WHERE a.tenant_id = v_tenant AND a.action = 'sync.token.issue'
          AND a.occurred_at >= v_committed - interval '900 seconds'
          AND coalesce(a.scope ->> 'peopleLocations', '0') ~ '^[0-9]+$'
          AND (a.scope ->> 'peopleLocations')::integer > 0) THEN
    RAISE EXCEPTION 'sent_to_devices' USING ERRCODE = 'check_violation';
  END IF;
  BEGIN
    DELETE FROM public.task t
     WHERE t.tenant_id = v_tenant AND t.kind = 'people.allergy_status_check'
       AND t.source_type = 'import_batch' AND t.source_id = p_batch
       AND t.status = 'open' AND t.deleted_at IS NULL;
    DELETE FROM public.person p
     WHERE p.tenant_id = v_tenant AND p.import_batch_id = p_batch AND p.id = ANY (v_ids)
       AND p.version = 1 AND p.deleted_at IS NULL;
    GET DIAGNOSTICS v_removed = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'referenced_since' USING ERRCODE = 'check_violation';
  END;
  IF v_removed <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'changed_since' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.import_commit SET undone_at = now(), undone_by = v_me WHERE id = v_commit;
  UPDATE public.import_batch SET status = 'undone' WHERE id = p_batch AND tenant_id = v_tenant;
  INSERT INTO public.audit_event (tenant_id, actor_tenant_user_id, action, resource_type,
    resource_id, scope, request_id)
  VALUES (v_tenant, v_me, 'platform.import.undone', 'import_batch', p_batch::text,
    jsonb_build_object('records', v_removed), p_request_id);
  RETURN v_removed;
END
$$;
--> statement-breakpoint

-- What harbour_import_owner's functions need, and nothing else. Execute rights are set before the
-- owner changes (ADR-0002).
GRANT USAGE ON SCHEMA public, app TO harbour_import_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, version, deleted_at, import_batch_id), DELETE ON public.person
  TO harbour_import_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, kind, source_type, source_id, status, deleted_at), DELETE
  ON public.task TO harbour_import_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, batch_id), DELETE ON public.import_row TO harbour_import_owner;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, batch_id, record_ids, undone_at, committed_at),
  UPDATE (undone_at, undone_by) ON public.import_commit TO harbour_import_owner;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, status, location_id), UPDATE (status) ON public.import_batch
  TO harbour_import_owner;
--> statement-breakpoint
GRANT SELECT ON public.role_assignment, public.role, public.access_grant, public.rate_table,
  public.location TO harbour_import_owner;
--> statement-breakpoint
GRANT SELECT (tenant_id, action, occurred_at, scope) ON public.audit_event TO harbour_import_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_permission_at(text, uuid) TO harbour_import_owner;
--> statement-breakpoint
GRANT INSERT ON public.audit_event TO harbour_import_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.import_batch_closed(), app.undo_import_batch(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.undo_import_batch(uuid, text) TO harbour_app;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_import_owner;
--> statement-breakpoint
ALTER FUNCTION app.import_batch_closed() OWNER TO harbour_import_owner;
--> statement-breakpoint
ALTER FUNCTION app.undo_import_batch(uuid, text) OWNER TO harbour_import_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_import_owner;