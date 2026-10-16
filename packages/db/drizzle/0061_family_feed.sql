CREATE TABLE "family_portal_user" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "family_portal_user_revoked" CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoked_reason IS NULL)
        AND (revoked_reason IS NULL OR btrim(revoked_reason) <> ''))
);
--> statement-breakpoint
CREATE TABLE "feed_item" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"section" text NOT NULL,
	"care_plan_domain" text,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"composed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"text" text NOT NULL,
	"photo_document_id" uuid,
	"phrase_key" text,
	"composed_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"confirmed_by" uuid,
	"confirmation_reason" text,
	"supersedes_item_id" uuid,
	"other_people_identifiable" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "feed_item_tenant_person_id_key" UNIQUE("tenant_id","person_id","id"),
	CONSTRAINT "feed_item_kind" CHECK (kind IN ('activity', 'visit', 'appointment', 'shared_note', 'photo', 'care_plan_update', 'finance_statement')),
	CONSTRAINT "feed_item_section" CHECK (section = CASE kind WHEN 'activity' THEN 'activities_and_visits' WHEN 'visit' THEN 'activities_and_visits' WHEN 'appointment' THEN 'appointments' WHEN 'shared_note' THEN 'daily_updates' WHEN 'photo' THEN 'photos' WHEN 'care_plan_update' THEN 'care_plan' WHEN 'finance_statement' THEN 'finance' END),
	CONSTRAINT "feed_item_source_kind" CHECK (source_kind IN ('activity', 'visit', 'shared_note', 'photo', 'care_plan_update', 'finance_statement')),
	CONSTRAINT "feed_item_care_plan_domain" CHECK ((kind = 'care_plan_update') = (care_plan_domain IS NOT NULL)),
	CONSTRAINT "feed_item_photo" CHECK ((photo_document_id IS NULL OR kind = 'photo')
        AND (kind <> 'photo' OR (photo_document_id IS NOT NULL AND other_people_identifiable = false))),
	CONSTRAINT "feed_item_confirmation" CHECK ((confirmed_by IS NULL) = (confirmation_reason IS NULL)
        AND (confirmation_reason IS NULL OR btrim(confirmation_reason) <> '')),
	CONSTRAINT "feed_item_text" CHECK (char_length(btrim(text)) BETWEEN 1 AND 1000),
	CONSTRAINT "feed_item_order" CHECK (occurred_at <= composed_at)
);
--> statement-breakpoint
CREATE TABLE "feed_item_withdrawal" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"feed_item_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"withdrawn_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"withdrawn_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "feed_item_withdrawal_reason" CHECK (reason IN ('source_corrected', 'published_in_error', 'person_asked', 'photo_consent_withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "feed_view" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"feed_item_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"sharing_decision_id" uuid NOT NULL,
	"section" text NOT NULL,
	"care_plan_domain" text,
	"person_status" text NOT NULL,
	"capacity_for_sharing" text NOT NULL,
	"viewed_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "feed_view_capacity" CHECK (capacity_for_sharing IN ('presumed', 'assessed_has_capacity', 'assessed_lacks_capacity'))
);
--> statement-breakpoint
ALTER TABLE "family_portal_user" ADD CONSTRAINT "family_portal_user_tenant_user_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_portal_user" ADD CONSTRAINT "family_portal_user_revoked_by_fk" FOREIGN KEY ("tenant_id","revoked_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_portal_user" ADD CONSTRAINT "family_portal_user_contact_fk" FOREIGN KEY ("tenant_id","person_id","contact_id") REFERENCES "public"."contact"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_item" ADD CONSTRAINT "feed_item_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_item" ADD CONSTRAINT "feed_item_photo_fk" FOREIGN KEY ("tenant_id","photo_document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_item" ADD CONSTRAINT "feed_item_supersedes_fk" FOREIGN KEY ("tenant_id","person_id","supersedes_item_id") REFERENCES "public"."feed_item"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_item" ADD CONSTRAINT "feed_item_composed_by_fk" FOREIGN KEY ("tenant_id","composed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_item" ADD CONSTRAINT "feed_item_confirmed_by_fk" FOREIGN KEY ("tenant_id","confirmed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_item_withdrawal" ADD CONSTRAINT "feed_item_withdrawal_item_fk" FOREIGN KEY ("tenant_id","person_id","feed_item_id") REFERENCES "public"."feed_item"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_item_withdrawal" ADD CONSTRAINT "feed_item_withdrawal_by_fk" FOREIGN KEY ("tenant_id","withdrawn_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_view" ADD CONSTRAINT "feed_view_item_fk" FOREIGN KEY ("tenant_id","person_id","feed_item_id") REFERENCES "public"."feed_item"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_view" ADD CONSTRAINT "feed_view_contact_fk" FOREIGN KEY ("tenant_id","person_id","contact_id") REFERENCES "public"."contact"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_view" ADD CONSTRAINT "feed_view_decision_fk" FOREIGN KEY ("tenant_id","person_id","sharing_decision_id") REFERENCES "public"."sharing_decision"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_view" ADD CONSTRAINT "feed_view_viewed_by_fk" FOREIGN KEY ("tenant_id","viewed_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "family_portal_user_open_key" ON "family_portal_user" USING btree ("tenant_id","tenant_user_id","contact_id") WHERE revoked_at IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "family_portal_user_person_idx" ON "family_portal_user" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE INDEX "feed_item_person_idx" ON "feed_item" USING btree ("tenant_id","person_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_item_withdrawal_once_key" ON "feed_item_withdrawal" USING btree ("tenant_id","feed_item_id");--> statement-breakpoint
CREATE INDEX "feed_view_item_idx" ON "feed_view" USING btree ("tenant_id","feed_item_id","viewed_by");--> statement-breakpoint

-- The family feed (comms.md section 2.1; COMMS-001; ADR-0061; hazards HZ-022 and HZ-011). A family
-- session is a portal session: the API sets `app.family` with the member and scope 'none', so
-- `app.person_visible` is false for every person and no staff table opens. The feed opens only
-- through `app.family_can_see`, which mirrors `checkFeedItemVisibility` (a sharing decision for
-- one of the caller's contacts, in force and not suspended when the thing happened and now, the
-- authority and capacity rules, the person receiving care). It is a definer function owned by its
-- own NOLOGIN role, harbour_family_reader, which reads only what the rule needs. Updates,
-- withdrawals and views are append-only. Runs as harbour_owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['family_portal_user', 'feed_item', 'feed_item_withdrawal', 'feed_view'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
    EXECUTE format(
      'CREATE POLICY link_session_none ON public.%I AS RESTRICTIVE FOR ALL '
      'TO harbour_app, harbour_owner USING (NOT app.is_link_session()) '
      'WITH CHECK (NOT app.is_link_session())', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- The request says it is a family session; it counts only with a member and scope 'none'.
CREATE OR REPLACE FUNCTION app.family_flag() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(current_setting('app.family', true), '') = 'true'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.family_session() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT app.family_flag() AND app.current_user_id() IS NOT NULL AND app.current_scope() = 'none'
$$;
--> statement-breakpoint

-- A member always sees their own links (the API resolves a portal session from them); staff see
-- the links of people in their scope; nobody in a family session writes one.
CREATE POLICY family_portal_user_scope ON public.family_portal_user AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (tenant_user_id = app.current_user_id()
    OR (NOT app.family_flag() AND app.person_visible(person_id)))
  WITH CHECK (NOT app.family_flag() AND app.person_visible(person_id));
--> statement-breakpoint
CREATE POLICY family_portal_user_manage ON public.family_portal_user AS RESTRICTIVE FOR INSERT
  TO harbour_app WITH CHECK (app.holds_permission_at('people.sharing.manage',
    (SELECT p.location_id FROM public.person p WHERE p.id = person_id)));
--> statement-breakpoint
CREATE POLICY family_portal_user_change ON public.family_portal_user AS RESTRICTIVE FOR UPDATE
  TO harbour_app
  USING (app.holds_permission_at('people.sharing.manage',
    (SELECT p.location_id FROM public.person p WHERE p.id = person_id)))
  WITH CHECK (app.holds_permission_at('people.sharing.manage',
    (SELECT p.location_id FROM public.person p WHERE p.id = person_id)));
--> statement-breakpoint

-- The contacts and people of the session's own open links (none outside a family session).
CREATE OR REPLACE FUNCTION app.family_contact_ids() RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(f.contact_id), '{}'::uuid[]) FROM public.family_portal_user f
  WHERE app.family_session() AND f.tenant_id = app.current_tenant_id()
    AND f.tenant_user_id = app.current_user_id() AND f.revoked_at IS NULL AND f.deleted_at IS NULL
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.family_person_ids() RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(f.person_id), '{}'::uuid[]) FROM public.family_portal_user f
  WHERE app.family_session() AND f.tenant_id = app.current_tenant_id()
    AND f.tenant_user_id = app.current_user_id() AND f.revoked_at IS NULL AND f.deleted_at IS NULL
$$;
--> statement-breakpoint

-- `authorityCovers` in packages/domain/src/people/sharing.ts.
CREATE OR REPLACE FUNCTION app.sharing_authority_covers(p_role text, p_order text[], p_section text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_role = 'appointee' THEN p_section = 'benefits'
    WHEN (p_role IN ('lpa_property_finance', 'deputy_property_affairs'))
         <> (p_section IN ('finance', 'benefits')) THEN false
    WHEN p_role IN ('deputy_personal_welfare', 'deputy_property_affairs')
      THEN COALESCE(p_section = ANY (p_order), false)
    ELSE true
  END
$$;
--> statement-breakpoint

-- Whether the family session may see an update about a person, in a section (and care plan
-- domain), that happened at p_occurred_at: `checkFeedItemVisibility` without the photo basis,
-- which the API applies on top. A decision counts only for one of the caller's own open links, for
-- that person, naming that contact; in force and not suspended both when the thing happened and
-- now (`decisionInForceAt`, `decisionState`); not breaking the rules on its basis and authority
-- (`structuralProblems`); its authority not lapsed on the UK date; resting on a lack of capacity
-- only while the latest assessment of the sharing decision says so; and only while the person is
-- receiving care. Fails closed on anything missing.
CREATE OR REPLACE FUNCTION app.family_can_see(
  p_person_id uuid, p_section text, p_domain text, p_occurred_at timestamptz)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT app.family_session() AND p_occurred_at IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.person p
    JOIN public.family_portal_user f ON f.tenant_id = p.tenant_id AND f.person_id = p.id
    JOIN public.sharing_decision d ON d.tenant_id = f.tenant_id AND d.person_id = f.person_id
      AND d.recipient_kind = 'family' AND d.recipient_contact_id = f.contact_id
    CROSS JOIN LATERAL (SELECT
      d.basis = 'legal_authority' OR (d.basis = 'consent' AND d.consent_given_by = 'authority_holder')
        AS uses_authority,
      d.basis = 'best_interests'
        OR (d.basis = 'consent' AND d.consent_given_by = 'authority_holder')
        OR (d.basis = 'legal_authority' AND d.authority_contact_id IS NOT NULL
            AND d.authority_role IN ('lpa_health_welfare', 'deputy_personal_welfare'))
        AS needs_lack_of_capacity) k
    WHERE p.tenant_id = app.current_tenant_id() AND p.id = p_person_id AND p.deleted_at IS NULL
      AND p.status::text IN ('active', 'on_leave', 'in_hospital')
      AND f.tenant_user_id = app.current_user_id() AND f.revoked_at IS NULL AND f.deleted_at IS NULL
      AND d.deleted_at IS NULL
      -- The section, and for the care plan the domain.
      AND p_section = ANY (d.sections)
      AND (p_section <> 'care_plan' OR p_domain IS NULL OR d.care_plan_domains IS NULL
           OR p_domain = ANY (d.care_plan_domains))
      -- In force and not suspended when it happened, and now.
      AND (SELECT bool_and(
             d.valid_from <= w.t AND d.valid_to > w.t
             AND (d.withdrawn_at IS NULL OR d.withdrawn_at > w.t)
             AND (d.suspended_at IS NULL OR d.suspended_at > w.t)
             AND NOT EXISTS (
               SELECT 1 FROM public.sharing_decision_suspension s
               WHERE s.tenant_id = d.tenant_id AND s.sharing_decision_id = d.id
                 AND s.deleted_at IS NULL AND s.suspended_at <= w.t
                 AND (s.lifted_at IS NULL OR s.lifted_at > w.t)))
           FROM unnest(ARRAY[p_occurred_at, now()]) AS w(t))
      -- The rules on the basis and the authority: a stored decision breaking them never counts.
      AND d.basis IN ('consent', 'legal_authority', 'best_interests')
      AND cardinality(d.sections) = (SELECT count(DISTINCT x) FROM unnest(d.sections) x)
      AND (d.care_plan_domains IS NULL OR cardinality(d.care_plan_domains) = 0
           OR 'care_plan' = ANY (d.sections))
      AND (d.basis <> 'consent' OR d.consent_given_by IS NOT NULL)
      AND (d.basis <> 'consent' OR d.consent_given_by <> 'person'
           OR d.capacity <> 'assessed_lacks_capacity')
      AND (d.basis <> 'best_interests'
           OR (d.best_interests_decision_id IS NOT NULL AND d.capacity = 'assessed_lacks_capacity'))
      AND (d.basis <> 'legal_authority' OR d.authority_contact_id = d.recipient_contact_id)
      AND (NOT k.uses_authority OR (
        d.authority_role IS NOT NULL AND d.authority_contact_id IS NOT NULL
        AND (d.authority_evidence_document_id IS NOT NULL OR d.authority_reference IS NOT NULL)
        AND (d.authority_role NOT IN ('deputy_personal_welfare', 'deputy_property_affairs')
             OR COALESCE(cardinality(d.authority_order_sections), 0) > 0)
        AND (d.authority_role NOT IN ('lpa_health_welfare', 'deputy_personal_welfare')
             OR d.capacity = 'assessed_lacks_capacity')
        AND NOT EXISTS (SELECT 1 FROM unnest(d.sections) x
          WHERE NOT app.sharing_authority_covers(d.authority_role, d.authority_order_sections, x))
        -- Not lapsed on the UK date.
        AND (d.authority_valid_until IS NULL
             OR d.authority_valid_until >= (now() AT TIME ZONE 'Europe/London')::date)))
      -- Capacity now, from the latest assessment of the sharing decision (presumed without one).
      AND (NOT k.needs_lack_of_capacity OR COALESCE((
        SELECT c.outcome = 'lacks_capacity' FROM public.capacity_assessment c
        WHERE c.tenant_id = p.tenant_id AND c.person_id = p.id AND c.decision_kind = 'sharing'
          AND c.assessed_at <= now()
          AND NOT EXISTS (SELECT 1 FROM public.capacity_assessment n
                          WHERE n.tenant_id = c.tenant_id AND n.supersedes_id = c.id)
        ORDER BY c.assessed_at DESC LIMIT 1), false))
  )
$$;
--> statement-breakpoint

-- An update not taken down, or taken down after this member saw it (a definer function, so the
-- feed and its views do not read each other's policies).
CREATE OR REPLACE FUNCTION app.family_item_shown(p_item_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT app.family_session() AND (
    NOT EXISTS (SELECT 1 FROM public.feed_item_withdrawal w
                WHERE w.tenant_id = app.current_tenant_id() AND w.feed_item_id = p_item_id)
    OR EXISTS (SELECT 1 FROM public.feed_view v
               WHERE v.tenant_id = app.current_tenant_id() AND v.feed_item_id = p_item_id
                 AND v.viewed_by = app.current_user_id()))
$$;
--> statement-breakpoint

-- Updates: staff follow the person scope; a family session sees only what a decision opens, and
-- an update taken down only if it saw it before (FEED_WITHDRAWN_NOTICE). Published in the
-- composer's own name by a holder of comms.feed.publish where the person lives, never by a family
-- session.
CREATE POLICY feed_item_scope ON public.feed_item AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner
  USING (CASE WHEN app.family_flag()
    THEN app.family_can_see(feed_item.person_id, feed_item.section, feed_item.care_plan_domain,
        feed_item.occurred_at)
      AND app.family_item_shown(feed_item.id)
    ELSE app.person_visible(feed_item.person_id) END)
  WITH CHECK (NOT app.family_flag() AND app.person_visible(person_id));
--> statement-breakpoint
CREATE POLICY feed_item_publish ON public.feed_item AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (composed_by = app.current_user_id()
    AND (confirmed_by IS NULL OR confirmed_by = app.current_user_id())
    AND app.holds_permission_at('comms.feed.publish',
      (SELECT p.location_id FROM public.person p WHERE p.id = person_id)));
--> statement-breakpoint

-- Withdrawals: a family session sees those about its own people (to show the notice); taken down
-- in the withdrawer's own name by a holder of comms.feed.withdraw where the person lives.
CREATE POLICY feed_item_withdrawal_scope ON public.feed_item_withdrawal AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (CASE WHEN app.family_flag() THEN person_id = ANY (app.family_person_ids())
    ELSE app.person_visible(person_id) END)
  WITH CHECK (NOT app.family_flag() AND app.person_visible(person_id));
--> statement-breakpoint
CREATE POLICY feed_item_withdrawal_by ON public.feed_item_withdrawal AS RESTRICTIVE FOR INSERT
  TO harbour_app
  WITH CHECK (withdrawn_by = app.current_user_id()
    AND app.holds_permission_at('comms.feed.withdraw',
      (SELECT p.location_id FROM public.person p WHERE p.id = person_id)));
--> statement-breakpoint

-- Views: written only by a family session, for one of its own contacts and an update it can see;
-- staff read them for the people in their scope (the exposure history, rule 4).
CREATE POLICY feed_view_scope ON public.feed_view AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner
  USING (CASE WHEN app.family_flag()
    THEN viewed_by = app.current_user_id() AND contact_id = ANY (app.family_contact_ids())
    ELSE app.person_visible(person_id) END)
  WITH CHECK (app.family_session() AND viewed_by = app.current_user_id()
    AND contact_id = ANY (app.family_contact_ids())
    AND EXISTS (SELECT 1 FROM public.feed_item i WHERE i.id = feed_view.feed_item_id));
--> statement-breakpoint

-- The server's clock and the row's own author, never the caller's.
CREATE OR REPLACE FUNCTION app.feed_row_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := now();
  NEW.created_by := app.current_user_id();
  IF TG_TABLE_NAME = 'feed_item' THEN
    NEW.composed_at := now();
    IF NEW.occurred_at > now() THEN
      RAISE EXCEPTION 'An update is about something that has happened'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'feed_item_withdrawal' THEN
    NEW.withdrawn_at := now();
  ELSIF TG_TABLE_NAME = 'feed_view' THEN
    NEW.viewed_at := now();
    SELECT i.section, i.care_plan_domain INTO NEW.section, NEW.care_plan_domain
      FROM public.feed_item i WHERE i.id = NEW.feed_item_id;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['feed_item', 'feed_item_withdrawal', 'feed_view'] LOOP
    EXECUTE format('CREATE TRIGGER feed_row_stamp BEFORE INSERT ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.feed_row_stamp()', t);
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- A link names its account, person and contact for good, and is only revoked, never reopened. No
-- portal account holds a person assignment, either way round (ADR-0061): a definer function, so
-- the check sees rows outside the caller's scope.
CREATE OR REPLACE FUNCTION app.family_portal_user_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'family_portal_user' THEN
    IF TG_OP = 'UPDATE' AND (NEW.tenant_user_id IS DISTINCT FROM OLD.tenant_user_id
        OR NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
        OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)) THEN
      RAISE EXCEPTION 'A family portal link is only revoked' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.revoked_at IS NULL AND EXISTS (
        SELECT 1 FROM public.person_assignment pa
        WHERE pa.tenant_id = NEW.tenant_id AND pa.tenant_user_id = NEW.tenant_user_id
          AND pa.deleted_at IS NULL AND (pa.valid_to IS NULL OR pa.valid_to > now())) THEN
      RAISE EXCEPTION 'A family portal account holds no person assignment'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.deleted_at IS NULL AND (NEW.valid_to IS NULL OR NEW.valid_to > now()) AND EXISTS (
      SELECT 1 FROM public.family_portal_user f
      WHERE f.tenant_id = NEW.tenant_id AND f.tenant_user_id = NEW.tenant_user_id
        AND f.revoked_at IS NULL AND f.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'A family portal account holds no person assignment'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER family_portal_user_guard BEFORE INSERT OR UPDATE ON public.family_portal_user
  FOR EACH ROW EXECUTE FUNCTION app.family_portal_user_guard();
--> statement-breakpoint
CREATE TRIGGER family_portal_user_guard BEFORE INSERT OR UPDATE ON public.person_assignment
  FOR EACH ROW EXECUTE FUNCTION app.family_portal_user_guard();
--> statement-breakpoint
CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.family_portal_user
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.family_portal_user
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.family_portal_user
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.family_portal_user TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.feed_item, public.feed_item_withdrawal, public.feed_view TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.feed_item, public.feed_item_withdrawal, public.feed_view
  FROM harbour_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.family_portal_user FROM harbour_app;
--> statement-breakpoint

-- The definer functions' owner reads only what the rule and the guard need, under the tenant
-- policy alone (the scope policies name harbour_app and harbour_owner).
GRANT USAGE ON SCHEMA public, app TO harbour_family_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, status, deleted_at) ON public.person TO harbour_family_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, tenant_user_id, person_id, contact_id, revoked_at, deleted_at)
  ON public.family_portal_user TO harbour_family_reader;
--> statement-breakpoint
GRANT SELECT ON public.sharing_decision, public.sharing_decision_suspension TO harbour_family_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, person_id, decision_kind, assessed_at, outcome, supersedes_id)
  ON public.capacity_assessment TO harbour_family_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, tenant_user_id, deleted_at, valid_to) ON public.person_assignment
  TO harbour_family_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, feed_item_id) ON public.feed_item_withdrawal TO harbour_family_reader;
--> statement-breakpoint
GRANT SELECT (tenant_id, feed_item_id, viewed_by) ON public.feed_view TO harbour_family_reader;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO harbour_family_reader;
--> statement-breakpoint
ALTER FUNCTION app.family_can_see(uuid, text, text, timestamptz) OWNER TO harbour_family_reader;
--> statement-breakpoint
ALTER FUNCTION app.family_portal_user_guard() OWNER TO harbour_family_reader;
--> statement-breakpoint
ALTER FUNCTION app.family_item_shown(uuid) OWNER TO harbour_family_reader;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_family_reader;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.family_can_see(uuid, text, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.family_can_see(uuid, text, text, timestamptz) TO harbour_app, harbour_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.family_item_shown(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.family_item_shown(uuid) TO harbour_app, harbour_owner;