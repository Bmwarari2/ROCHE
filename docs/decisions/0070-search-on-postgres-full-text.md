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
2. **Index.** Generated `tsvector` columns with GIN indexes on `person` (names, preferred name, room
   label), `tenant_user` (display name), `document` (title, display file name) and `care_note`
   (text), each with `tenant_id` leading the composite indexes used by the planner.
3. **Query.** `to_tsquery('harbour_search', $1)` with the prefix query from `normaliseSearchQuery`
   as a bound parameter; NHS numbers by equality on `person.nhs_number`. One query per kind, each
   limited to the plan's page size plus one, under RLS; the API then applies the plan again
   (`filterSearchResults`) and counts only what is visible.
4. **Offline.** The mobile app searches only what it has synced (already in scope), with the same
   `searchTerms` normalisation over SQLite; it never queries the server index offline.

### Consequences

- Good, because tenant and person scope come from the same forced RLS policies as every other read,
  so a search bug cannot cross tenants or scopes.
- Good, because rows destroyed past retention take their `tsvector` with them; there is no index to
  purge separately and no new sub-processor or DPIA entry.
- Good, because there is no extra service to run, patch, monitor or pay for.
- Bad, because ranking and fuzzy matching are simpler than a search engine's; misspelt names are not
  found (accepted: a near match is a wrong-person risk, and the screen offers the NHS number).
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
the shared fixtures; an `EXPLAIN` check that each kind uses its GIN index; and a timing check
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

## More information

Revisit if a tenant's search exceeds the point-of-care budget at realistic volumes, if fuzzy name
matching is asked for (with a hazard review), or when the envelope-encryption ADR is written. To
change this decision, add an ADR that supersedes it.
