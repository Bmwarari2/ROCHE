# Search index runbook

The search vectors are stored generated columns ([ADR-0070](../decisions/0070-search-on-postgres-full-text.md),
migration 0066): `person.search_names` and `person.search_room`, `tenant_user.search_name`,
`document.search_title` and `care_note.search_body`. Each is `app.search_vector(...)` of its row's
own columns, and `app.search_terms` must give the same terms as `searchTerms` in `@harbour/domain`
(platform-completions.md rule 2). This runbook covers deploying migration 0066 where tenants are
live, and rebuilding the vectors after a Postgres upgrade.

## 1. Deploying migration 0066

Adding a stored generated column rewrites the table under an `ACCESS EXCLUSIVE` lock: nothing can
read or write `care_note`, `person`, `document` or `tenant_user` until the rewrite ends. The
migration sets `lock_timeout = '5s'`, so it fails fast instead of queueing behind a long
transaction and blocking every request behind it; it is forward-only and safe to run again.

**Before go-live (now): run it with the release.** The tables are small (demo and pilot data);
the rewrite takes seconds.

**With live tenants: a maintenance window.**

1. Measure first on a restored copy of production (the [restore runbook](restore.md), scenario A):
   time the migration and note the table sizes. Plan a window of three times that, at least 15
   minutes, at night (UK time), outside medicines rounds.
2. Tell the Registered Managers of every tenant 7 days before: the web app is unavailable for the
   window; the mobile app keeps working offline and syncs afterwards (HZ-002).
3. In the window: put the API in maintenance mode, check no long transactions are open
   (`SELECT pid, now() - xact_start FROM pg_stat_activity WHERE state <> 'idle'`), run
   `pnpm db:migrate`, then run the checks in section 3.
4. If the migration fails on the lock timeout, find and end the blocking transaction, then run it
   again. If it fails for another reason, nothing was changed (one transaction): leave maintenance
   mode and raise it with engineering.

**Batched alternative, if no window is acceptable** (an expand step in its own ADR amendment,
not built): add each vector as a plain nullable `tsvector` column (no rewrite), keep it current with
a `BEFORE INSERT OR UPDATE` trigger calling `app.search_vector`, backfill existing rows in batches
of a few thousand by id as `harbour_owner` (for append-only `care_note` through a security-definer
backfill function owned by a no-login role, since the app role has no UPDATE), and only then let the
search route read the column. Search shows partial results until the backfill finishes, so the
route stays behind its flag until then.

## 2. After a Postgres upgrade or a change to `unaccent`

`app.search_terms` depends on `normalize`, Unicode tables and the `unaccent` rules, which can change
between Postgres versions. The stored vectors keep the old terms until each row is rewritten, so a
name stored under the old rules may no longer match the same name typed under the new ones: the
right person is not found and someone else may be chosen (HZ-001).

1. Before the upgrade, on a restored copy with the new version, run
   `pnpm --filter @harbour/db exec vitest run test/search-index.test.ts`. If the terms test fails,
   the rules changed: fix `app.search_terms` (a new migration) so it matches `searchTerms` again.
2. After the upgrade, in a maintenance window as in section 1, rebuild every vector as
   `harbour_owner` (Postgres 17 rewrites the column with its current expression):

   ```sql
   SET lock_timeout = '5s';
   ALTER TABLE person ALTER COLUMN search_names SET EXPRESSION AS
     (app.search_vector(given_name || ' ' || family_name || ' ' || coalesce(preferred_name, '')));
   ALTER TABLE person ALTER COLUMN search_room SET EXPRESSION AS (app.search_vector(room_label));
   ALTER TABLE tenant_user ALTER COLUMN search_name SET EXPRESSION AS (app.search_vector(display_name));
   ALTER TABLE document ALTER COLUMN search_title SET EXPRESSION AS
     (app.search_vector(title || ' ' || coalesce(file_name, '')));
   ALTER TABLE care_note ALTER COLUMN search_body SET EXPRESSION AS (app.search_vector(body));
   ```

   The expressions must be the ones in `packages/db/src/schema` (`searchVector`); copy them from
   there, not from this page, if they differ.
3. Run the checks in section 3 and record the rebuild in the change log.

## 3. Checks

- `SELECT app.search_terms('Zoë O''Brien Straße')` returns `{zoe,obrien,strasse}`.
- For one test person on the demo tenant, a search by name, by preferred name and by NHS number
  finds them, and a search as a care worker finds only their assigned people.
- No `ERROR` lines mentioning `tsvector` or `search_` in the API log for 15 minutes after.
