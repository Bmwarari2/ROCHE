-- The public evidence pack link routes (quality.md section 15; ADR-0050; HZ-050; #56 security
-- review round 1, Low): a request opened by a link runs as a link session, never with the
-- organisation-wide reach of the system. The API sets `app.link_id` and `app.link_pack_id` for the
-- transaction (from `app.evidence_pack_link_for_token`, by the token's hash) with no member and
-- scope 'none'; these policies then let it reach that link, its pack, the pack's items and bundle
-- and the link's codes, and nothing else of the evidence tables or the statement of purpose; it
-- only reads the pack, items and bundle, and changes the link and its codes as the 0057 guards
-- allow (failed attempts up, an open recorded, a code issued or marked used). Runs as harbour_owner.

CREATE OR REPLACE FUNCTION app.current_link_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.link_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.current_link_pack_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.link_pack_id', true), '')::uuid
$$;
--> statement-breakpoint
-- A request opened by an evidence pack link: no member, a link named. Whatever scope it claims,
-- the policies below hold it to that link.
CREATE OR REPLACE FUNCTION app.is_link_session() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT app.current_user_id() IS NULL AND app.current_link_id() IS NOT NULL
$$;
--> statement-breakpoint

-- The pack: a link session sees its own pack alone; everyone else as before (0057).
DROP POLICY evidence_pack_scope ON public.evidence_pack;
--> statement-breakpoint
CREATE POLICY evidence_pack_scope ON public.evidence_pack AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (CASE WHEN app.is_link_session() THEN id = app.current_link_pack_id()
              ELSE app.evidence_pack_visible(location_ids, person_ids) END)
  WITH CHECK (CASE WHEN app.is_link_session() THEN id = app.current_link_pack_id()
                   ELSE app.evidence_pack_visible(location_ids, person_ids) END);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.evidence_pack_permitted(p_location_ids uuid[]) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.is_system() OR app.is_link_session() OR NOT EXISTS (
    SELECT 1 FROM unnest(p_location_ids) AS l(id)
    WHERE NOT (app.holds_permission_at('quality.evidence_pack.compose', l.id)
               OR app.holds_permission_at('quality.evidence_pack.release', l.id)))
$$;
--> statement-breakpoint

-- The link: its own alone (its codes follow it through the 0057 code policy; items and the
-- bundle follow the pack).
CREATE POLICY evidence_pack_link_session ON public.evidence_pack_link AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (NOT app.is_link_session() OR id = app.current_link_id())
  WITH CHECK (NOT app.is_link_session() OR id = app.current_link_id());
--> statement-breakpoint

-- Read only, except the link and its codes.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['evidence_pack', 'evidence_pack_item', 'evidence_pack_bundle'] LOOP
    EXECUTE format(
      'CREATE POLICY link_session_no_insert ON public.%I AS RESTRICTIVE FOR INSERT '
      'TO harbour_app, harbour_owner WITH CHECK (NOT app.is_link_session())', t);
    EXECUTE format(
      'CREATE POLICY link_session_no_update ON public.%I AS RESTRICTIVE FOR UPDATE '
      'TO harbour_app, harbour_owner USING (NOT app.is_link_session())', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE POLICY link_session_no_insert ON public.evidence_pack_link AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner WITH CHECK (NOT app.is_link_session());
--> statement-breakpoint

-- Nothing of the statement of purpose.
CREATE POLICY link_session_none ON public.statement_of_purpose_version AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (NOT app.is_link_session()) WITH CHECK (NOT app.is_link_session());
