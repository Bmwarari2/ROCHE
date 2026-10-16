-- Search on Postgres full-text search (PLAT-013; platform-completions.md rules 1 to 9 and section 6;
-- ADR-0070; hazards HZ-001 and HZ-011). Runs as harbour_owner. Expand only.
--
-- Terms are normalised once, in SQL, exactly as `searchTerms` in @harbour/domain does (rule 2):
-- lower case, compatibility decomposition, accents and the letters `unaccent` folds (ß, æ, ø, ł and
-- similar) folded, apostrophes inside a name joined, every other character a separator. The
-- vectors hold those terms with the `simple` parser and no stemming. Every function here is
-- SECURITY INVOKER and none is LEAKPROOF: the full-text match is applied after the row-level
-- security policies, within the caller's own rows (ADR-0070 point 4). For the same reason a GIN
-- index on the vectors could never be used by the app role (the match cannot be an index condition
-- ahead of the policy), so there is none: each search reads the tenant's rows by an existing index
-- on `tenant_id` and filters them. Revisit with ADR-0070 if a tenant's search exceeds the budget.

CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION app.harbour_search (COPY = pg_catalog.simple);
--> statement-breakpoint

-- The search terms in some text. Immutable so generated columns can use it: `unaccent` is called
-- with its dictionary named, and the search path is fixed.
CREATE FUNCTION app.search_terms(input text) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(array_agg(term ORDER BY n), '{}')
  FROM regexp_split_to_table(
         public.unaccent('public.unaccent'::regdictionary,
           translate(lower(normalize(coalesce(input, ''), NFKD)), '''’ʼ', '')),
         '[^[:alnum:]]+') WITH ORDINALITY AS t(term, n)
  WHERE term <> ''
$$;
--> statement-breakpoint

-- The vector for some text: its search terms, unstemmed.
CREATE FUNCTION app.search_vector(input text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT to_tsvector('app.harbour_search'::regconfig, array_to_string(app.search_terms(input), ' '))
$$;
--> statement-breakpoint

-- People: one vector for the names (a break-glass search matches these alone) and one for the room.
ALTER TABLE person
  ADD COLUMN search_names tsvector GENERATED ALWAYS AS (
    app.search_vector(given_name || ' ' || family_name || ' ' || coalesce(preferred_name, ''))
  ) STORED,
  ADD COLUMN search_room tsvector GENERATED ALWAYS AS (app.search_vector(room_label)) STORED;
--> statement-breakpoint
CREATE INDEX person_nhs_number_idx ON person (tenant_id, nhs_number) WHERE nhs_number IS NOT NULL;
--> statement-breakpoint

-- Colleagues: the display name only, never contact details.
ALTER TABLE tenant_user
  ADD COLUMN search_name tsvector GENERATED ALWAYS AS (app.search_vector(display_name)) STORED;
--> statement-breakpoint

-- Documents: the title and display file name, never the file's contents.
ALTER TABLE document
  ADD COLUMN search_title tsvector GENERATED ALWAYS AS (
    app.search_vector(title || ' ' || coalesce(file_name, ''))
  ) STORED;
--> statement-breakpoint

-- Notes: the text.
ALTER TABLE care_note
  ADD COLUMN search_body tsvector GENERATED ALWAYS AS (app.search_vector(body)) STORED;
