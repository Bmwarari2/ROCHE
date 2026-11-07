# Plan: the product rename to Thapsus Care (ADR-0127)

Prepared on 07/11/2026 on `docs/rename-plan-thapsus-care`, from `main` at e02aead7, and **applied on
the same branch on 07/11/2026 after merge batch 4 (#180, `main` at 17a5dbbe)**: 2,885 changes in 363
files (section 8). The inventory below is from e02aead7.

## 1. What changes and what stays

The rule (ADR-0127): **"Thapsus Care" wherever a person reads the name; "Harbour" stays in technical
identifiers.** The script touches only the capitalised whole word `Harbour`, so lower- and
upper-case identifiers are safe by construction.

### Changes (in scope)

| Area | Files | Occurrences | Notes |
| --- | --- | --- | --- |
| `docs/specs` | 16 | 860 | Specifications; `data-standards.md` names Harbour's own code lists ("Harbour (`STOCK_MOVEMENTS`)") |
| i18n `en-GB.json` | 1 | 260 | Web words, including `app.name` (the web title, `applicationName` and every page title template) and the possessives ("Harbour's target") |
| i18n `cy.json` | 1 | 260 | Welsh catalogue (still English placeholders for these keys) |
| `docs/user-guides` | 71 | 224 | Every role's guide |
| `docs/clinical-safety` | 7 | 189 | Safety case and hazard log |
| `docs/plans` | 6 | 168 | STATUS, phase plans, human actions, recommended answers |
| `docs/compliance` | 17 | 159 | Records of processing, DPIA, medical-device boundary, sub-processors, app store privacy |
| Code, tests (`apps/web`) | 44 | 113 | Test names and assertions on the words |
| Code, source (`packages/domain`) | 27 | 123 | Domain messages people read (export catalogue descriptions, refusals, notices) |
| Code, source (`apps/api`) | 49 | 90 | API problem titles and details, the OpenAPI title ("Harbour API"), email body text, `appName`, the authenticator issuer and passkey display name |
| i18n `mobile.en-GB.json`, `mobile.cy.json` | 2 | 128 | Mobile words |
| Code, tests (`apps/api`, `apps/mobile`, `packages/domain`, `packages/db`, `packages/ui`) | 69 | 147 | Test names and assertions |
| `docs` (other), READMEs, `CLAUDE.md`, `.claude` agents and skills | 21 | 57 | Including `docs/01-CONSTRAINTS.md`, the runbooks, `docs/demo`, `packages/ui/CONTENT.md` |
| Code, source (`apps/mobile`) | 13 | 25 | `app.config.ts` `name` (the home-screen name) and the iOS permission prompts (Face ID, camera, location, microphone) |
| Code, source (`apps/web`, `packages/contracts`, `packages/ui`) | 11 | 13 | `AppBar`'s default `productName`, contract descriptions |
| Maestro flow | 1 | 1 | `hazard-HZ-028-round-on-the-phone.yaml` matches "in Harbour on the web" |
| **Total** | **356** | **2,817** | `node scripts/rename-product.mjs` (dry run) |

The script also leaves, by design: ADRs (`docs/decisions/`), the changelog fragments and
`CHANGELOG-DEV.md`, code comments, migrations and generated files, and any `Harbour` inside a host
name, address or URL (a `.` `/` `@` before it, or `.x`, `@` or `://` after it, as in
`Family.Harbour.Example`), so test domains and links keep working.

Done by hand (the script leaves them):

- `docs/00-MASTER-PROMPT.md`: line 19 ("a working codename …") and the Appendix row "Product name and
  domain" are rewritten to record the decision; the rest of the file is in the script's scope.
- `apps/mobile/README.md`: the `xcodebuild` line names `ios/Harbour.xcworkspace` and the scheme. Expo
  prebuild names the iOS project after `name`, so after the rename run `expo prebuild` once and copy
  the real workspace and scheme names into the README (the bundle id does not change).
- The OpenAPI document and the generated client are regenerated, never edited.

### Stays (out of scope, with the reason)

| What | Examples | Why |
| --- | --- | --- |
| Package names | `@harbour/api`, `@harbour/ui` | Internal; renaming touches every import and the lockfile for no user benefit |
| Environment variables | `HARBOUR_TEST_ADMIN_URL`, `HARBOUR_SEED_DEMO` | Set in Secret Manager, CI and every runbook |
| Database roles, schemas, migrations | `harbour_app`, `harbour_owner`, `harbour_member_owner`; migrations on `main` | Roles are in grants and RLS policies; migrations on `main` are frozen |
| API header and cookies | `x-harbour-tenant` | A public contract with web and mobile; a rename is a breaking API change |
| Mobile identity | Expo `slug`, deep link `scheme: "harbour"`, iOS and Android bundle ids | Changing them makes a different app in the stores and breaks links already sent |
| Passkey relying party id | `PASSKEY_RP_ID` (a domain) | Changing it orphans every registered passkey |
| Cloud and infrastructure | Terraform `harbour_stack`, resource names, Artifact Registry, PowerSync, Docker | Renames recreate resources; operators only |
| Code comments | `// Harbour never …` | Not read by users; the codebase keeps its codename |
| Frozen history | Accepted ADRs (other than 0127), `docs/changelog-dev/*`, `docs/CHANGELOG-DEV.md` | They record what was true when written |
| Demo and fixture names | "Harbour House", "Harbour Lodge", "Harbour Mews", "Harbour Demo Care", "Harbour Quay", "Harbour Field", "Harbour Cottage", "Harbour Example Care" | Invented places and organisations in seeds, fixtures, Storybook and journeys (about 275 uses); renaming them churns every e2e selector. **Decided 07/11/2026 (lead): kept**; the script skips them by one pattern |

## 2. Stored data that carries the name

Words in the code change with the release; rows already stored do not. On a database seeded from
`main` the query in section 6 finds:

| Table and column | Rows | Source | Change by |
| --- | --- | --- | --- |
| `audit_starter_template.source` | 7 | Migration 0081 ("Harbour starter template …") | A forward data migration in the rename release |
| `rate_table.source` | 86 | Seeded from `docs/specs/rates.md` ("Harbour default …") | Re-seeding reference data after the docs change, or the same migration |
| `retention_class.source`, `.notes` | 7, 3 | Seeded from `docs/specs/retention.md` | As `rate_table` |
| `tenant.name`, `.legal_name`, `.brand_name`; `location.name`; `service.name` | Demo only | The demo seed ("Harbour Demo Care", "Harbour House") | Not changed (demo names are kept) |

Run the query again after batch 4 (new tables may seed words) and before writing the migration. A
tenant's own copies (for example audit templates adopted from a starter) keep the tenant's words.

## 3. The procedure (one pass, after batch 4 merges)

1. When batch 4 is on `main` (and before user guides 81 and 82), merge `main` into
   `docs/rename-plan-thapsus-care` and freeze user-facing word changes on other branches until the
   rename merges. One PR carries the plan, the rename, the migration and the CI step.
2. `node scripts/rename-product.mjs` (dry run) and compare with this inventory; investigate any area
   that grew.
3. `node scripts/rename-product.mjs --apply`.
4. The hand edits in section 1 (master prompt line 19 and the Appendix row).
5. `pnpm --filter @harbour/api openapi && pnpm --filter @harbour/contracts generate:client`.
6. `pnpm exec biome check --write apps packages`, then `pnpm lint` and `pnpm typecheck`.
7. The forward data migration (section 2, the next free migration number at the time, asked of the
   lead) for `audit_starter_template.source`, and `rate_table` and `retention_class` sources by the
   same migration or a re-seed, with a database test on a private Postgres.
8. Every suite, the database suites included (on a private Postgres), Playwright with axe, the
   Maestro flows; fix `smtp.test.ts` as section 7 says (decode the body, keep the full wording).
9. Add `node scripts/rename-product.mjs --check` as a CI step so the old name cannot come back.
10. Reviews: accessibility (words, lengths, screen-reader names) and clinical safety (the safety
    case and hazard log read correctly; no control's meaning changed). A changelog fragment and a
    STATUS entry.

### Trial run (07/11/2026)

The script was applied to a working copy of `main` (e02aead7), checked and reverted. Results are in
section 7.

## 4. Visual baselines and artefacts to refresh

No screenshot baselines are committed today (no `toHaveScreenshot`, no Storybook snapshots, no
images in `docs/`), so nothing in the repository needs a baseline refresh. Outside the repository:

- App store listings and screenshots (iOS and Google Play): new name, new screenshots.
- The app icon and splash screen when a brand mark exists (none in the repository yet).
- Lighthouse CI budgets: re-run; longer titles must not shift layout.
- Storybook: rebuild and review `AppBar` (default product name) and any story naming the product.
- A PWA manifest does not exist yet; when one is added it uses `app.name`.
- Printed or saved PDFs (downtime packs, transfer packs, evidence packs) already issued keep the old
  name; new ones use the new name.

## 5. Human actions

In [human-actions.md](human-actions.md); numbers from the lead.

- H-1511: confirm the name "Thapsus Care" after a UK trade mark register search and app store name
  checks (master prompt Appendix "Product name and domain").
- H-1512: choose the production domain and the email sender display name (`Thapsus Care <…>`).
- H-1513: update the app store listings, privacy notice, DPIA wording and sub-processor notices that
  name the product, and tell any pilot tenant before the release (existing authenticator entries keep
  the old label until re-enrolled).

The demo names were decided by the lead on 07/11/2026 (kept), so they are not a human action.

## 6. Finding stored rows with the name

Run as the database owner on each environment (it reads every text column in `public`):

```sql
DO $$
DECLARE r record; n bigint;
BEGIN
  FOR r IN SELECT c.table_name, c.column_name FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
           WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
             AND c.data_type IN ('text', 'character varying', 'jsonb', 'json')
           ORDER BY 1, 2 LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I::text ~ %L',
      r.table_name, r.column_name, '\mHarbour\M') INTO n;
    IF n > 0 THEN RAISE NOTICE '%.%: %', r.table_name, r.column_name, n; END IF;
  END LOOP;
END $$;
```

## 7. Trial run results

Applied to a working copy of `main` at e02aead7 on 07/11/2026, checked, then reverted (nothing is
committed except the script and these documents).

| Check | Result |
| --- | --- |
| OpenAPI and client regeneration | Clean |
| `pnpm typecheck` | Clean |
| i18n, web, mobile, ui, contracts, sync suites | All pass (48, 2,542, 1,413, 360, 34, 96) |
| Domain suite | 1 failure on the first trial: a link test whose host is `Family.Harbour.Example`. The script now skips host names; the test passes |
| API suite | 2 failures on the first trial: the SMTP sender domains test (a host name, now skipped, passes) and `smtp.test.ts` (below) |
| Seed, web build and the two Playwright journeys run | Pass |

**One real change for the rename PR**: `apps/api/src/integrations/smtp.test.ts` ("sends a plain-text
message with the title and the link, and nothing else") looks for the substring "Open Thapsus Care
to see the details:", but the longer line is folded by the email transfer encoding, so the substring
is no longer contiguous in the raw message. Decode the body in the test (or compare the parsed text),
rather than shortening the wording. Nothing else in the code depends on the name's length.

Not run in the trial: the database suites against a private Postgres for every package, the Maestro
flows (needs a device) and Lighthouse; run them in the rename PR.

## 8. Applied (07/11/2026)

After merging `main` at 17a5dbbe (batch 4, migrations to 0151):

- `node scripts/rename-product.mjs --apply`: 2,885 in 363 files. The growth since the inventory
  (2,817 in 356) is batch 4's new words: the Thapsus-HR guides and screens, the medicines spec and
  hazard log rows, and 11 more catalogue keys.
- Hand edits: the master prompt's assumption line and its Appendix row now record the decision (the
  script's `--check` allows those two lines, which name the codename on purpose); `phase-1-gate.md`'s
  `xcodebuild` line names `ios/ThapsusCare.xcworkspace` and the scheme `ThapsusCare`, which is what
  Expo's prebuild makes of `name: "Thapsus Care"` (it drops the space). Nothing committed refers to
  the old iOS project name.
- OpenAPI and the client regenerated (descriptions and the title only, no breaking change); Biome
  re-wrapped 22 files whose lines grew.
- Migration 0152 renames the stored rows: the seven `audit_starter_template.source` rows and the
  global `rate_table` and `retention_class` sources and notes (a re-seed gives the same result).
  The query in section 6 on a database migrated and seeded from this branch finds only the demo
  names (`tenant`, `location`, `service`), which stay.
- `smtp.test.ts` reads the decoded body (quoted-printable folds the longer line) and checks the full
  wording with the link.
- CI runs `node scripts/rename-product.mjs --check` in the checks job.
- The full suites found two expectations written as regular expressions (`/Harbour sets this/`),
  which the script had taken for paths; it now treats a `/` as a path only after a path character,
  and renamed them. The iCalendar `PRODID` (`-//Thapsus Cargo Ltd//Harbour//EN`) is an identifier
  and stays.

### Reviews (07/11/2026)

The accessibility and clinical safety reviewers read the whole diff. Fixed in the same PR:

- HZ-133: the HR link tests remove the product's own name and then refuse any "Thapsus", in every
  state of the form and in `aria-label`, `title`, `alt` and `placeholder`, with leaked details
  spelt five ways (hyphen, en dash, non-breaking space, "Human Resources", "Thapsus" alone).
- HZ-013: the test also checks the s42 deadline is not statutory.
- Demo names the script had renamed ("Harbour Care Ltd", "Harbour Croft", "Harbour Wynd" and the
  rest of the test locations) are back and in the script's demo pattern; "Care Care" is gone from
  the master prompt title and the Article 28 template.
- Wording: `app.description`; the breach notice strings name the supplier as Thapsus Cargo Ltd; the
  record history says "Changed by the system (Thapsus Care)"; seven sentences that named the
  product twice now say it once.
- The script exports its rules, skips the 0152 test that must name the codename, and has unit
  tests (`pnpm test:scripts`), including `--check` on the tree.

Left for the CSO: H-1514 (safety case note), H-1515 (a name ending in "Care"; the lone-worker help
wording) and H-1516 (citing the design document as a source).
