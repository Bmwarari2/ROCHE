CREATE TABLE "supervision_note" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"supervision_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"discussion" text NOT NULL,
	"actions" text,
	"supersedes_id" uuid,
	"written_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "supervision_note_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "supervision_note_supersedes_key" UNIQUE("tenant_id","supersedes_id"),
	CONSTRAINT "supervision_note_discussion" CHECK (length(btrim(discussion)) BETWEEN 10 AND 4000),
	CONSTRAINT "supervision_note_actions" CHECK (actions IS NULL OR length(btrim(actions)) BETWEEN 2 AND 2000),
	CONSTRAINT "supervision_note_not_self" CHECK (written_by <> worker_id)
);
--> statement-breakpoint
ALTER TABLE "supervision_note" ADD CONSTRAINT "supervision_note_supersedes_fk" FOREIGN KEY ("tenant_id","supersedes_id") REFERENCES "public"."supervision_note"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_note" ADD CONSTRAINT "supervision_note_supervision_fk" FOREIGN KEY ("tenant_id","supervision_id") REFERENCES "public"."supervision_record"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_note" ADD CONSTRAINT "supervision_note_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_note" ADD CONSTRAINT "supervision_note_written_by_fk" FOREIGN KEY ("tenant_id","written_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supervision_note_original_key" ON "supervision_note" USING btree ("tenant_id","supervision_id") WHERE supersedes_id IS NULL;--> statement-breakpoint

-- Supervision notes (slice 57; workforce.md sections 2b, 3 and 8; H-692's default, ADR-0114): what
-- was discussed and the actions agreed, likely special category content (health, wellbeing). The
-- ADR-0002 patterns; read by the note's writer, the member it is about (workforce.self.read) and a
-- supervisor for the member (app.supervises_member); never by training, competence or staff file
-- readers, nor by tenant-wide roles (owner, group executive) for that alone; written by the person
-- who held the supervision, in their own name, never about themselves; append-only, a correction
-- being a new note superseding the one before. Runs as harbour_owner.
ALTER TABLE public.supervision_note ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.supervision_note FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.supervision_note AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint

-- Whether the session's member supervises this member of staff: they hold
-- workforce.supervision.manage through a role with no person scope (organisation-wide HR), or
-- through a location role at a location where the member holds a role in force. A tenant-wide role
-- (the owner's, a group executive's) does not count for this alone (security review round 1,
-- finding 2). Definer rights: the member's own assignments are read, which the caller may not see;
-- it answers yes or no only. Portal-mixed roles give nothing, as at sign-in.
CREATE OR REPLACE FUNCTION app.supervises_member(p_worker_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT app.current_user_id() IS NOT NULL AND p_worker_id <> app.current_user_id() AND EXISTS (
    SELECT 1
    FROM public.role_assignment ra
    JOIN public.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
    WHERE ra.tenant_id = app.current_tenant_id()
      AND ra.tenant_user_id = app.current_user_id()
      AND ra.deleted_at IS NULL
      AND r.archived_at IS NULL
      AND ra.valid_from <= now()
      AND (ra.valid_to IS NULL OR ra.valid_to > now())
      AND 'workforce.supervision.manage' = ANY (r.permissions)
      AND NOT (r.permissions && ARRAY['comms.portal.family', 'comms.portal.self', 'comms.feed.read',
        'comms.notification.subscribe', 'comms.visit_booking.request']::text[])
      AND (r.scope_kind::text = 'none'
        OR (r.scope_kind::text = 'location' AND ra.location_id IS NOT NULL AND EXISTS (
          SELECT 1
          FROM public.role_assignment wa
          JOIN public.role wr ON wr.tenant_id = wa.tenant_id AND wr.id = wa.role_id
          WHERE wa.tenant_id = ra.tenant_id
            AND wa.tenant_user_id = p_worker_id
            AND wa.location_id = ra.location_id
            AND wa.deleted_at IS NULL
            AND wr.archived_at IS NULL
            AND wa.valid_from <= now()
            AND (wa.valid_to IS NULL OR wa.valid_to > now())))))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.supervises_member(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.supervises_member(uuid) TO harbour_app;
--> statement-breakpoint

CREATE POLICY supervision_note_read ON public.supervision_note AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (app.is_system()
    OR written_by = app.current_user_id()
    OR app.reads_own_development(worker_id)
    OR app.supervises_member(worker_id));
--> statement-breakpoint
CREATE POLICY supervision_note_insert ON public.supervision_note AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.is_system() OR (app.holds_staff_permission('workforce.supervision.manage')
    AND worker_id <> app.current_user_id() AND written_by = app.current_user_id()));
--> statement-breakpoint
-- Whoever inserts it: the note is about the supervision's own member and written by the person who
-- held it (security review round 1, low 1), and a correction supersedes a note of the same
-- supervision. Invoker rights: a supervision holder reads supervision rows through
-- app.reads_development(), and its writer reads the note it corrects; the system reads them all.
CREATE OR REPLACE FUNCTION app.supervision_note_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.supervision_record s
    WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.supervision_id
      AND s.worker_id = NEW.worker_id AND s.deleted_at IS NULL
      AND (s.held_by = NEW.written_by OR app.is_system())) THEN
    RAISE EXCEPTION 'A supervision note is about the supervision''s member of staff, by whoever held it'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.supervision_note n
    WHERE n.tenant_id = NEW.tenant_id AND n.id = NEW.supersedes_id
      AND n.supervision_id = NEW.supervision_id) THEN
    RAISE EXCEPTION 'A correction supersedes a note of the same supervision'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER supervision_note_guard BEFORE INSERT ON public.supervision_note
  FOR EACH ROW EXECUTE FUNCTION app.supervision_note_guard();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.supervision_note
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.supervision_note
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON public.supervision_note TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.supervision_note FROM harbour_app;
