---
status: "accepted"
date: 2026-10-11
decision-makers: Claude Code (build), Brian (product owner, informed)
consulted: master prompt sections 5.3, 6 and 9.1; ADR-0001, ADR-0002, ADR-0031; docs/compliance/retention-and-deletion.md
informed: Brian
---

# Search on Postgres full-text search

## Context and problem statement

PLAT-013 asks for tenant-scoped full-text search across people, staff, documents and notes with
permission filtering (master prompt 9.1; [platform-completions.md](../specs/platform-completions.md)
rules 1 to 9). A search that leaks another tenant's or an out-of-scope person's name is a data
breach and a wrong-person risk (HZ-011, HZ-001). Where should the index live, and how is it kept
inside the same isolation as the records?

## Decision drivers

- Isolation must be enforced where the data is read: forced row-level security, not a filter the
  application remembers to add (ADR-0002).
- Personal data stays in AWS eu-west-2 and in as few stores as possible (section 6).
- Destruction past retention and crypto-shredding must reach every copy (section 5.1).
- The stack default is Postgres 17; a change of default needs an ADR (section 6).
- Volumes are small per tenant (tens to hundreds of people, thousands of notes a month).
- Names need accent-insensitive prefix matching; NHS numbers need exact matching.

## Considered options

- Postgres full-text search with `unaccent`, generated `tsvector` columns and GIN indexes, queried
  under the same RLS as the records (chosen).
- Amazon OpenSearch Service in eu-west-2, fed from the outbox.
- Postgres `pg_trgm` similarity search on names.

## Decision outcome

Chosen option: "Postgres full-text search", because the search runs as `harbour_app` inside
`withRequestContext`, so forced RLS (tenant and person scope) filters every result before the
application sees it, with no second store to secure, keep in step or shred.

1. **Configuration.** A `harbour_search` text search configuration with the `simple` dictionary
   (no stemming: names and short clinical words must not be stemmed) after `unaccent`. `unaccent` is
   not immutable, so generated columns call an immutable wrapper, `app.search_terms(text)`, with
   the dictionary named explicitly. Its output for the fixtures in `search.test.ts` must equal
   `searchTerms` in the domain package (rule 2), tested in the schema step.
2. **Index.** Generated `tsvector` columns on `person` (one for the names and preferred name, a
   second for the room label, so a break-glass search can match names alone), `tenant_user`
   (display name), `document` (title, display file name) and `care_note` (text). Each is indexed
   with a composite GIN index on `(tenant_id, <vector>)` using the `btree_gin` extension, so the
   tenant is the leading key.
3. **Query.** Every search query states `tenant_id = $1` first, with the tenant from the request
   context (the same value the RLS policy enforces), and then `<vector> @@ to_tsquery('harbour_search',
   $2)` with the prefix query from `normaliseSearchQuery` as a bound parameter; the whole-word query
   is a second bound parameter that marks each hit `exact` or `prefix` for ranking. NHS numbers are
   matched by equality on `person.nhs_number`. One query per kind, each limited to the plan's page
   size plus one, under RLS; the API then applies the plan again (`filterSearchResults`), ranks
   (`compareSearchHits`) and counts only what is visible. A break-glass search uses the whole-word
   query on the names vector only: no prefixes and no room labels.
4. **RLS and the planner.** Under forced RLS, Postgres uses a condition as an index condition ahead
   of the policy only when its operator is leakproof. Equality on `uuid` is leakproof, so the
   explicit `tenant_id = $1` uses the composite index; `@@` is not, so it is applied after the
   policy, within one tenant's rows, which is cheap at Harbour's per-tenant volumes. Two shortcuts
   are forbidden: marking `@@`, its functions or a wrapper `LEAKPROOF` (that lets the planner run
   user text against rows before the policy, a side channel through errors and timing), and running
   search through a `SECURITY DEFINER` function (that runs as the function's owner, which can bypass
   the caller's RLS). `app.search_terms` is `SECURITY INVOKER` and not leakproof.
5. **Offline.** The mobile app searches only what it has synced (already in scope), with the same
   `searchTerms` normalisation over SQLite; it never queries the server index offline. Offline
   results are labelled "This device only, last synced at HH:MM" so nobody takes them for a search of
   the whole organisation (HZ-002).

### Consequences

- Good, because tenant and person scope come from the same forced RLS policies as every other read,
  so a search bug cannot cross tenants or scopes.
- Good, because rows destroyed past retention take their `tsvector` with them; there is no index to
  purge separately and no new sub-processor or DPIA entry.
- Good, because there is no extra service to run, patch, monitor or pay for.
- Bad, because ranking and fuzzy matching are simpler than a search engine's; misspelt names are not
  found (accepted: a near match is a wrong-person risk, and the screen offers the NHS number).
  Ranking is done in the domain instead (people first, whole-word before prefix, then status, name
  and date of birth), with a same-name warning.
- Bad, because the `tsvector` holds note words in plain text, like the note column itself today.
  If the open envelope-encryption decision ([retention-and-deletion.md](../compliance/retention-and-deletion.md)
  section 4) encrypts note text, it must choose between keeping a lexeme index (backups then keep
  lexemes until they expire after 35 days, which crypto-shredding does not cover) and searching
  notes only within one person's record after decryption.
- Neutral, because generated columns add write cost to notes, measured against the 100 ms
  point-of-care budget in the schema step.

### Confirmation

The schema step adds: an isolation test that a search as each scope returns no row from another
tenant or outside scope (`hazard HZ-011`); a test that `app.search_terms` matches `searchTerms` on
the shared fixtures; an `EXPLAIN` check, run as `harbour_app` inside `withRequestContext`, that each
kind uses its composite index with `tenant_id` as the index condition; a catalogue check that no
search function or operator Harbour defines is `LEAKPROOF` or `SECURITY DEFINER`; and a timing check
against a 60-bed demo tenant.

## Pros and cons of the options

### Postgres full-text search

- Good, because isolation, retention and residency come with the database.
- Good, because it is the stack default and needs no new infrastructure.
- Bad, because relevance tuning is limited.

### Amazon OpenSearch Service

- Good, because of richer relevance, fuzzy matching and highlighting.
- Bad, because RLS does not apply: every query would need tenant and scope filters added by the
  application, and a missed filter leaks data (the failure ADR-0002 exists to prevent).
- Bad, because a second copy of personal data must be fed from the outbox, kept in step, isolated,
  destroyed with the records and covered by crypto-shredding.
- Bad, because of cost and operations for small per-tenant volumes.

### `pg_trgm` similarity on names

- Good, because it finds misspellings.
- Bad, because near matches on names are a wrong-person risk at the point of care (HZ-001); it can
  be added later behind a "did you mean" step that shows identity fields.

### As built (slice 13, migration 0065)

The composite GIN indexes in point 2 were not added. Point 4 holds: under forced row-level
security `@@` cannot be an index condition ahead of the policy, so the app role could never use a
GIN index on the vectors (an `EXPLAIN` test shows the tenant as the index condition and the match as
a filter). Each search reads the tenant's rows by an existing `tenant_id` index and filters them;
this is cheap at Harbour's per-tenant volumes and saves the write cost of a GIN index on every
note. The timing check against a 60-bed tenant remains the trigger to revisit (for example a
partial index per tenant, or a leakproof-safe design reviewed as a new ADR).

## More information

Revisit if a tenant's search exceeds the point-of-care budget at realistic volumes, if fuzzy name
matching is asked for (with a hazard review), or when the envelope-encryption ADR is written. To
change this decision, add an ADR that supersedes it.
