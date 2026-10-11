# Platform completions (`platform`) - specification

Phase 1 slice 13: search, the free full export, help and onboarding, and the DPIA with the
processing registers. Master prompt sections 9.1 (platform core), 5.1 (data protection) and 4
(tenancy and access). It extends [platform.md](platform.md); status per feature is in the
[feature register](feature-register.md). This slice is the spec and the domain rules; the schema,
API, web and mobile steps follow (section 9).

## 1. Purpose and register rows

| Row | Feature | This slice |
| --- | --- | --- |
| PLAT-013 | Permission-aware, tenant-scoped full-text search across people, staff, documents and notes | Rules 1 to 9, `packages/domain/src/platform/search.ts`, [ADR-0070](../decisions/0070-search-on-postgres-full-text.md) |
| PLAT-015 | Free full tenant export (CSV and JSON with documents, documented schema) | Rules 10 to 16, `export.ts` |
| PLAT-018 | In-app help and onboarding (guides, tenant onboarding checklist, sample data mode, status page link) | Rules 26 to 32, `onboarding.ts`, `sample-data.ts` |
| PLAT-023 | DPIA template prefill and in-app sign-off; records-of-processing and sub-processor registers | Rules 17 to 25, `dpia.ts`, `processing-register.ts`, `sub-processors.ts` |

## 2. Rules

Every rule has a table-driven test in `packages/domain/src/platform/` (named with its hazard ID
where one applies). Policy figures come from `rate_table` through `resolvePlatformRates`
(`access.agency.post_shift_hours`, `export.link_expiry_hours`, `dpia.review_interval_months`,
`sub_processor.notice_days`); none is a literal. Input bounds (query length, page sizes) are
validation limits in `SEARCH_LIMITS`, not policy figures.

### Search (PLAT-013)

1. **Who searches what.** The search box needs `platform.search.use`. Each kind of record then
   rests on the permission that already lets the user read it, so search never shows more than the
   record screens would:

   | Kind | Permission | Scope | Fields shown |
   | --- | --- | --- | --- |
   | People | `people.person.read` (identity fields) or `people.demographics.read` (names and rooms only, text queries only) | Person scope | Name, preferred name, date of birth, NHS number, photo, location, room, status; or name, preferred name, location, room, status |
   | Staff | Any of `platform.user.manage`, `platform.task.manage`, `people.assignment.manage`, `workforce.*.manage` | Tenant for tenant-scoped and HR roles; the user's locations for location-scoped roles | Name, roles, locations; never contact details or HR records |
   | Documents | `people.person.read` (documents about a person), `care.note.read` (care attachments), `platform.document.manage` (organisation documents) | Person scope for documents about a person; tenant for organisation documents | Title, category, display file name, person, date. Never the file's contents; photos are reached through the person |
   | Notes | `care.note.read` | Person scope | Person, excerpt, time, author. A note replaced by a correction is not shown; the correction is |

   External professionals, families, the person's own portal and inspectors have no search: they
   reach records through sharing decisions and evidence packs (HZ-022).
2. **Normalisation.** What is typed is refused above 200 characters before any other work, then
   read in one pass (`searchTerms`): lower case, compatibility decomposition, accents dropped,
   apostrophes inside a name joined ("O'Brien" is `obrien`), `ß`, `æ`, `ø`, `ł` and similar folded
   as Postgres `unaccent` folds them, every other character a separator. Terms shorter than 2
   characters are ignored, at most 6 are kept, each cut to 40 characters; the screen says how many
   were ignored. No regular expression runs over the user's text (each character is tested on its
   own), so the cost is linear and CodeQL's polynomial ReDoS check stays green. The prefix query
   (`ada:* & example:*`) holds only letters and digits and is always a bound parameter. The schema
   step's `app.search_terms` SQL function must give the same terms for the same text; it reuses
   the table in `search.test.ts` as its fixtures (ADR-0070).
3. **NHS numbers.** A query of digits, spaces and hyphens with exactly ten digits is an NHS number:
   it must pass the modulus 11 check (`validateNhsNumber`) and is matched exactly against
   `person.nhs_number`, never by prefix. A number with a wrong check digit is refused with "This is
   not a valid NHS number", never searched as near matches (HZ-001). Other digit strings are text.
   Names-and-rooms roles cannot search NHS numbers.
4. **Scope.** The plan carries the user's scope from `resolveAccess`: tenant, locations (with team
   narrowing once rotas define teams, Phase 2), or assigned people; people the user is assigned to
   count wherever they live. A role with person scope `none` searches no person records. Care
   record kinds need MFA; without it they are left out (and named as left out), and a user with
   nothing left gets "set up a second sign-in step".
5. **Time window.** Access ends at the earlier of the role assignment's end and, for agency and
   bank workers, the shift end plus `access.agency.post_shift_hours` (`agencyAccessEndsAt`). After
   that no plan is made, and a plan made earlier shows nothing.
6. **People who have left.** Discharged, deceased, archived and not-admitted people (and their
   documents and notes) are left out unless the user holds `platform.search.archived` (owner,
   Registered Manager, deputy, quality lead) and asks for them, so a former resident is not chosen
   for a current one of the same name (HZ-001). Results show the status as icon and word.
7. **Results never reveal what is out of scope.** Row-level security filters the query; the API
   then applies the plan again to every row (`filterSearchResults`). Counts, totals and "more"
   come only from what the user may see: an out-of-scope match looks exactly like no match. A row
   the plan drops is never shown or counted; `droppedByPlan` above zero means the database and the
   plan disagree, and the API raises a security alarm with opaque counts only (HZ-011).
8. **Audit.** Every search writes `platform.search.run` with the kinds searched and left out (with
   why), whether people who have left were included, the query kind (text or NHS number), the
   number of terms, and the result counts by kind. It never stores the words typed or the NHS
   number, not even hashed: searches are usually names, a hash of a name can be reversed by trying
   names, and the result counts plus the record views that follow (each audited with its record id)
   are enough to investigate misuse. Refused searches write `platform.search.refused` with the
   problem and no query.
9. **Break-glass search.** Finding a person outside scope is a separate path
   (`buildBreakGlassSearchPlan`): `platform.search.use` and `people.person.break_glass` with a
   fresh sign-in, MFA, a reason code (`BREAK_GLASS_REASON_CODES`) and a typed reason of 20 to 1,000
   characters. The query must be specific (an NHS number, or at least two name terms); results are
   people only, identity fields only, at most 10, tenant-wide. It writes
   `platform.search.break_glass` with the reason, the code and the opaque ids of the people shown;
   the weekly break-glass report lists these searches beside the openings (API step). Opening one of them is the existing break-glass
   step, which alerts the Registered Manager and the quality lead.

### Full export (PLAT-015)

10. **Contents.** One CSV (RFC 4180, UTF-8, header row) and one JSON Lines file per table under
    `tables/`, the documents under `documents/<id>.<extension>`, `destroyed.csv`, `schema.json`
    and `manifest.json`, as [data-standards.md](data-standards.md) "Export and import conventions"
    sets out. The tables come from the typed list `EXPORT_TABLES` (context, purpose, retention,
    personal data, columns never exported); `describeExportSchema` generates `schema.json` (JSON
    Schema 2020-12 per table) from the same plan, so the description cannot drift from the files.
11. **What goes in.** `exportRowDecision` and `exportDocumentDecision`, in this order:
    - destroyed past retention: not in its table file; listed in `destroyed.csv` with the
      destruction certificate id;
    - sample data: left out and counted (it is not the organisation's data);
    - under a legal hold: always in, even if soft-deleted, because the hold preserves it;
    - soft-deleted (deleted and awaiting destruction): left out and counted, as
      [retention-and-deletion.md](../compliance/retention-and-deletion.md) says;
    - everything else: in.

    Quarantined documents (failed or missed the malware scan) keep their row in `document.csv` but
    their bytes are not handed out (ADR-0031). Never exported: the `auth` schema (passwords,
    sessions, passkeys, authenticator secrets), `operator_user` (Thapsus's staff),
    `bank_holiday` (global reference data), global rows of `rate_table`, `retention_class` and
    `form_template` (only the organisation's own rows go), and the internal columns
    `document.storage_key`, `integration_connection.secret_ref` and `tenant_user.auth_user_id`.
12. **Download.** A ready export can be downloaded by the person who asked for it only, while they
    hold `platform.export.create` and have signed in again within the step-up window, until
    `export.link_expiry_hours` after it was ready (`checkExportDownload`). The link in the
    notification is a pointer to that check, not a bearer link: the API then streams the file or
    mints a storage URL that lasts minutes. At expiry the file is deleted, not just hidden. Another
    owner asks for their own export (HZ-070).
13. **Request.** Needs `platform.export.create` (owner) with step-up (`checkExportRequest`).
    Requested, ready, failed, downloaded, expired and revoked are audited.
14. **Completeness.** `buildExportManifest` checks what was written against the plan: every planned
    table has both files with the counted rows, no unplanned table appears, and every document's
    bytes match the SHA-256 recorded at upload. Any problem marks the export incomplete: it is
    failed and retried, never offered as if whole (HZ-071). Warnings (an undescribed table, a
    broken audit chain, a destroyed record without a certificate) are listed in the manifest and on
    the download page and do not block it.
15. **Free.** No charge, whatever the plan, payments or contract state: onboarding, active,
    suspended and closed organisations can export until their data is deleted after the contract
    ends (DPA clause 9). The only limit is abuse protection: one export at a time per
    organisation; asking again returns the one being prepared.
16. **Catalogue completeness.** A table in the database but not in `EXPORT_TABLES` is still exported
    in full and flagged `documented: false` (completeness wins). A domain test compares the list
    with the Drizzle schema files now; the schema step adds a test that runs
    `checkExportCatalogue` against the live database, so a new table cannot ship undescribed and a
    renamed secret column cannot slip back in.

### DPIA and registers (PLAT-023)

17. **Prefill.** `prefillDpia` fills [the DPIA template](../compliance/dpia-template.md) sections 1
    to 7 from the configuration: identification, screening (monitoring with home care, AI,
    children's homes), nature (locations, service types, modules, device modes, offline window,
    sub-processors, retention schedule version and overrides), scope (counts, data categories),
    purposes and lawful bases, necessity, and the template's risks R1 to R8, with R9 for home care
    monitoring. Optional processing adds its own section and risk: AI (AI addendum, R10), family
    portal photos (B8, R11) and marketing (B9, R12). The prefill takes planned modules as well as
    enabled ones, so the AI addendum can be signed before the module is switched on. Context,
    consultation, local risks and the tenant's own measures are the tenant's to complete.
18. **Missing configuration.** Legal name, CQC provider ID (for CQC-regulated providers), DPO, DPA
    signature date, privacy notice link, at least one location and, with AI, a provider. Each
    missing item is listed and blocks sign-off.
19. **Records of processing.** `recordsOfProcessingRegister` prefills Part B from
    `PROCESSING_PURPOSES` (B1 to B10, kept in step with
    [records-of-processing.md](../compliance/records-of-processing.md) by a test): B1 to B7 always,
    with the lawful basis for the tenant's sector; B8 with the family portal; B9 when marketing is
    switched on; B10 when the AI module is on and the tenant has switched on AI for free text.
    Consent is never the basis for B1 to B7 (tested). `tenantDataCategories` adds the categories
    each module brings (medicines, employment records, residents' money, visit locations, portal
    content, the AI log).
20. **Sign-off checks** (`checkDpiaSignOff`, every problem returned at once): the version is
    prepared; no configuration is missing; every tenant field is completed; every risk has a
    residual rating; a risk still high after its measures has an ICO prior consultation reference
    (Article 36); the typed-name signature is bound to the SHA-256 of the version read
    (`checkSignature`).
21. **Who signs.** A holder of `platform.dpia.sign` (owner, quality lead) who is named as the
    organisation's data protection officer or lead in its governance settings, and who did not
    prepare any part of that version (separation of duties, `dpia_sign_off`). An organisation whose
    only possible signer prepared the DPIA asks another person (for example the Registered
    Manager, who holds `platform.dpia.prepare`) to prepare it.
22. **Re-review.** A signed DPIA records its basis (purposes, sub-processors, data categories,
    modules). It falls due for review when a purpose, sub-processor, data category or module
    appears that it did not cover, and `dpia.review_interval_months` after sign-off (UK calendar
    months; 29 February falls back to 28 February). Removing processing never triggers a review.
    The AI module can be switched on only when a signed DPIA already covers it (master prompt 16);
    any other module may be switched on and flags the review (`checkFeatureEnable`).
23. **Sub-processor register.** `SUB_PROCESSORS` mirrors
    [sub-processors.md](../compliance/sub-processors.md) (a test keeps the names in step), and
    `subProcessorsInUse` shows each organisation only those its configuration uses: hosting, email,
    error monitoring and observability always; push and SMS providers once those channels are on;
    an AI provider only while the AI module is on (a tenant's own key is its own contract).
24. **Notices.** Thapsus notifies affected organisations before a new or replacement sub-processor
    processes their data. The notice period is also the window for objecting on reasonable data
    protection grounds (DPA clause 6.2). It is contractual, so it is a tenant setting
    (`sub_processor.notice_days`, default 30 from the DPA template, to verify), never statute; a
    change may not take effect before the longest period among the organisations it affects
    (`checkNoticeTiming`). Acknowledging or objecting needs `platform.dpia.sign`; an objection must
    come within the window and give its grounds (20 characters or more).
25. **Objections.** Once the window closes without an objection the change is deemed accepted. While
    an objection is open the new sub-processor does not process that organisation's data; after
    resolution it may only if the objection was withdrawn, not if Thapsus agreed not to use it for
    them or they ended the affected services (`mayProcessTenantData`).

### Help and onboarding (PLAT-018)

26. **Checklist** (`onboardingChecklist`). Each item is worked out from state:

    | Item | Done when | Blocks go-live |
    | --- | --- | --- |
    | Locations identified | Every active location has a valid CQC location ID (`1-` and digits) or, under another regulator, its regulator ID, and an ODS code (3 to 10 upper-case letters and digits) | Yes |
    | Registered managers | Every active location has a Registered Manager assigned | Yes |
    | First users with MFA | Someone other than the owner has joined, and every active user who reads care records has TOTP or a passkey | Yes |
    | Settings reviewed | Every tenant-default rate-table setting has a decision (accepted or the tenant's own value) made since Harbour last changed it | No |
    | Retention reviewed | The staff file option is chosen; every other class is accepted or lengthened, or, for classes set by tenant policy (CCTV, superseded organisation documents), has a period set or is marked not used; each decision made since the class last changed | Yes |
    | DPIA signed | The DPIA is signed and not due for review | Yes |
    | Sub-processors acknowledged | Every sub-processor in use is acknowledged since its entry last changed | No |
    | National data opt-out | The organisation has said whether it uses care data beyond direct care; if it does, every current person's opt-out status has been checked | No |
    | Sample data removed | No sample data remains | Yes |

27. **State, not ticks.** No item can be ticked by hand where state can tell. Where a person must
    decide (a setting, a retention class, a sub-processor), the decision is a record with who and
    when, and Harbour's later change to the default reopens it. Each item gives its reason in plain
    English from the same state ("1 location needs a valid regulator location ID or ODS code") and
    links an in-app guide by its key (`guide`).
28. **Help.** In-app guides are keyed by the checklist items and screens; the status page link in
    the help menu comes from configuration once the hosted page exists (H-12, H-116).

### Sample data mode (PLAT-018)

29. **Flagged and plainly invented.** Every sample row carries a sample flag and a batch id. Sample
    people have the family name "Example", 999-range NHS numbers with valid check digits and
    `example.invalid` email addresses (`checkSamplePerson`).
30. **Never mixed with real people.** Sample data loads only for the owner
    (`platform.onboarding.manage`) and only before any real person exists; the first real person
    can be added only after the sample data has gone (`checkSampleDataLoad`,
    `checkRealPersonCreation`). A record about sample people is sample; a record linking sample and
    real records is refused (`sampleFlagForNewRecord`). Staff accounts are real and may practise on
    sample people.
31. **Kept out.** Sample records take part in no statutory notification or clock, regulatory
    return, full export, report or dashboard, bill or seat count, outbound message or integration
    (`SAMPLE_DATA_EXCLUSIONS`).
32. **Removed in one step.** Removal deletes the whole batch or nothing: every row must be sample,
    none under a legal hold, none referred to by a real record (`checkSampleDataRemoval`). Audit
    events about sample records stay (opaque ids only) and the removal is audited.

## 3. Permissions

From `packages/domain/src/platform/permissions.ts` (matrix, generated:
[permissions.md](permissions.md)).

| Permission | Allows | Held by (built-in roles) |
| --- | --- | --- |
| `platform.search.use` (new) | Search what the user can already see | Owner, group executive, Registered Manager, deputy, clinical lead, team leader, care worker, agency worker, care coordinator, administrator, HR, quality lead |
| `platform.search.archived` (new) | Include people who have left, and their records | Owner, Registered Manager, deputy, quality lead |
| `people.person.break_glass` (existing) | Break-glass search, with step-up and a reason | Owner, Registered Manager, deputy |
| `platform.export.create` (renamed from `platform.data.export`; step-up) | Ask for and download the full export | Owner |
| `platform.onboarding.read` (new) | See the onboarding checklist | Owner, Registered Manager, deputy, quality lead |
| `platform.onboarding.manage` (new) | Load and remove sample data; record onboarding decisions | Owner |
| `platform.dpia.read` (new) | Read the DPIA, records of processing and sub-processor register | Owner, group executive, Registered Manager, deputy, quality lead |
| `platform.dpia.prepare` (new) | Prepare the DPIA and keep the registers current | Owner, Registered Manager, quality lead |
| `platform.dpia.sign` (now also the quality lead) | Sign the DPIA as the named lead; answer sub-processor notices | Owner, quality lead |

Existing tenants' role copies gain the new permissions, and have `platform.data.export` renamed,
through a data migration in the schema step (roles are versioned per tenant; the migration adds a
new version). No API route used `platform.data.export`.

## 4. Audit events

| Event | When | Holds |
| --- | --- | --- |
| `platform.search.run` | A search ran | Kinds searched and left out, archive flag, query kind, term count, result counts; never the query |
| `platform.search.break_glass` | A break-glass search ran | As above, plus the typed reason, reason code and the opaque ids of the people shown |
| `platform.search.refused` | A search was refused | The problem and kinds asked for; never the query |
| `platform.export.requested`, `.ready`, `.failed`, `.downloaded`, `.expired`, `.revoked` | Export lifecycle | Export id, requester, row and document counts, bytes, manifest SHA-256, problems and warnings; never row contents |
| `platform.dpia.prepared`, `.signed`, `.review_due` | DPIA lifecycle | Version, SHA-256, signer, basis, triggers |
| `platform.sub_processor.acknowledged`, `.objected`, `.objection_resolved` | Notice responses | Notice id, who, when, resolution (the grounds are in the record, not the event) |
| `platform.onboarding.sample_loaded`, `.sample_removed`, `platform.setting.decided`, `platform.retention.decided` | Onboarding | Batch id and row counts; setting key or record class and decision kind |

## 5. Retention classes

| Record | Class |
| --- | --- |
| Search audit events | `audit_event` |
| Export records (who asked, when, status, manifest SHA-256, counts) | `audit_event` |
| Export files | Deleted at `export.link_expiry_hours` after they are ready; never kept as records |
| DPIA versions, sign-offs, sub-processor responses, setting and retention decisions | `audit_event` as an interim class (accountability evidence, 8 years from creation); the DPO confirms or sets a period (H-115) |
| Sample data | Removed on demand; never retained |
| Onboarding checklist | Not stored: worked out from state |

## 6. Schema for the schema step (expand only)

| Table or column | Kind | Key columns |
| --- | --- | --- |
| Search index | Generated `tsvector` columns and GIN indexes ([ADR-0070](../decisions/0070-search-on-postgres-full-text.md)) | `person` (names, preferred name, room), `tenant_user` (display name), `document` (title, file name), `care_note` (text); `app.search_terms(text)` immutable function matching rule 2 |
| `tenant_export` | Mutable, versioned | Status (`EXPORT_STATUSES`), requested by, requested at, ready at, expires at, revoked at, schema version, storage key, bytes, manifest SHA-256, problems and warnings (JSON) |
| `dpia` | Mutable, versioned | Version, status (`draft`, `prepared`, `signed`, `superseded`), prefill (JSON), answers by section (JSON), residual ratings, ICO reference, prepared by (array), version SHA-256, signed by, signed at, typed name, statement, basis (JSON) |
| `sub_processor_notice` | Global (Thapsus) | Sub-processor key, kind, use, announced at, effective from |
| `sub_processor_response` | Append-only | Notice, acknowledged at and by, objection at, by and grounds, resolution and when |
| `tenant_setting_decision`, `retention_decision` | Append-only | Rate key or record class, decision kind, decided by and at |
| `tenant` | Add columns | Designated data protection lead (tenant user), sector, privacy notice link, `uses_data_beyond_direct_care`, marketing and AI-on-free-text switches, AI provider |
| `person` | Add column | `national_data_opt_out_checked_at` (the boolean alone cannot say "not checked") |
| Sample flag | Add columns | `is_sample` and `sample_batch_id` on person-related tables, or a `sample_batch` table with the flag on `person` and inheritance by scope |
| `rate_table` | Add column | `tenant_default` (boolean), replacing `tenantDefaultRateKeys`' reading of the source text |

## 7. Data standards

[data-standards.md](data-standards.md) gains the export manifest fields and code lists for
`tenant_export.status`, DPIA status and residual risk levels, retention decision kinds, notice
states and objection resolutions, and the sample flag. The export shape itself is the contract
already set out there; `EXPORT_SCHEMA_VERSION` (1.0.0) is bumped on any change to it.

## 8. Clinical safety and data protection

Hazards: HZ-001 (wrong person chosen from search results: identity fields, closed records hidden by
default, exact NHS number match), HZ-011 (search scope, counts and break-glass search; agency
window), and new HZ-070 (full export disclosed beyond the organisation), HZ-071 (full export
incomplete or misread when a provider changes system) and HZ-072 (sample data mistaken for or
mixed with real records). See the [hazard log](../clinical-safety/hazard-log.md). Nothing here
scores, predicts or recommends care ([medical-device-boundary.md](../compliance/medical-device-boundary.md)).

Data protection: search audit, export records, DPIA records, notice responses and onboarding
decisions are new processing under B5 (accountability) in the
[records of processing](../compliance/records-of-processing.md). The export goes to the controller
itself, so it is not a disclosure to a third party, but it holds every category and is delivered
only as rule 12 says.

## 9. Acceptance criteria and tests

- Domain (built): `search.test.ts` (normalisation table, NHS numbers, plans by role, scope, MFA,
  agency window, people who have left, break-glass, result filtering and counts, audit without
  the query); `export.test.ts` (catalogue against the Drizzle schema, plan, row and document rules,
  schema description, manifest completeness, request and download); `processing-register.test.ts`,
  `sub-processors.test.ts` and `dpia.test.ts` (purposes and sub-processors in step with the
  compliance docs, register by configuration, notices and objections, prefill, sign-off, re-review,
  the AI gate); `onboarding.test.ts` (every item done and not done from state, identifiers, sample
  data). Role grants in `access.test.ts`.
- Database (schema step): RLS and HZ-011 isolation for every new table; `app.search_terms` gives
  the terms in `search.test.ts`; a search query returns nothing from another tenant or outside
  scope; `checkExportCatalogue` against the live schema; append-only grants on
  `sub_processor_response` and the decision tables.
- API: search routes with the plan, the second filter and the audit event (`hazard HZ-011`); export
  request, worker, manifest and download (`hazard HZ-070`, `hazard HZ-071`); DPIA prepare and
  sign-off; notice responses; onboarding checklist and sample data load and removal (`hazard
  HZ-072`); every route audited.
- Web and mobile: search with the people-who-have-left toggle and break-glass dialog; export page;
  DPIA and registers under Settings, Data protection; onboarding checklist with icon and word for
  each status; sample data banner on every screen while it exists; axe on each page.

## 10. As built (slice 13, domain rules)

Domain modules, all pure and exported from `@harbour/domain`: `search.ts`, `export.ts`,
`processing-register.ts`, `sub-processors.ts`, `dpia.ts`, `onboarding.ts`, `sample-data.ts`;
`resolvePlatformRates` in `rates.ts`; the `dpia_sign_off` duty rule; the new permissions and role
grants. 418 new tests (2,254 in the package, 99.7% line coverage). Three rate-table rows added, all
to verify. No schema, migration, API, web or mobile change in this slice.

## 11. Open questions

- Retention of DPIA records, export records and onboarding decisions beyond the interim
  `audit_event` class (H-115).
- Whether a one-person organisation whose owner is the only possible signer needs an exception to
  rule 21 (H-115).
- The DSCR data migration standard's schema, to confirm the export meets it (H-120).
- Searching note text after envelope encryption of free text is decided (ADR-0070, revisit).
