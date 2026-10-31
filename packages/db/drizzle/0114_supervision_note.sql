CREATE TABLE "supervision_note" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"supervision_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"discussion" text NOT NULL,
	"actions" text,
	"written_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "supervision_note_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "supervision_note_supervision_key" UNIQUE("tenant_id","supervision_id"),
	CONSTRAINT "supervision_note_discussion" CHECK (length(btrim(discussion)) BETWEEN 10 AND 4000),
	CONSTRAINT "supervision_note_actions" CHECK (actions IS NULL OR length(btrim(actions)) BETWEEN 2 AND 2000),
	CONSTRAINT "supervision_note_not_self" CHECK (written_by <> worker_id)
);
--> statement-breakpoint
ALTER TABLE "supervision_note" ADD CONSTRAINT "supervision_note_supervision_fk" FOREIGN KEY ("tenant_id","supervision_id") REFERENCES "public"."supervision_record"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_note" ADD CONSTRAINT "supervision_note_worker_fk" FOREIGN KEY ("tenant_id","worker_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_note" ADD CONSTRAINT "supervision_note_written_by_fk" FOREIGN KEY ("tenant_id","written_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Supervision notes (slice 57; workforce.md sections 2b, 3 and 8; H-692's default, ADR-0114): what
-- was discussed and the actions agreed, likely special category content. The ADR-0002 patterns;
-- read only by holders of workforce.supervision.manage (never about themselves) and by the member
-- it is about with workforce.self.read, never by training, competence or staff file readers; written
-- once, by a supervision holder in their own name, never about themselves; append-only. Runs as
-- harbour_owner.
ALTER TABLE public.supervision_note ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.supervision_note FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.supervision_note AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY supervision_note_read ON public.supervision_note AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (app.is_system()
    OR (app.holds_staff_permission('workforce.supervision.manage')
        AND worker_id <> app.current_user_id())
    OR app.reads_own_development(worker_id));
--> statement-breakpoint
CREATE POLICY supervision_note_insert ON public.supervision_note AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (app.is_system() OR (app.holds_staff_permission('workforce.supervision.manage')
    AND worker_id <> app.current_user_id() AND written_by = app.current_user_id()));
--> statement-breakpoint
-- The note is about the supervision's own member, whoever inserts it (invoker rights: a supervision
-- holder reads supervision rows through app.reads_development(); the system reads them all).
CREATE OR REPLACE FUNCTION app.supervision_note_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.supervision_record s
    WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.supervision_id
      AND s.worker_id = NEW.worker_id) THEN
    RAISE EXCEPTION 'A supervision note is about the supervision''s member of staff'
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
