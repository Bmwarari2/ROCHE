CREATE TABLE "evidence_pack" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_organisation" text NOT NULL,
	"recipient_email" text NOT NULL,
	"purpose" text NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date NOT NULL,
	"location_ids" uuid[] NOT NULL,
	"quality_statement_ids" text[],
	"person_ids" uuid[] NOT NULL,
	"staff_names" text DEFAULT 'role_only' NOT NULL,
	"composed_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"composed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"editor_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"watermark" text NOT NULL,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"discarded_by" uuid,
	"discarded_at" timestamp with time zone,
	"discard_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "evidence_pack_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "evidence_pack_state" CHECK (state IN ('draft', 'released', 'revoked', 'discarded')),
	CONSTRAINT "evidence_pack_staff_names" CHECK (staff_names IN ('role_only', 'include')),
	CONSTRAINT "evidence_pack_dates" CHECK (date_from <= date_to),
	CONSTRAINT "evidence_pack_scope" CHECK (cardinality(location_ids) > 0 AND cardinality(person_ids) > 0
        AND array_position(location_ids, NULL) IS NULL AND array_position(person_ids, NULL) IS NULL),
	CONSTRAINT "evidence_pack_recipient" CHECK (btrim(recipient_name) <> '' AND btrim(recipient_organisation) <> ''
        AND recipient_email = lower(btrim(recipient_email))
        AND recipient_email ~ '^[!-~]+@[!-~]+\.[!-~]+$'),
	CONSTRAINT "evidence_pack_purpose" CHECK (char_length(btrim(purpose)) >= 15),
	CONSTRAINT "evidence_pack_watermark" CHECK (btrim(watermark) <> ''),
	CONSTRAINT "evidence_pack_released" CHECK ((state IN ('released', 'revoked')) = (released_by IS NOT NULL AND released_at IS NOT NULL)),
	CONSTRAINT "evidence_pack_revoked" CHECK ((state = 'revoked') = (revoked_by IS NOT NULL AND revoked_at IS NOT NULL
        AND revocation_reason IS NOT NULL AND btrim(revocation_reason) <> '')),
	CONSTRAINT "evidence_pack_discarded" CHECK ((state = 'discarded') = (discarded_by IS NOT NULL AND discarded_at IS NOT NULL
        AND discard_reason IS NOT NULL AND btrim(discard_reason) <> ''))
);
--> statement-breakpoint
CREATE TABLE "evidence_pack_bundle" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"pack_id" uuid NOT NULL,
	"content" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deletion_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "evidence_pack_bundle_pack_key" UNIQUE("tenant_id","pack_id"),
	CONSTRAINT "evidence_pack_bundle_deleted" CHECK ((deleted_at IS NULL) = (content IS NOT NULL)
        AND (deleted_at IS NULL) = (deletion_reason IS NULL)
        AND (deletion_reason IS NULL
          OR deletion_reason IN ('link_ended', 'pack_revoked', 'pack_discarded'))
        AND (content IS NULL OR jsonb_typeof(content) = 'object'))
);
--> statement-breakpoint
CREATE TABLE "evidence_pack_item" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"pack_id" uuid NOT NULL,
	"supersedes_id" uuid,
	"record_type" text NOT NULL,
	"record_id" uuid NOT NULL,
	"record_version" integer NOT NULL,
	"title" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"quality_statement_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"exclusion_reason" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redacted_by" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "evidence_pack_item_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "evidence_pack_item_record_type" CHECK (record_type IN ('incident', 'care_note', 'observation', 'body_map_mark', 'assessment', 'care_plan_section', 'risk_assessment', 'activity_record', 'visit_log', 'advance_care_record')),
	CONSTRAINT "evidence_pack_item_exclusion" CHECK (exclusion_reason IS NULL OR (exclusion_reason IN ('restricted_record', 'outside_date_range', 'location_not_requested', 'not_tagged', 'statement_not_requested', 'person_not_in_scope')
        AND fields = '[]'::jsonb AND supersedes_id IS NULL)),
	CONSTRAINT "evidence_pack_item_fields" CHECK (jsonb_typeof(fields) = 'array'),
	CONSTRAINT "evidence_pack_item_version" CHECK (record_version >= 1)
);
--> statement-breakpoint
CREATE TABLE "evidence_pack_link" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"pack_id" uuid NOT NULL,
	"recipient_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"issued_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replaces_link_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revocation_reason" text,
	"failed_code_attempts" integer DEFAULT 0 NOT NULL,
	"last_opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "evidence_pack_link_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "evidence_pack_link_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "evidence_pack_link_token_hash" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "evidence_pack_link_expiry" CHECK (expires_at > issued_at),
	CONSTRAINT "evidence_pack_link_attempts" CHECK (failed_code_attempts >= 0),
	CONSTRAINT "evidence_pack_link_revoked" CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL)
        AND (revocation_reason IS NULL
          OR revocation_reason IN ('pack_revoked', 'reissued')))
);
--> statement-breakpoint
CREATE TABLE "evidence_pack_link_code" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"link_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "evidence_pack_link_code_hash" CHECK (code_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "evidence_pack_link_code_valid" CHECK (valid_until > issued_at AND valid_until <= issued_at + interval '10 minutes'),
	CONSTRAINT "evidence_pack_link_code_used" CHECK (used_at IS NULL OR used_at >= issued_at)
);
--> statement-breakpoint
CREATE TABLE "statement_of_purpose_version" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"version_number" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"kind" text NOT NULL,
	"content" jsonb NOT NULL,
	"author_id" uuid DEFAULT app.current_user_id() NOT NULL,
	"contributor_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"supersedes_id" uuid,
	"change_summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"registration_prompts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"notification_due_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"notified_by" uuid,
	"notification_evidence" text,
	"discard_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "statement_of_purpose_version_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "statement_of_purpose_version_number_key" UNIQUE("tenant_id","version_number"),
	CONSTRAINT "statement_of_purpose_version_state" CHECK (state IN ('draft', 'approved', 'superseded', 'discarded')),
	CONSTRAINT "statement_of_purpose_version_kind" CHECK (kind IN ('baseline', 'revision')),
	CONSTRAINT "statement_of_purpose_version_number" CHECK (version_number >= 1),
	CONSTRAINT "statement_of_purpose_version_json" CHECK (jsonb_typeof(content) = 'object' AND jsonb_typeof(change_summary) = 'array'
        AND jsonb_typeof(registration_prompts) = 'array'),
	CONSTRAINT "statement_of_purpose_version_approved" CHECK ((state IN ('approved', 'superseded')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
	CONSTRAINT "statement_of_purpose_version_notification_due" CHECK ((kind = 'revision' AND approved_at IS NOT NULL) = (notification_due_at IS NOT NULL)),
	CONSTRAINT "statement_of_purpose_version_notified" CHECK ((notified_at IS NULL) = (notified_by IS NULL)
        AND (notified_at IS NULL) = (notification_evidence IS NULL)
        AND (notification_evidence IS NULL OR btrim(notification_evidence) <> '')
        AND (notified_at IS NULL OR (kind = 'revision' AND notified_at >= approved_at))),
	CONSTRAINT "statement_of_purpose_version_discarded" CHECK ((state = 'discarded') = (discard_reason IS NOT NULL AND btrim(discard_reason) <> ''))
);
--> statement-breakpoint
ALTER TABLE "evidence_pack" ADD CONSTRAINT "evidence_pack_composed_by_fk" FOREIGN KEY ("tenant_id","composed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_pack" ADD CONSTRAINT "evidence_pack_released_by_fk" FOREIGN KEY ("tenant_id","released_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_pack" ADD CONSTRAINT "evidence_pack_revoked_by_fk" FOREIGN KEY ("tenant_id","revoked_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_pack" ADD CONSTRAINT "evidence_pack_discarded_by_fk" FOREIGN KEY ("tenant_id","discarded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_pack_bundle" ADD CONSTRAINT "evidence_pack_bundle_pack_fk" FOREIGN KEY ("tenant_id","pack_id") REFERENCES "public"."evidence_pack"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_pack_item" ADD CONSTRAINT "evidence_pack_item_pack_fk" FOREIGN KEY ("tenant_id","pack_id") REFERENCES "public"."evidence_pack"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_pack_item" ADD CONSTRAINT "evidence_pack_item_supersedes_fk" FOREIGN KEY ("tenant_id","supersedes_id") REFERENCES "public"."evidence_pack_item"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_pack_link" ADD CONSTRAINT "evidence_pack_link_pack_fk" FOREIGN KEY ("tenant_id","pack_id") REFERENCES "public"."evidence_pack"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_pack_link" ADD CONSTRAINT "evidence_pack_link_replaces_fk" FOREIGN KEY ("tenant_id","replaces_link_id") REFERENCES "public"."evidence_pack_link"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_pack_link" ADD CONSTRAINT "evidence_pack_link_issued_by_fk" FOREIGN KEY ("tenant_id","issued_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_pack_link" ADD CONSTRAINT "evidence_pack_link_revoked_by_fk" FOREIGN KEY ("tenant_id","revoked_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_pack_link_code" ADD CONSTRAINT "evidence_pack_link_code_link_fk" FOREIGN KEY ("tenant_id","link_id") REFERENCES "public"."evidence_pack_link"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_of_purpose_version" ADD CONSTRAINT "statement_of_purpose_version_supersedes_fk" FOREIGN KEY ("tenant_id","supersedes_id") REFERENCES "public"."statement_of_purpose_version"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_of_purpose_version" ADD CONSTRAINT "statement_of_purpose_version_author_fk" FOREIGN KEY ("tenant_id","author_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_of_purpose_version" ADD CONSTRAINT "statement_of_purpose_version_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_of_purpose_version" ADD CONSTRAINT "statement_of_purpose_version_notified_by_fk" FOREIGN KEY ("tenant_id","notified_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_pack_state_idx" ON "evidence_pack" USING btree ("tenant_id","state","composed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_pack_item_supersedes_key" ON "evidence_pack_item" USING btree ("supersedes_id");--> statement-breakpoint
CREATE INDEX "evidence_pack_item_pack_idx" ON "evidence_pack_item" USING btree ("tenant_id","pack_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_pack_link_live_key" ON "evidence_pack_link" USING btree ("tenant_id","pack_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_pack_link_replaces_key" ON "evidence_pack_link" USING btree ("replaces_link_id");--> statement-breakpoint
CREATE INDEX "evidence_pack_link_code_link_idx" ON "evidence_pack_link_code" USING btree ("tenant_id","link_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_of_purpose_version_one_draft_key" ON "statement_of_purpose_version" USING btree ("tenant_id") WHERE state = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "statement_of_purpose_version_one_approved_key" ON "statement_of_purpose_version" USING btree ("tenant_id") WHERE state = 'approved';--> statement-breakpoint

-- Evidence packs and the statement of purpose (slice 11; quality.md sections 2 to 4; ADR-0050;
-- hazards HZ-011 and HZ-050): the ADR-0002 patterns, with each request in the scope of its
-- permission (ADR-0071); the workflow guards; separation of duties (nobody who shaped a pack
-- releases it or issues its link; nobody who wrote a statement approves it); hashed tokens and
-- codes; failed attempts that never go down; and a definer lookup of a link by its token, owned by
-- its own NOLOGIN role, harbour_evidence_link_reader. Runs as harbour_owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['evidence_pack', 'evidence_pack_item', 'evidence_pack_link',
      'evidence_pack_link_code', 'evidence_pack_bundle', 'statement_of_purpose_version'] LOOP
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

-- The system: a job or a public link route, with no member and the organisation's view.
CREATE OR REPLACE FUNCTION app.is_system() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_user_id() IS NULL AND app.current_scope() = 'tenant'
$$;
--> statement-breakpoint

-- Whether the session's member holds a permission across the organisation or at any location
-- (the statement of purpose belongs to the provider, not to one location).
CREATE OR REPLACE FUNCTION app.holds_permission_anywhere(p_permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.holds_permission_at(p_permission, NULL)
    OR EXISTS (SELECT 1 FROM public.location l
               WHERE l.tenant_id = app.current_tenant_id()
                 AND app.holds_permission_at(p_permission, l.id))
$$;
--> statement-breakpoint

-- A rate-table figure for the organisation (its own row first, then England's, the UK's and all),
-- on the UK date of p_on; null when there is none. England until the nation packs.
CREATE OR REPLACE FUNCTION app.quality_rate(p_key text, p_on timestamptz) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT r.value FROM public.rate_table r
  WHERE r.key = p_key AND r.nation IN ('england', 'uk', 'all')
    AND r.valid_from <= (p_on AT TIME ZONE 'Europe/London')::date
    AND (r.valid_to IS NULL OR r.valid_to > (p_on AT TIME ZONE 'Europe/London')::date)
    AND (r.tenant_id IS NULL OR r.tenant_id = app.current_tenant_id())
  ORDER BY r.tenant_id IS NOT NULL DESC,
    CASE r.nation WHEN 'england' THEN 3 WHEN 'uk' THEN 2 ELSE 1 END DESC
  LIMIT 1
$$;
--> statement-breakpoint

-- A pack follows its locations and its people (quality.md section 2): tenant-wide scope, or
-- location scope covering every one of its locations, and then only when the caller can see every
-- person in its scope. Invoker rights, so it can never widen access.
CREATE OR REPLACE FUNCTION app.evidence_pack_visible(p_location_ids uuid[], p_person_ids uuid[])
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE app.current_scope()
      WHEN 'tenant' THEN true
      WHEN 'locations' THEN p_location_ids <@ app.current_location_ids()
      ELSE false
    END
    AND NOT EXISTS (
      SELECT 1 FROM unnest(p_person_ids) AS pp(id) WHERE NOT app.person_visible(pp.id))
$$;
--> statement-breakpoint
-- The permission as well as its scope: compose or release at every one of the pack's locations.
CREATE OR REPLACE FUNCTION app.evidence_pack_permitted(p_location_ids uuid[]) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.is_system() OR NOT EXISTS (
    SELECT 1 FROM unnest(p_location_ids) AS l(id)
    WHERE NOT (app.holds_permission_at('quality.evidence_pack.compose', l.id)
               OR app.holds_permission_at('quality.evidence_pack.release', l.id)))
$$;
--> statement-breakpoint
CREATE POLICY evidence_pack_scope ON public.evidence_pack AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.evidence_pack_visible(location_ids, person_ids))
  WITH CHECK (app.evidence_pack_visible(location_ids, person_ids));
--> statement-breakpoint
CREATE POLICY evidence_pack_permission ON public.evidence_pack AS RESTRICTIVE FOR ALL
  TO harbour_app
  USING (app.evidence_pack_permitted(location_ids))
  WITH CHECK (app.evidence_pack_permitted(location_ids));
--> statement-breakpoint
-- Composing is in the composer's own name, by a holder of compose at every location.
CREATE POLICY evidence_pack_compose ON public.evidence_pack AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (composed_by = app.current_user_id() AND NOT EXISTS (
    SELECT 1 FROM unnest(location_ids) AS l(id)
    WHERE NOT app.holds_permission_at('quality.evidence_pack.compose', l.id)));
--> statement-breakpoint

-- Items, links, codes and bundles follow their pack (invoker rights: the pack's own policies).
CREATE OR REPLACE FUNCTION app.evidence_pack_reachable(p_pack_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.evidence_pack p WHERE p.id = p_pack_id)
$$;
--> statement-breakpoint
CREATE POLICY evidence_pack_item_scope ON public.evidence_pack_item AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.evidence_pack_reachable(pack_id)) WITH CHECK (app.evidence_pack_reachable(pack_id));
--> statement-breakpoint
CREATE POLICY evidence_pack_link_scope ON public.evidence_pack_link AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.evidence_pack_reachable(pack_id)) WITH CHECK (app.evidence_pack_reachable(pack_id));
--> statement-breakpoint
CREATE POLICY evidence_pack_bundle_scope ON public.evidence_pack_bundle AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.evidence_pack_reachable(pack_id)) WITH CHECK (app.evidence_pack_reachable(pack_id));
--> statement-breakpoint
CREATE POLICY evidence_pack_link_code_scope ON public.evidence_pack_link_code AS RESTRICTIVE
  FOR ALL TO harbour_app, harbour_owner
  USING (EXISTS (SELECT 1 FROM public.evidence_pack_link k WHERE k.id = link_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.evidence_pack_link k WHERE k.id = link_id));
--> statement-breakpoint

-- Everyone who shaped a pack (`evidencePackContributors`): the composer, every editor, everyone who
-- redacted a field by hand and everyone who added an item.
CREATE OR REPLACE FUNCTION app.evidence_pack_contributors(p_pack_id uuid) RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT ARRAY(
    SELECT DISTINCT c FROM (
      SELECT p.composed_by AS c FROM public.evidence_pack p WHERE p.id = p_pack_id
      UNION ALL SELECT unnest(p.editor_ids) FROM public.evidence_pack p WHERE p.id = p_pack_id
      UNION ALL SELECT unnest(i.redacted_by) FROM public.evidence_pack_item i WHERE i.pack_id = p_pack_id
      UNION ALL SELECT i.created_by FROM public.evidence_pack_item i WHERE i.pack_id = p_pack_id
    ) AS x WHERE c IS NOT NULL ORDER BY c)
$$;
--> statement-breakpoint

-- A pack is composed as a draft, now, with nothing released, revoked or discarded.
CREATE OR REPLACE FUNCTION app.evidence_pack_compose() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM 'draft' OR cardinality(NEW.editor_ids) > 0
     OR num_nonnulls(NEW.released_by, NEW.released_at, NEW.revoked_by, NEW.revoked_at,
          NEW.revocation_reason, NEW.discarded_by, NEW.discarded_at, NEW.discard_reason,
          NEW.deleted_at) > 0 THEN
    RAISE EXCEPTION 'An evidence pack is composed as a draft, with nothing released, revoked or discarded'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.composed_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_pack_compose BEFORE INSERT ON public.evidence_pack
  FOR EACH ROW EXECUTE FUNCTION app.evidence_pack_compose();
--> statement-breakpoint

-- HZ-050: the request is fixed once composed; a draft gains editors only; it moves only along
-- EVIDENCE_PACK_WORKFLOW, in the name of the member moving it; it is released only with an item
-- in it and never by anyone who shaped it, by a holder of release at every location; revoked and
-- discarded packs are final; nothing is ever soft-deleted.
CREATE OR REPLACE FUNCTION app.evidence_pack_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := app.current_user_id();
BEGIN
  IF (NEW.recipient_name, NEW.recipient_organisation, NEW.recipient_email, NEW.purpose,
      NEW.date_from, NEW.date_to, NEW.location_ids, NEW.quality_statement_ids, NEW.person_ids,
      NEW.staff_names, NEW.composed_by, NEW.composed_at, NEW.watermark, NEW.deleted_at)
     IS DISTINCT FROM (OLD.recipient_name, OLD.recipient_organisation, OLD.recipient_email,
      OLD.purpose, OLD.date_from, OLD.date_to, OLD.location_ids, OLD.quality_statement_ids,
      OLD.person_ids, OLD.staff_names, OLD.composed_by, OLD.composed_at, OLD.watermark,
      OLD.deleted_at) THEN
    RAISE EXCEPTION 'An evidence pack''s request is fixed once composed; compose a new pack instead'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state IN ('revoked', 'discarded') THEN
    RAISE EXCEPTION 'A % evidence pack is final', OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.editor_ids IS DISTINCT FROM OLD.editor_ids
     AND (OLD.state <> 'draft' OR NOT (OLD.editor_ids <@ NEW.editor_ids)) THEN
    RAISE EXCEPTION 'A draft evidence pack only gains editors'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    IF (NEW.released_by, NEW.released_at, NEW.revoked_by, NEW.revoked_at, NEW.revocation_reason,
        NEW.discarded_by, NEW.discarded_at, NEW.discard_reason)
       IS DISTINCT FROM (OLD.released_by, OLD.released_at, OLD.revoked_by, OLD.revoked_at,
        OLD.revocation_reason, OLD.discarded_by, OLD.discarded_at, OLD.discard_reason) THEN
      RAISE EXCEPTION 'An evidence pack''s release, revocation or discard is set when it moves'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.state, NEW.state) NOT IN (('draft', 'released'), ('draft', 'discarded'),
       ('released', 'revoked')) THEN
    RAISE EXCEPTION 'An evidence pack cannot move from % to %', OLD.state, NEW.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.editor_ids IS DISTINCT FROM OLD.editor_ids THEN
    RAISE EXCEPTION 'Edit a draft and move it separately'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'released' THEN
    IF v_actor IS NULL OR NEW.released_by IS DISTINCT FROM v_actor
       OR num_nonnulls(NEW.revoked_by, NEW.revoked_at, NEW.discarded_by, NEW.discarded_at) > 0 THEN
      RAISE EXCEPTION 'An evidence pack is released in the name of the member releasing it'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF v_actor = ANY (app.evidence_pack_contributors(NEW.id)) THEN
      RAISE EXCEPTION 'Nobody who composed, redacted or edited an evidence pack may release it'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(NEW.location_ids) AS l(id)
               WHERE NOT app.holds_permission_at('quality.evidence_pack.release', l.id)) THEN
      RAISE EXCEPTION 'Only a holder of quality.evidence_pack.release at every location releases a pack'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.evidence_pack_item i
                   WHERE i.pack_id = NEW.id AND i.exclusion_reason IS NULL) THEN
      RAISE EXCEPTION 'An evidence pack with no items cannot be released'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.released_at := now();
  ELSIF NEW.state = 'discarded' THEN
    IF (v_actor IS NOT NULL AND NEW.discarded_by IS DISTINCT FROM v_actor)
       OR num_nonnulls(NEW.released_by, NEW.released_at, NEW.revoked_by, NEW.revoked_at) > 0 THEN
      RAISE EXCEPTION 'An evidence pack is discarded in the name of the member discarding it'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.discarded_at := now();
  ELSE
    IF (v_actor IS NOT NULL AND NEW.revoked_by IS DISTINCT FROM v_actor)
       OR (NEW.released_by, NEW.released_at) IS DISTINCT FROM (OLD.released_by, OLD.released_at) THEN
      RAISE EXCEPTION 'An evidence pack is revoked in the name of the member revoking it'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.revoked_at := now();
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_pack_guard BEFORE UPDATE ON public.evidence_pack
  FOR EACH ROW EXECUTE FUNCTION app.evidence_pack_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.evidence_pack
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.evidence_pack
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint

-- HZ-050: an item joins only a draft, in its writer's name. Its fields carry outcomes, never
-- values (those live in the bundle), with kinds, outcomes and reasons from the domain's lists; the
-- people who redacted by hand are worked out from them, and a new hand redaction is the writer's
-- own. A superseding row replaces an included item of the same pack and record. A member other
-- than the composer becomes one of the pack's editors.
CREATE OR REPLACE FUNCTION app.evidence_pack_item_add() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := app.current_user_id();
  v_pack record;
  v_old record;
BEGIN
  SELECT p.state, p.composed_by, p.editor_ids INTO v_pack
    FROM public.evidence_pack p WHERE p.id = NEW.pack_id FOR SHARE;
  IF NOT FOUND OR v_pack.state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Items are added only to a draft evidence pack'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_actor IS NOT NULL THEN NEW.created_by := v_actor; END IF;
  NEW.created_at := now();
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.fields) AS f
    WHERE jsonb_typeof(f) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(f) AS k
                  WHERE k NOT IN ('key', 'label', 'kind', 'outcome', 'reason', 'redactedBy',
                                  'redactedText'))
       OR jsonb_typeof(f -> 'key') IS DISTINCT FROM 'string'
       OR (f ->> 'kind') IS NULL OR (f ->> 'kind') NOT IN ('organisational', 'care_content',
            'direct_identifier', 'staff_name', 'third_party', 'free_text')
       OR (f ->> 'outcome') IS NULL OR (f ->> 'outcome') NOT IN ('included', 'redacted', 'withheld')
       OR ((f ->> 'reason') IS NOT NULL AND (f ->> 'reason') NOT IN ('third_party',
            'staff_role_only', 'free_text_redacted_by_hand', 'person_not_in_scope',
            'person_unknown', 'identifier_not_needed', 'free_text_not_reviewed',
            'redaction_incomplete'))
       OR (((f ->> 'reason') IS NOT DISTINCT FROM 'free_text_redacted_by_hand'
              AND (f ->> 'outcome') = 'redacted')
           <> ((f ->> 'redactedBy') IS NOT NULL AND (f ->> 'redactedText') IS NOT NULL))
       OR ((f ->> 'outcome') = 'included') <> ((f ->> 'reason') IS NULL)) THEN
    RAISE EXCEPTION 'An evidence pack item holds field outcomes from the domain''s lists, and no values'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.redacted_by := ARRAY(
    SELECT DISTINCT (f ->> 'redactedBy')::uuid FROM jsonb_array_elements(NEW.fields) AS f
    WHERE (f ->> 'redactedBy') IS NOT NULL ORDER BY 1);
  IF NEW.supersedes_id IS NULL THEN
    IF cardinality(NEW.redacted_by) > 0 THEN
      RAISE EXCEPTION 'A hand redaction supersedes the item it redacts'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    SELECT i.pack_id, i.record_type, i.record_id, i.record_version, i.exclusion_reason,
        i.redacted_by
      INTO v_old FROM public.evidence_pack_item i WHERE i.id = NEW.supersedes_id;
    IF NOT FOUND OR (v_old.pack_id, v_old.record_type, v_old.record_id, v_old.record_version)
         IS DISTINCT FROM (NEW.pack_id, NEW.record_type, NEW.record_id, NEW.record_version)
       OR v_old.exclusion_reason IS NOT NULL THEN
      RAISE EXCEPTION 'A superseding item replaces an included item of the same pack and record'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(NEW.redacted_by) AS r(id)
               WHERE NOT r.id = ANY (v_old.redacted_by) AND r.id IS DISTINCT FROM v_actor) THEN
      RAISE EXCEPTION 'A hand redaction is in the name of the member redacting'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF v_actor IS NOT NULL AND v_actor IS DISTINCT FROM v_pack.composed_by
     AND NOT v_actor = ANY (v_pack.editor_ids) THEN
    UPDATE public.evidence_pack SET editor_ids = array_append(editor_ids, v_actor)
      WHERE id = NEW.pack_id;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_pack_item_add BEFORE INSERT ON public.evidence_pack_item
  FOR EACH ROW EXECUTE FUNCTION app.evidence_pack_item_add();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.evidence_pack_item
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.evidence_pack_item
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- A link is a release (ADR-0050, rules 7 and 9): only for a released pack, to its recipient, now,
-- by a member who did not shape the pack and holds release at every location, expiring within
-- evidence_pack.link_expiry_days.max (no figure: refused). The first link replaces nothing; a new
-- one replaces the pack's last link, revoked as re-issued in the same transaction.
CREATE OR REPLACE FUNCTION app.evidence_pack_link_issue() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := app.current_user_id();
  v_pack record;
  v_max numeric;
  v_last record;
BEGIN
  SELECT p.state, p.recipient_email, p.location_ids INTO v_pack
    FROM public.evidence_pack p WHERE p.id = NEW.pack_id FOR SHARE;
  IF NOT FOUND OR v_pack.state IS DISTINCT FROM 'released' THEN
    RAISE EXCEPTION 'A link is issued only for a released evidence pack'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.recipient_email IS DISTINCT FROM v_pack.recipient_email THEN
    RAISE EXCEPTION 'A link goes to the pack''s recipient only; anyone else needs a new pack'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_actor IS NULL OR NEW.issued_by IS DISTINCT FROM v_actor
     OR num_nonnulls(NEW.revoked_at, NEW.revoked_by, NEW.revocation_reason, NEW.last_opened_at,
          NEW.deleted_at) > 0 OR NEW.failed_code_attempts <> 0 THEN
    RAISE EXCEPTION 'A link is issued fresh, in the name of the member issuing it'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_actor = ANY (app.evidence_pack_contributors(NEW.pack_id)) THEN
    RAISE EXCEPTION 'Nobody who composed, redacted or edited an evidence pack may issue its link'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_pack.location_ids) AS l(id)
             WHERE NOT app.holds_permission_at('quality.evidence_pack.release', l.id)) THEN
    RAISE EXCEPTION 'Only a holder of quality.evidence_pack.release at every location issues a link'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.issued_at := now();
  v_max := app.quality_rate('evidence_pack.link_expiry_days.max', NEW.issued_at);
  IF v_max IS NULL OR NEW.expires_at <= NEW.issued_at OR NEW.expires_at >
       ((NEW.issued_at AT TIME ZONE 'Europe/London') + make_interval(days => v_max::int))
         AT TIME ZONE 'Europe/London' THEN
    RAISE EXCEPTION 'A link expires after it is issued and within evidence_pack.link_expiry_days.max'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT k.id, k.revocation_reason INTO v_last FROM public.evidence_pack_link k
    WHERE k.pack_id = NEW.pack_id ORDER BY k.issued_at DESC, k.id DESC LIMIT 1;
  IF NEW.replaces_link_id IS DISTINCT FROM v_last.id
     OR (v_last.id IS NOT NULL AND v_last.revocation_reason IS DISTINCT FROM 'reissued') THEN
    RAISE EXCEPTION 'A new link replaces the pack''s last link, revoked as re-issued first'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_pack_link_issue BEFORE INSERT ON public.evidence_pack_link
  FOR EACH ROW EXECUTE FUNCTION app.evidence_pack_link_issue();
--> statement-breakpoint

-- Whether a link opens at all now, before any session or code (`evidencePackLinkAccess`): its
-- pack released, not revoked, not expired, not locked after EVIDENCE_LINK_MAX_CODE_ATTEMPTS (5)
-- wrong codes.
CREATE OR REPLACE FUNCTION app.evidence_pack_link_live(p_link_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.evidence_pack_link k JOIN public.evidence_pack p ON p.id = k.pack_id
    WHERE k.id = p_link_id AND p.state = 'released' AND k.revoked_at IS NULL
      AND k.expires_at > clock_timestamp() AND k.failed_code_attempts < 5)
$$;
--> statement-breakpoint

-- A link keeps what it was issued with; failed attempts never go down (rule 8); a revocation is
-- set once, now, and is final; an open is recorded only while the link is live and moves forward.
CREATE OR REPLACE FUNCTION app.evidence_pack_link_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.pack_id, NEW.recipient_email, NEW.token_hash, NEW.issued_by, NEW.issued_at,
      NEW.replaces_link_id, NEW.expires_at, NEW.deleted_at)
     IS DISTINCT FROM (OLD.pack_id, OLD.recipient_email, OLD.token_hash, OLD.issued_by,
      OLD.issued_at, OLD.replaces_link_id, OLD.expires_at, OLD.deleted_at) THEN
    RAISE EXCEPTION 'A link keeps its pack, recipient, token, issue and expiry'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.failed_code_attempts < OLD.failed_code_attempts THEN
    RAISE EXCEPTION 'Failed code attempts never go down'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'A revoked link is final' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    IF (app.current_user_id() IS NOT NULL AND NEW.revoked_by IS DISTINCT FROM app.current_user_id())
       OR (app.current_user_id() IS NULL AND NEW.revoked_by IS NOT NULL)
       OR NEW.last_opened_at IS DISTINCT FROM OLD.last_opened_at
       OR NEW.failed_code_attempts <> OLD.failed_code_attempts THEN
      RAISE EXCEPTION 'A link is revoked on its own, in the name of the member revoking it'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.revoked_at := now();
  ELSIF NEW.revoked_by IS NOT NULL THEN
    RAISE EXCEPTION 'A link names who revoked it only when revoked'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.last_opened_at IS DISTINCT FROM OLD.last_opened_at THEN
    IF NEW.last_opened_at IS NULL OR NEW.last_opened_at > clock_timestamp()
       OR NEW.last_opened_at < coalesce(OLD.last_opened_at, OLD.issued_at)
       OR NOT app.evidence_pack_link_live(OLD.id) THEN
      RAISE EXCEPTION 'A link is opened only while it is live'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_pack_link_guard BEFORE UPDATE ON public.evidence_pack_link
  FOR EACH ROW EXECUTE FUNCTION app.evidence_pack_link_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.evidence_pack_link
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.evidence_pack_link
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.evidence_pack_link
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- A code is issued only for a live link, now, and lasts evidence_pack.code_valid_minutes, never
-- more than EVIDENCE_CODE_MAX_VALID_MINUTES (10), worked out here (no figure: refused). It is then
-- only ever marked used, once, before it lapses, while its link is live.
CREATE OR REPLACE FUNCTION app.evidence_pack_code_issue() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_minutes numeric;
BEGIN
  IF NOT app.evidence_pack_link_live(NEW.link_id) OR NEW.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'A code is issued, unused, only for a live link'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.issued_at := now();
  v_minutes := least(app.quality_rate('evidence_pack.code_valid_minutes', NEW.issued_at), 10);
  IF v_minutes IS NULL OR v_minutes <= 0 THEN
    RAISE EXCEPTION 'No evidence_pack.code_valid_minutes figure' USING ERRCODE = 'check_violation';
  END IF;
  NEW.valid_until := NEW.issued_at + make_interval(secs => v_minutes * 60);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_pack_code_issue BEFORE INSERT ON public.evidence_pack_link_code
  FOR EACH ROW EXECUTE FUNCTION app.evidence_pack_code_issue();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.evidence_pack_code_use() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.link_id, NEW.code_hash, NEW.issued_at, NEW.valid_until,
      NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.link_id, OLD.code_hash, OLD.issued_at,
      OLD.valid_until, OLD.created_at, OLD.created_by)
     OR OLD.used_at IS NOT NULL OR NEW.used_at IS NULL
     OR clock_timestamp() >= OLD.valid_until OR NOT app.evidence_pack_link_live(OLD.link_id) THEN
    RAISE EXCEPTION 'A code is only marked used, once, before it lapses, while its link is live'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.used_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_pack_code_use BEFORE UPDATE ON public.evidence_pack_link_code
  FOR EACH ROW EXECUTE FUNCTION app.evidence_pack_code_use();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.evidence_pack_link_code
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON public.evidence_pack_link_code
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- Rule 10: a bundle is written for a draft and changes only while the pack is a draft. It is
-- deleted (content cleared, never restored) only when it may be (`evidencePackBundleDeletable`):
-- the pack discarded or revoked, or released with no link still live.
CREATE OR REPLACE FUNCTION app.evidence_pack_bundle_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
BEGIN
  SELECT p.state INTO v_state FROM public.evidence_pack p WHERE p.id = NEW.pack_id FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    IF v_state IS DISTINCT FROM 'draft' OR NEW.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'A bundle is written for a draft evidence pack'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF app.current_user_id() IS NOT NULL THEN NEW.created_by := app.current_user_id(); END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.pack_id, NEW.created_at, NEW.created_by)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.pack_id, OLD.created_at, OLD.created_by)
     OR OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'A deleted bundle is never restored, and a bundle keeps its pack'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    IF NOT ((NEW.deletion_reason = 'pack_discarded' AND v_state = 'discarded')
         OR (NEW.deletion_reason = 'pack_revoked' AND v_state = 'revoked')
         OR (NEW.deletion_reason = 'link_ended' AND v_state = 'released'
             AND EXISTS (SELECT 1 FROM public.evidence_pack_link k WHERE k.pack_id = NEW.pack_id)
             AND NOT EXISTS (SELECT 1 FROM public.evidence_pack_link k
                             WHERE k.pack_id = NEW.pack_id AND k.revoked_at IS NULL
                               AND k.expires_at > clock_timestamp()))) THEN
      RAISE EXCEPTION 'A bundle is deleted when its link ends or its pack is revoked or discarded'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.deleted_at := now();
  ELSIF v_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'A bundle changes only while its pack is a draft'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_pack_bundle_guard BEFORE INSERT OR UPDATE ON public.evidence_pack_bundle
  FOR EACH ROW EXECUTE FUNCTION app.evidence_pack_bundle_guard();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.evidence_pack_bundle
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- The statement of purpose belongs to the provider: read and written by holders of the write or
-- approve permission or of safety.notification.submit anywhere in the organisation (or a job);
-- drafted by holders of write.
CREATE POLICY statement_of_purpose_permission ON public.statement_of_purpose_version
  AS RESTRICTIVE FOR ALL TO harbour_app
  USING (app.is_system()
    OR app.holds_permission_anywhere('quality.statement_of_purpose.write')
    OR app.holds_permission_anywhere('quality.statement_of_purpose.approve')
    OR app.holds_permission_anywhere('safety.notification.submit'))
  WITH CHECK (app.is_system()
    OR app.holds_permission_anywhere('quality.statement_of_purpose.write')
    OR app.holds_permission_anywhere('quality.statement_of_purpose.approve')
    OR app.holds_permission_anywhere('safety.notification.submit'));
--> statement-breakpoint
CREATE POLICY statement_of_purpose_draft ON public.statement_of_purpose_version
  AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (author_id = app.current_user_id()
    AND app.holds_permission_anywhere('quality.statement_of_purpose.write'));
--> statement-breakpoint

-- A version starts as a draft in its author's name, numbered next; the first is the baseline (the
-- statement CQC already holds) and every later one a revision.
CREATE OR REPLACE FUNCTION app.statement_of_purpose_draft() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM 'draft' OR NEW.supersedes_id IS NOT NULL
     OR num_nonnulls(NEW.approved_by, NEW.approved_at, NEW.notification_due_at, NEW.notified_at,
          NEW.notified_by, NEW.notification_evidence, NEW.discard_reason, NEW.deleted_at) > 0
     OR (app.current_user_id() IS NOT NULL AND NEW.author_id IS DISTINCT FROM app.current_user_id()) THEN
    RAISE EXCEPTION 'A statement of purpose version starts as a draft in its author''s name'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.kind = 'baseline') = EXISTS (
       SELECT 1 FROM public.statement_of_purpose_version v
       WHERE v.state IN ('approved', 'superseded')) THEN
    RAISE EXCEPTION 'The first statement of purpose is the baseline and every later one a revision'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.version_number := coalesce(
    (SELECT max(v.version_number) FROM public.statement_of_purpose_version v), 0) + 1;
  NEW.contributor_ids := ARRAY[NEW.author_id];
  NEW.change_summary := '[]'::jsonb;
  NEW.registration_prompts := '[]'::jsonb;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER statement_of_purpose_draft BEFORE INSERT ON public.statement_of_purpose_version
  FOR EACH ROW EXECUTE FUNCTION app.statement_of_purpose_draft();
--> statement-breakpoint

-- Rules 12 to 15: a draft changes (its editors join the contributors), is approved or discarded;
-- approval is of the content as it stands, different from the current version, by a holder of
-- approve who did not write or edit it, supersedes the current version here and starts the
-- regulation 12(3) clock for a revision (cqc.statement_of_purpose.revision_notice_days, UK days;
-- no figure: refused); an approved or superseded version is fixed, except that the CQC
-- notification of a revision is recorded once, by a holder of safety.notification.submit.
CREATE OR REPLACE FUNCTION app.statement_of_purpose_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := app.current_user_id();
  v_current record;
  v_days numeric;
BEGIN
  IF (NEW.version_number, NEW.kind, NEW.author_id, NEW.created_at, NEW.created_by, NEW.deleted_at)
     IS DISTINCT FROM (OLD.version_number, OLD.kind, OLD.author_id, OLD.created_at,
      OLD.created_by, OLD.deleted_at) THEN
    RAISE EXCEPTION 'A statement of purpose version keeps its number, kind and author'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state = 'discarded' OR (OLD.state = 'superseded' AND NEW.state <> 'superseded') THEN
    RAISE EXCEPTION 'A % statement of purpose version is final', OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.state IN ('approved', 'superseded') THEN
    IF (NEW.content, NEW.contributor_ids, NEW.supersedes_id, NEW.change_summary,
        NEW.registration_prompts, NEW.approved_by, NEW.approved_at, NEW.notification_due_at,
        NEW.discard_reason)
       IS DISTINCT FROM (OLD.content, OLD.contributor_ids, OLD.supersedes_id, OLD.change_summary,
        OLD.registration_prompts, OLD.approved_by, OLD.approved_at, OLD.notification_due_at,
        OLD.discard_reason) THEN
      RAISE EXCEPTION 'An approved statement of purpose is fixed; start a revision'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state THEN
      -- Only the approval of the next version supersedes this one, from inside its own trigger.
      IF (OLD.state, NEW.state) <> ('approved', 'superseded') OR pg_trigger_depth() < 2
         OR (NEW.notified_at, NEW.notified_by, NEW.notification_evidence)
           IS DISTINCT FROM (OLD.notified_at, OLD.notified_by, OLD.notification_evidence) THEN
        RAISE EXCEPTION 'A statement of purpose is superseded only by approving the next version'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF (NEW.notified_at, NEW.notified_by, NEW.notification_evidence)
       IS DISTINCT FROM (OLD.notified_at, OLD.notified_by, OLD.notification_evidence) THEN
      IF OLD.notified_at IS NOT NULL OR OLD.kind <> 'revision' OR v_actor IS NULL
         OR NEW.notified_by IS DISTINCT FROM v_actor OR NEW.notified_at > clock_timestamp()
         OR NOT app.holds_permission_anywhere('safety.notification.submit') THEN
        RAISE EXCEPTION 'The CQC notification of a revision is recorded once, in the name of a holder of safety.notification.submit, at a time not in the future'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- A draft.
  IF NEW.notified_at IS NOT NULL OR NEW.notified_by IS NOT NULL
     OR NEW.notification_evidence IS NOT NULL THEN
    RAISE EXCEPTION 'Only an approved revision records its CQC notification'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'draft' THEN
    IF (NEW.supersedes_id, NEW.change_summary, NEW.registration_prompts, NEW.approved_by,
        NEW.approved_at, NEW.notification_due_at, NEW.discard_reason)
       IS DISTINCT FROM (OLD.supersedes_id, OLD.change_summary, OLD.registration_prompts,
        OLD.approved_by, OLD.approved_at, OLD.notification_due_at, OLD.discard_reason) THEN
      RAISE EXCEPTION 'A draft changes only its content'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF v_actor IS NOT NULL
       AND NOT app.holds_permission_anywhere('quality.statement_of_purpose.write') THEN
      RAISE EXCEPTION 'Only a holder of quality.statement_of_purpose.write changes a draft'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.contributor_ids := CASE
      WHEN v_actor IS NULL OR v_actor = ANY (OLD.contributor_ids) THEN OLD.contributor_ids
      ELSE array_append(OLD.contributor_ids, v_actor) END;
    RETURN NEW;
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content
     OR NEW.contributor_ids IS DISTINCT FROM OLD.contributor_ids THEN
    RAISE EXCEPTION 'Change a draft and move it separately'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'discarded' THEN
    IF (NEW.supersedes_id, NEW.approved_by, NEW.approved_at, NEW.notification_due_at)
       IS DISTINCT FROM (OLD.supersedes_id, OLD.approved_by, OLD.approved_at, OLD.notification_due_at)
       OR (v_actor IS NOT NULL
           AND NOT app.holds_permission_anywhere('quality.statement_of_purpose.write')) THEN
      RAISE EXCEPTION 'A draft is discarded, with its reason, by a holder of quality.statement_of_purpose.write'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'A draft cannot move to %', NEW.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_actor IS NULL OR NEW.approved_by IS DISTINCT FROM v_actor
     OR v_actor = OLD.author_id OR v_actor = ANY (OLD.contributor_ids)
     OR NOT app.holds_permission_anywhere('quality.statement_of_purpose.approve') THEN
    RAISE EXCEPTION 'A statement of purpose is approved by a holder of quality.statement_of_purpose.approve who did not write or edit it, in their own name'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT v.id, v.content INTO v_current FROM public.statement_of_purpose_version v
    WHERE v.state = 'approved' AND v.id <> OLD.id FOR UPDATE;
  IF (OLD.kind = 'revision') <> (v_current.id IS NOT NULL)
     OR (v_current.id IS NOT NULL AND v_current.content IS NOT DISTINCT FROM OLD.content) THEN
    RAISE EXCEPTION 'A revision differs from the current statement of purpose, and supersedes it'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.approved_at := now();
  NEW.supersedes_id := v_current.id;
  IF OLD.kind = 'revision' THEN
    v_days := app.quality_rate('cqc.statement_of_purpose.revision_notice_days', NEW.approved_at);
    IF v_days IS NULL THEN
      RAISE EXCEPTION 'No cqc.statement_of_purpose.revision_notice_days figure'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.notification_due_at := ((NEW.approved_at AT TIME ZONE 'Europe/London')
      + make_interval(days => v_days::int)) AT TIME ZONE 'Europe/London';
    UPDATE public.statement_of_purpose_version SET state = 'superseded' WHERE id = v_current.id;
  ELSE
    NEW.notification_due_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER statement_of_purpose_guard BEFORE UPDATE ON public.statement_of_purpose_version
  FOR EACH ROW EXECUTE FUNCTION app.statement_of_purpose_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.statement_of_purpose_version
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.statement_of_purpose_version
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.statement_of_purpose_version
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.evidence_pack, public.evidence_pack_link,
  public.evidence_pack_bundle, public.statement_of_purpose_version TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.evidence_pack_item, public.evidence_pack_link_code TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.evidence_pack_item FROM harbour_app;
--> statement-breakpoint
-- A code is only ever marked used.
REVOKE UPDATE, DELETE, TRUNCATE ON public.evidence_pack_link_code FROM harbour_app;
--> statement-breakpoint
GRANT UPDATE (used_at) ON public.evidence_pack_link_code TO harbour_app;
--> statement-breakpoint

-- The public link routes find a link by its token before any organisation is chosen (ADR-0050):
-- the organisation, the link and its pack for the SHA-256 of the raw token, or no row. It changes
-- nothing and reveals nothing else; the routes then work in that organisation as the system, on
-- that link alone. Owned by harbour_evidence_link_reader, which reads only those columns.
CREATE OR REPLACE FUNCTION app.evidence_pack_link_for_token(p_token text)
RETURNS TABLE (tenant_id uuid, link_id uuid, pack_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT k.tenant_id, k.id, k.pack_id FROM public.evidence_pack_link k
  WHERE k.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;
--> statement-breakpoint
CREATE POLICY evidence_pack_link_reader ON public.evidence_pack_link AS PERMISSIVE FOR SELECT
  TO harbour_evidence_link_reader USING (true);
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO harbour_evidence_link_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, pack_id, token_hash) ON public.evidence_pack_link
  TO harbour_evidence_link_reader;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.evidence_pack_link_for_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.evidence_pack_link_for_token(text) TO harbour_app;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_evidence_link_reader;
--> statement-breakpoint
ALTER FUNCTION app.evidence_pack_link_for_token(text) OWNER TO harbour_evidence_link_reader;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_evidence_link_reader;
