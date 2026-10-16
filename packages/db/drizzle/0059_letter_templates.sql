CREATE TABLE "letter" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"template_version_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"recipient_kind" text NOT NULL,
	"contact_id" uuid,
	"channel" text NOT NULL,
	"personal_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"special_category" boolean NOT NULL,
	"results_to_follow" boolean DEFAULT false NOT NULL,
	"incident_id" uuid,
	"incident_serious" boolean DEFAULT false NOT NULL,
	"document_id" uuid,
	"delivery_reference" text,
	"sent_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_class" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "letter_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "letter_channel" CHECK (channel IN ('letter', 'email')),
	CONSTRAINT "letter_recipient" CHECK (recipient_kind IN ('person', 'contact') AND (recipient_kind = 'contact') = (contact_id IS NOT NULL)),
	CONSTRAINT "letter_serious" CHECK (NOT incident_serious OR incident_id IS NOT NULL),
	CONSTRAINT "letter_retention" CHECK (retention_class = CASE WHEN incident_serious THEN 'serious_incident' ELSE 'care_record' END),
	CONSTRAINT "letter_delivery" CHECK ((channel = 'letter' OR document_id IS NULL) AND (channel = 'email' OR delivery_reference IS NULL)
        AND (channel = 'letter' OR NOT special_category)),
	CONSTRAINT "letter_fields" CHECK (array_position(personal_fields, NULL) IS NULL AND cardinality(personal_fields) <= 100)
);
--> statement-breakpoint
CREATE TABLE "letter_template" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "letter_template_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "letter_template_kind" CHECK (kind IN ('admission', 'fee_review', 'incident_follow_up', 'duty_of_candour', 'general')),
	CONSTRAINT "letter_template_channel" CHECK (channel IN ('letter', 'email')),
	CONSTRAINT "letter_template_letter_only" CHECK (channel = 'letter' OR kind NOT IN ('incident_follow_up', 'duty_of_candour'))
);
--> statement-breakpoint
CREATE TABLE "letter_template_version" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"template_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"name" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"author_id" uuid DEFAULT app.current_user_id() NOT NULL,
	"contributor_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"retired_by" uuid,
	"retired_at" timestamp with time zone,
	"retirement_reason" text,
	"discard_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "letter_template_version_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "letter_template_version_number_key" UNIQUE("tenant_id","template_id","version_number"),
	CONSTRAINT "letter_template_version_state" CHECK (state IN ('draft', 'approved', 'superseded', 'retired', 'discarded')),
	CONSTRAINT "letter_template_version_number" CHECK (version_number >= 1),
	CONSTRAINT "letter_template_version_text" CHECK (char_length(btrim(name)) BETWEEN 1 AND 200 AND char_length(body) BETWEEN 1 AND 20000
        AND (subject IS NULL OR char_length(subject) BETWEEN 1 AND 80)),
	CONSTRAINT "letter_template_version_approved" CHECK ((state IN ('approved', 'superseded', 'retired')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
	CONSTRAINT "letter_template_version_retired" CHECK ((state = 'retired') = (retired_by IS NOT NULL AND retired_at IS NOT NULL
        AND retirement_reason IS NOT NULL AND btrim(retirement_reason) <> '')),
	CONSTRAINT "letter_template_version_discarded" CHECK ((state = 'discarded') = (discard_reason IS NOT NULL AND btrim(discard_reason) <> ''))
);
--> statement-breakpoint
ALTER TABLE "letter" ADD CONSTRAINT "letter_template_version_fk" FOREIGN KEY ("tenant_id","template_version_id") REFERENCES "public"."letter_template_version"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter" ADD CONSTRAINT "letter_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter" ADD CONSTRAINT "letter_contact_fk" FOREIGN KEY ("tenant_id","person_id","contact_id") REFERENCES "public"."contact"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter" ADD CONSTRAINT "letter_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incident"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter" ADD CONSTRAINT "letter_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter" ADD CONSTRAINT "letter_sent_by_fk" FOREIGN KEY ("tenant_id","sent_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter_template_version" ADD CONSTRAINT "letter_template_version_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."letter_template"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter_template_version" ADD CONSTRAINT "letter_template_version_author_fk" FOREIGN KEY ("tenant_id","author_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter_template_version" ADD CONSTRAINT "letter_template_version_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter_template_version" ADD CONSTRAINT "letter_template_version_retired_by_fk" FOREIGN KEY ("tenant_id","retired_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "letter_person_idx" ON "letter" USING btree ("tenant_id","person_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "letter_template_version_one_draft_key" ON "letter_template_version" USING btree ("tenant_id","template_id") WHERE state = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "letter_template_version_one_approved_key" ON "letter_template_version" USING btree ("tenant_id","template_id") WHERE state = 'approved';--> statement-breakpoint

-- Letter and email templates and letters (comms.md rules 18 to 25; COMMS-007; ADR-0051; HZ-051):
-- the ADR-0002 patterns; templates are the organisation's (read by holders of the template or
-- letter permissions anywhere, written by holders of write); a version moves only along
-- TEMPLATE_WORKFLOW, is fixed once approved and is approved never by its author or an editor; a
-- letter follows its person, is made only from an approved version by a holder of
-- comms.letter.manage where the person lives, to them or one of their own contacts, and is
-- append-only. Runs as harbour_owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['letter_template', 'letter_template_version', 'letter'] LOOP
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

CREATE OR REPLACE FUNCTION app.letter_template_permitted() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.is_system()
    OR app.holds_permission_anywhere('comms.template.write')
    OR app.holds_permission_anywhere('comms.template.approve')
    OR app.holds_permission_anywhere('comms.letter.manage')
$$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['letter_template', 'letter_template_version'] LOOP
    EXECUTE format(
      'CREATE POLICY letter_template_permission ON public.%I AS RESTRICTIVE FOR ALL '
      'TO harbour_app USING (app.letter_template_permitted()) '
      'WITH CHECK (app.letter_template_permitted())', t);
    EXECUTE format(
      'CREATE POLICY letter_template_write ON public.%I AS RESTRICTIVE FOR INSERT '
      'TO harbour_app WITH CHECK (app.holds_permission_anywhere(''comms.template.write''))', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- A template is made with no version in use; its kind and channel are fixed; the version in use
-- changes only from the version workflow below.
CREATE OR REPLACE FUNCTION app.letter_template_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.current_version_id IS NOT NULL OR NEW.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'A template starts with no version in use'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.kind, NEW.channel, NEW.deleted_at) IS DISTINCT FROM (OLD.kind, OLD.channel, OLD.deleted_at) THEN
    RAISE EXCEPTION 'A template keeps its kind and channel; make a new template instead'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'The version in use changes only by approving or retiring a version'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER letter_template_guard BEFORE INSERT OR UPDATE ON public.letter_template
  FOR EACH ROW EXECUTE FUNCTION app.letter_template_guard();
--> statement-breakpoint

-- A version starts as a draft in its author's name, numbered next, with a subject exactly when
-- the template is an email.
CREATE OR REPLACE FUNCTION app.letter_template_subject_fits(p_template_id uuid, p_subject text)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.letter_template t
                 WHERE t.id = p_template_id AND (t.channel = 'email') = (p_subject IS NOT NULL))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.letter_template_version_draft() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM 'draft'
     OR num_nonnulls(NEW.approved_by, NEW.approved_at, NEW.retired_by, NEW.retired_at,
          NEW.retirement_reason, NEW.discard_reason, NEW.deleted_at) > 0
     OR app.current_user_id() IS NULL OR NEW.author_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A template version starts as a draft in its author''s name'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT app.letter_template_subject_fits(NEW.template_id, NEW.subject) THEN
    RAISE EXCEPTION 'An email template has a subject and a letter template has none'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.version_number := coalesce((SELECT max(v.version_number) FROM public.letter_template_version v
                                   WHERE v.template_id = NEW.template_id), 0) + 1;
  NEW.contributor_ids := ARRAY[NEW.author_id];
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER letter_template_version_draft BEFORE INSERT ON public.letter_template_version
  FOR EACH ROW EXECUTE FUNCTION app.letter_template_version_draft();
--> statement-breakpoint

-- HZ-051 rules 22 and 23: a draft changes (its editors join the contributors), is approved or
-- discarded; approval is of the content as it stands, different from the version in use, by a
-- holder of approve who did not write or edit it, supersedes the version in use and puts this one
-- in use; an approved version is fixed and may only be retired (with a reason, by a holder of
-- approve) or superseded by the next approval.
CREATE OR REPLACE FUNCTION app.letter_template_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := app.current_user_id();
  v_current record;
BEGIN
  IF (NEW.template_id, NEW.version_number, NEW.author_id, NEW.created_at, NEW.created_by,
      NEW.deleted_at)
     IS DISTINCT FROM (OLD.template_id, OLD.version_number, OLD.author_id, OLD.created_at,
      OLD.created_by, OLD.deleted_at) THEN
    RAISE EXCEPTION 'A template version keeps its template, number and author'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state IN ('superseded', 'retired', 'discarded') THEN
    RAISE EXCEPTION 'A % template version is final', OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.state = 'approved' THEN
    IF (NEW.name, NEW.subject, NEW.body, NEW.contributor_ids, NEW.approved_by, NEW.approved_at,
        NEW.discard_reason)
       IS DISTINCT FROM (OLD.name, OLD.subject, OLD.body, OLD.contributor_ids, OLD.approved_by,
        OLD.approved_at, OLD.discard_reason) THEN
      RAISE EXCEPTION 'An approved template version is fixed; start a new draft'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.state = 'superseded' THEN
      IF pg_trigger_depth() < 2 OR num_nonnulls(NEW.retired_by, NEW.retired_at,
           NEW.retirement_reason) > 0 THEN
        RAISE EXCEPTION 'A template version is superseded only by approving the next one'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.state = 'retired' THEN
      IF v_actor IS NULL OR NEW.retired_by IS DISTINCT FROM v_actor
         OR NOT app.holds_permission_anywhere('comms.template.approve') THEN
        RAISE EXCEPTION 'A template version is retired by a holder of comms.template.approve, in their own name'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.retired_at := now();
      UPDATE public.letter_template SET current_version_id = NULL
        WHERE id = NEW.template_id AND current_version_id = NEW.id;
      RETURN NEW;
    END IF;
    IF NEW.state IS DISTINCT FROM 'approved'
       OR (NEW.retired_by, NEW.retired_at, NEW.retirement_reason)
         IS DISTINCT FROM (OLD.retired_by, OLD.retired_at, OLD.retirement_reason) THEN
      RAISE EXCEPTION 'An approved template version cannot move to %', NEW.state
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- A draft.
  IF num_nonnulls(NEW.retired_by, NEW.retired_at, NEW.retirement_reason) > 0 THEN
    RAISE EXCEPTION 'Only an approved template version is retired'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'draft' THEN
    IF (NEW.approved_by, NEW.approved_at, NEW.discard_reason)
       IS DISTINCT FROM (OLD.approved_by, OLD.approved_at, OLD.discard_reason) THEN
      RAISE EXCEPTION 'A draft changes only its name, subject and body'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF v_actor IS NULL OR NOT app.holds_permission_anywhere('comms.template.write') THEN
      RAISE EXCEPTION 'Only a holder of comms.template.write changes a draft'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app.letter_template_subject_fits(NEW.template_id, NEW.subject) THEN
      RAISE EXCEPTION 'An email template has a subject and a letter template has none'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.contributor_ids := CASE WHEN v_actor = ANY (OLD.contributor_ids) THEN OLD.contributor_ids
                                ELSE array_append(OLD.contributor_ids, v_actor) END;
    RETURN NEW;
  END IF;
  IF (NEW.name, NEW.subject, NEW.body, NEW.contributor_ids)
     IS DISTINCT FROM (OLD.name, OLD.subject, OLD.body, OLD.contributor_ids) THEN
    RAISE EXCEPTION 'Change a draft and move it separately'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'discarded' THEN
    IF (NEW.approved_by, NEW.approved_at) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at)
       OR v_actor IS NULL OR NOT app.holds_permission_anywhere('comms.template.write') THEN
      RAISE EXCEPTION 'A draft is discarded, with its reason, by a holder of comms.template.write'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'A draft cannot move to %', NEW.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_actor IS NULL OR NEW.approved_by IS DISTINCT FROM v_actor
     OR v_actor = OLD.author_id OR v_actor = ANY (OLD.contributor_ids)
     OR NOT app.holds_permission_anywhere('comms.template.approve') THEN
    RAISE EXCEPTION 'A template version is approved by a holder of comms.template.approve who did not write or edit it, in their own name'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT v.id, v.name, v.subject, v.body INTO v_current FROM public.letter_template_version v
    WHERE v.template_id = OLD.template_id AND v.state = 'approved' AND v.id <> OLD.id FOR UPDATE;
  IF v_current.id IS NOT NULL
     AND (v_current.name, v_current.subject, v_current.body)
       IS NOT DISTINCT FROM (OLD.name, OLD.subject, OLD.body) THEN
    RAISE EXCEPTION 'A new version differs from the one in use'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.approved_at := now();
  IF v_current.id IS NOT NULL THEN
    UPDATE public.letter_template_version SET state = 'superseded' WHERE id = v_current.id;
  END IF;
  UPDATE public.letter_template SET current_version_id = NEW.id WHERE id = NEW.template_id;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER letter_template_version_guard BEFORE UPDATE ON public.letter_template_version
  FOR EACH ROW EXECUTE FUNCTION app.letter_template_version_guard();
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['letter_template', 'letter_template_version'] LOOP
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- A letter follows its person, and is made in the sender's name by a holder of
-- comms.letter.manage where the person lives.
CREATE POLICY letter_scope ON public.letter AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner
  USING (app.person_visible(person_id)) WITH CHECK (app.person_visible(person_id));
--> statement-breakpoint
CREATE POLICY letter_send ON public.letter AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (sent_by = app.current_user_id() AND app.holds_permission_at('comms.letter.manage',
    (SELECT p.location_id FROM public.person p WHERE p.id = person_id)));
--> statement-breakpoint

-- HZ-051 rule 24: only from an approved version, on its template's channel, now, with the
-- rendered document (a letter) being one of the person's own.
CREATE OR REPLACE FUNCTION app.letter_send() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_version record;
BEGIN
  SELECT v.state, t.channel INTO v_version FROM public.letter_template_version v
    JOIN public.letter_template t ON t.id = v.template_id
    WHERE v.id = NEW.template_version_id FOR SHARE OF v;
  IF NOT FOUND OR v_version.state IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'A letter is made only from an approved template version'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.channel IS DISTINCT FROM v_version.channel THEN
    RAISE EXCEPTION 'A letter goes on its template''s channel'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.document_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.document d WHERE d.id = NEW.document_id AND d.person_id = NEW.person_id) THEN
    RAISE EXCEPTION 'A letter''s document is one of the person''s own'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF app.current_user_id() IS NULL OR NEW.sent_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A letter is sent in the sender''s own name'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.sent_at := now();
  NEW.created_at := now();
  NEW.created_by := NEW.sent_by;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER letter_send BEFORE INSERT ON public.letter
  FOR EACH ROW EXECUTE FUNCTION app.letter_send();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.letter
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.letter
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.letter_template, public.letter_template_version TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.letter TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.letter FROM harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.letter_template, public.letter_template_version FROM harbour_app;
