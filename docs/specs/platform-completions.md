# Platform completions (`platform`) - specification

Phase 1 slice 13: search, the free full export, help and onboarding, and the DPIA with the
processing registers. Master prompt sections 9.1 (platform core), 5.1 (data protection) and 4
(tenancy and access). It extends [platform.md](platform.md); status per feature is in the
[feature register](feature-register.md). This slice is the spec and the domain rules; the schema,
API, web and mobile steps follow (section 9). Revised after the clinical and security reviews.

## 1. Purpose and register rows

| Row | Feature | This slice |
| --- | --- | --- |
| PLAT-013 | Permission-aware, tenant-scoped full-text search across people, staff, documents and notes | Rules 1 to 9, `packages/domain/src/platform/search.ts`, [ADR-0070](../decisions/0070-search-on-postgres-full-text.md) |
| PLAT-015 | Free full tenant export (CSV and JSON with documents, documented schema) | Rules 10 to 16, `export.ts`, `export-catalogue.ts` |
| PLAT-018 | In-app help and onboarding (guides, tenant onboarding checklist, sample data mode, status page link) | Rules 26 to 32, `onboarding.ts`, `sample-data.ts` |
| PLAT-023 | DPIA template prefill and in-app sign-off; records-of-processing and sub-processor registers | Rules 17 to 25, `dpia.ts`, `processing-register.ts`, `sub-processors.ts` |

## 2. Rules

Every rule has a table-driven test in `packages/domain/src/platform/` (named with its hazard ID
where one applies). Policy figures come from `rate_table` through `resolvePlatformRates`
(`access.agency.post_shift_hours`, `export.link_expiry_hours`, `export.link_expiry_hours_max`,
`break_glass.search_max_per_day`, `dpia.review_interval_months`, `sub_processor.notice_days`);
none is a literal. Input bounds (query length, page sizes, the 5-minute download URL) are
technical limits, not policy figures. A "step-up" in this spec is always a sign-in completed with
the second step (TOTP or a passkey) within the step-up window.

### Search (PLAT-013)

1. **Who searches what.** The search box needs `platform.search.use`. Each kind of record then
   rests on the permission that already lets the user read it, so search never shows more than the
   record screens would:

   | Kind | Permission | Scope | Fields shown |
   | --- | --- | --- | --- |
   | People | `people.person.read` | Person scope | Name, preferred name, date of birth, NHS number, photo, location, room, status |
   | People | `people.demographics.read` (names-and-rooms roles such as the administrator, who record visitors, moves and incidents; text queries only) | Person scope | Name, preferred name, photo, age (never the date of birth), location, room, status |
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
   (`ada:* & example:*`) and the whole-word query (`ada & example`) hold only letters and digits and
   are always bound parameters. The schema step's `app.search_terms` SQL function must give the same
   terms for the same text, using the table in `search.test.ts` as fixtures (ADR-0070).
3. **NHS numbers.** Digits with spaces, hyphens or dots between them and 9 to 11 digits in all are an
   attempted NHS number. Exactly ten digits without dots must pass the modulus 11 check
   (`validateNhsNumber`) and are matched exactly against `person.nhs_number`, never by prefix. A
   wrong check digit, 9 or 11 digits, or a dotted number is refused with "This is not a valid NHS
   number", never searched as text or near matches (HZ-001). Names-and-rooms roles cannot search NHS
   numbers.
4. **Scope.** The plan carries the user's scope from `resolveAccess`: tenant, locations (with team
   narrowing once rotas define teams, Phase 2), or assigned people; people the user is assigned to
   count wherever they live. A role with person scope `none` searches no person records. Care
   record kinds need MFA; without it they are left out (and named as left out), and a user with
   nothing left gets "set up a second sign-in step".
5. **Time window.** Access ends at the earlier of the role assignment's end and, for agency and
   bank workers, the shift end plus `access.agency.post_shift_hours` (`agencyAccessEndsAt`). An
   agency worker with no shift recorded gets no window at all: search fails closed
   (`no_shift_recorded`). After the window no plan is made, and a plan made earlier shows nothing.
6. **People who have left.** Discharged, deceased, archived and not-admitted people (and their
   documents and notes) are left out unless the user holds `platform.search.archived` (owner,
   Registered Manager, deputy, quality lead) and asks for them, so a former resident is not chosen
   for a current one of the same name (HZ-001). Results show the status as icon and word.
   Duplicate on return: someone admitting a person who left earlier and searching without the
   archive will not find the closed record, so the admission screens run the probable-duplicate
   check (same NHS number, or same date of birth and a similar name) across every status before a
   new person is created, and offer to re-open the existing record ([people.md](people.md) rule 15,
   one person, one record).
7. **Results, order and counts.** Row-level security filters the query; the API then applies the
   plan again to every row (`filterSearchResults`). Order (`compareSearchHits`): people before
   colleagues, documents and notes; whole-word matches before prefix matches; then by status
   (receiving care, then being assessed, then former), name, date of birth, relevance and id.
   When two people in the results share a name (compared as the index compares names), each is
   flagged with a same-name warning (`sameNameWarnings`). Counts, totals and "more" come only from
   what the user may see: an out-of-scope match looks exactly like no match. A row the plan drops
   is never shown or counted; `droppedByPlan` above zero means the database and the plan disagree,
   and the API raises a security alarm with opaque counts only (HZ-011). Offline, the mobile app
   searches only what it has synced and labels results "This device only, last synced at HH:MM"
   (HZ-002).
8. **Audit.** Every search writes `platform.search.run` with the kinds searched and left out (with
   why), whether people who have left were included, the query kind, the number of terms, the
   result counts, the person scope kind, the location ids, when the user's access ends
   (`validUntil`), and the opaque ids shown on the page. People shown count as views of their care
   records (`careRecordView`, `personIds`). It never stores the words typed or the NHS number, not
   even hashed: searches are usually names, and a hash of a name can be reversed by trying names.
   Refused searches write `platform.search.refused` with the problem and no query. A break-glass
   search writes `platform.search.break_glass` with a reference to its break-glass record
   (`breakGlassRecordId`), which holds the typed reason; the reason is not copied into the audit
   trail.
9. **Break-glass search.** Finding a person outside scope is a separate path
   (`buildBreakGlassSearchPlan`): `platform.search.use` and `people.person.break_glass` with a
   step-up, MFA, a reason code (`BREAK_GLASS_REASON_CODES`) and a typed reason of 20 to 1,000
   characters, and fewer than `break_glass.search_max_per_day` such searches by that user in the last
   24 hours. The query must be specific (an NHS number, or at least two name words) and matches
   whole words of names only: no prefixes and no room labels. Results are people only, at most 10,
   tenant-wide, showing name, preferred name, date of birth, NHS number, photo and status; location
   and room are withheld until the record is opened through the existing break-glass step. The
   search itself alerts the Registered Manager for each location whose people were shown and the
   data protection lead (`breakGlassSearchAlert`, generic title); reaching the daily limit refuses
   further searches and tells the data protection lead. The weekly break-glass report lists these
   searches beside the openings (API step).

### Full export (PLAT-015)

10. **Contents.** One CSV (RFC 4180, UTF-8, header row) and one JSON Lines file per table under
    `tables/`, the documents under `documents/<id>.<extension>`, `destroyed.csv`,
    `current_summary.csv`, `schema.json` and `manifest.json`, as
    [data-standards.md](data-standards.md) "Export and import conventions" sets out
    (`EXPORT_SCHEMA_VERSION` 1.1.0). The catalogue `EXPORT_TABLES` (`export-catalogue.ts`) keys
    every table by `schema.table` and classifies every column as `exported`, `internal` or `secret`,
    with a description and, for every number, a unit; tables holding care records describe every
    column explicitly. Only the `public` schema is read, and only `exported` columns are written.
    `describeExportSchema` generates `schema.json` (JSON Schema 2020-12 with `description`,
    `x-unit` and `x-codes` per column) from the same plan, with the conventions every reader needs:
    - **corrections**: entries are never edited; a correction is a new row whose `supersedes_id`
      names the row it corrects. The original and its correction are not two live facts: the
      current value is the row no other row supersedes;
    - **instants**: UTC with `Z`; UK local time is the instant in Europe/London (+00:00 GMT,
      +01:00 BST), always converted from UTC because the autumn overlap repeats an hour; the
      manifest and current summary also show UK time with its offset and zone (`ukLocalTimestamp`);
    - **UK dates**: dates are UK calendar dates; where an instant stands for a date (a date of
      death, a discharge) the export adds `<column>_uk_date` (`ukDateOfInstant`), because the UTC
      date is a day early after 23:00 in summer;
    - **wall-clock times**: recurrence times and quiet hours are Europe/London wall-clock times;
    - **observation values**: a schema per chart with the unit of every number
      (`OBSERVATION_VALUES_SCHEMA`: ml, kg, breaths per minute, % oxygen saturation, mmHg, beats per
      minute, degrees Celsius, Bristol stool type), kept in step with the API's contract by a test;
    - **allergy status**: `person.allergy_status` codes with their meaning (`unknown` never means
      none);
    - **CSV formulas** (rule 11).
    `current_summary.csv` has one row per person: allergy status and active allergies most severe
    first, the CPR decision in force (or `conflicting` with every record in force), whether its
    review is overdue, IDDSI food and drink levels with name and colour, communication-needs status
    and needs, all worked out by the same domain functions as the point-of-care header and the
    transfer pack (`normaliseAllergies`, `resuscitationStatus`, `cprRecordsInForce`,
    `describeIddsiLevel`, `normaliseCommunication`), never re-derived (HZ-071).
11. **What goes in.** `exportRowDecision` and `exportDocumentDecision`, in this order:
    - destroyed past retention: not in its table file; listed in `destroyed.csv` with the
      destruction certificate id;
    - sample data: left out and counted (it is not the organisation's data);
    - under a legal hold: always in, even if soft-deleted, because the hold preserves it;
    - soft-deleted (deleted and awaiting destruction): left out and counted, as
      [retention-and-deletion.md](../compliance/retention-and-deletion.md) says;
    - everything else: in.

    Quarantined documents (failed or missed the malware scan) keep their row in `document.csv` but
    their bytes are not handed out (ADR-0031). Never exported: any schema other than `public`
    (passwords, sessions, passkeys and authenticator secrets live in `auth`), `operator_user`,
    `bank_holiday`, global rows of `rate_table`, `retention_class` and `form_template`, and columns
    classified internal or secret (`document.storage_key`, `tenant_user.auth_user_id`,
    `integration_connection.secret_ref`). In CSV files only, a text cell starting with `=`, `+`,
    `-`, `@`, a tab, a carriage return or an apostrophe gets a leading apostrophe so spreadsheets do
    not run it as a formula (`csvCell`, undone by `csvTextValue`); numbers stay numbers and JSON
    Lines hold the exact values.
12. **Download.** A ready export can be downloaded by the person who asked for it only, while they
    hold `platform.export.create` (a care-record permission, so MFA is required) and have stepped up,
    until `export.link_expiry_hours` after it was ready, never beyond the ceiling
    `export.link_expiry_hours_max` (`checkExportDownload`, `exportExpiresAt`). The link in the
    notification is a pointer to that check, not a bearer link: the API then streams the file or
    mints a storage URL lasting `EXPORT_DOWNLOAD_URL_SECONDS` (5 minutes). Files are stored in the
    eu-west-2 export bucket with SSE-KMS under the organisation's own prefix
    (`exportStoragePrefix`: `tenants/<tenant>/exports/<export>/`), and are deleted at expiry, not
    just hidden. Another owner asks for their own export (HZ-070).
13. **Request and worker.** Needs `platform.export.create` (owner) with step-up
    (`checkExportRequest`). The export worker runs as `harbour_app` inside `withRequestContext` for
    the exporting tenant, so forced row-level security applies to every read, and reads every file
    in one `REPEATABLE READ` read-only transaction: one snapshot, recorded as `snapshotAt` in the
    manifest, so no table is from a different moment than another. The download page offers
    "changes since this export", a changes-since export (`planExport({ since })`,
    `exportRowChangedSince`) holding rows created, changed, recorded, deleted or destroyed at or
    after the earlier snapshot. Requested, ready, failed, downloaded, expired and revoked are
    audited.
14. **Completeness and isolation.** `buildExportManifest` checks what was written against the plan:
    every planned table has both files with the counted rows; no row's `tenant_id` differs from the
    exporting organisation's (`otherTenantRows`); no unplanned or unclassified table or column was
    met; a full export's current summary has one row per exported person; every document's bytes
    match the SHA-256 recorded at upload. Any problem marks the export incomplete: it is failed,
    raises a security alarm for a foreign row, and is never offered as if whole (HZ-070, HZ-071).
    Warnings (a broken audit chain, a destroyed record without a certificate) are listed in the
    manifest and on the download page and do not block it.
15. **Free.** No charge, whatever the plan, payments or contract state: onboarding, active,
    suspended and closed organisations can export until their data is deleted after the contract
    ends (DPA clause 9). The only limit is abuse protection: one export at a time per organisation
    (a partial unique index in the schema step); asking again returns the one being prepared.
16. **Catalogue completeness.** `packages/db/src/export-catalogue.test.ts` runs
    `checkExportCatalogue` against the Drizzle schema: every public table and every column must be
    classified, nothing classified may have disappeared, and every exported number has a unit. A new
    table or column therefore fails the build until it is classified, and at run time an
    unclassified one is never written and makes the export incomplete.

### DPIA and registers (PLAT-023)

17. **Prefill.** `prefillDpia` fills [the DPIA template](../compliance/dpia-template.md) sections 1
    to 7 from the configuration: identification, screening (monitoring with home care, AI,
    children's homes), nature (locations, service types, modules, device modes, offline window,
    sub-processors, retention schedule version and overrides), scope (counts, data categories),
    purposes and lawful bases, necessity, and the template's risks R1 to R8, with R9 for home care
    monitoring. Optional processing adds its own section and risk: AI (AI addendum, R10), family
    portal photos (B8, section 10, R11) and marketing (B9, section 11, R12). The prefill takes
    planned modules as well as enabled ones, so the AI addendum can be signed before the module is
    switched on. Context, consultation, local risks and the tenant's own measures are the tenant's to
    complete.
18. **Missing configuration.** Legal name, CQC provider ID (for CQC-regulated providers), DPO, DPA
    signature date, privacy notice link, at least one location and, with AI, a provider. Each
    missing item is listed and blocks sign-off.
19. **Records of processing.** `recordsOfProcessingRegister` prefills Part B from
    `PROCESSING_PURPOSES` (B1 to B10, kept in step with
    [records-of-processing.md](../compliance/records-of-processing.md) by a test): B1 to B7 always,
    with the lawful basis for the tenant's sector; B8 with the family portal; B9 when marketing is
    switched on; B10 when the AI module is on and the tenant has switched on AI for free text.
    Consent is never the basis for B1 to B7 (tested). `tenantDataCategories` adds the categories
    each module brings.
20. **Sign-off checks** (`checkDpiaSignOff`, every problem returned at once): the version is
    prepared; no configuration is missing; every tenant field is completed; every risk has a
    residual rating; a risk still high after its measures has an ICO prior consultation reference
    (Article 36); the signer has stepped up; the typed-name signature is bound to the SHA-256 of the
    version read (`checkSignature`).
21. **Who signs.** A holder of `platform.dpia.sign` (owner, quality lead; a step-up permission) who
    is named as the organisation's data protection officer or lead in its governance settings, and
    who did not prepare any part of that version (separation of duties, `dpia_sign_off`). An
    organisation whose only possible signer prepared the DPIA asks another person (for example the
    Registered Manager, who holds `platform.dpia.prepare`) to prepare it.
22. **Re-review.** A signed DPIA records its basis (purposes, sub-processors, data categories,
    modules). It falls due for review when a purpose, sub-processor, data category or module
    appears that it did not cover, and `dpia.review_interval_months` after sign-off (UK calendar
    months; 29 February falls back to 28 February). Removing processing never triggers a review.
    The AI module can be switched on only when a signed DPIA already covers it (master prompt 16);
    any other module may be switched on and flags the review (`checkFeatureEnable`).
23. **Sub-processor register.** `SUB_PROCESSORS` mirrors
    [sub-processors.md](../compliance/sub-processors.md) (a test keeps the names in step), and
    `subProcessorsInUse` shows each organisation only those its configuration uses.
24. **Notices.** Thapsus notifies affected organisations before a new or replacement sub-processor
    processes their data. The notice period is also the window for objecting on reasonable data
    protection grounds (DPA clause 6.2). It is contractual, so it is a tenant setting
    (`sub_processor.notice_days`, default 30 from the DPA template, to verify), never statute; a
    change may not take effect before the longest period among the organisations it affects
    (`checkNoticeTiming`). Acknowledging or objecting follows the sign-off rule: `platform.dpia.sign`
    with step-up, by the designated data protection officer or lead (`checkNoticeResponse`); an
    objection must come within the window and give its grounds (20 characters or more).
25. **Objections.** Once the window closes without an objection the change is deemed accepted. While
    an objection is open the new sub-processor does not process that organisation's data; after
    resolution it may only if the objection was withdrawn, not if Thapsus agreed not to use it for
    them or they ended the affected services (`mayProcessTenantData`).

### Help and onboarding (PLAT-018)

26. **Checklist** (`onboardingChecklist`). Each item is worked out from state; the CSO confirms
    which items block go-live (H-122):

    | Item | Done when | Blocks go-live |
    | --- | --- | --- |
    | Locations identified | Every active location has a valid CQC location ID (`1-` and digits) or, under another regulator, its regulator ID, and an ODS code (3 to 10 upper-case letters and digits) | Yes |
    | Registered managers | Every active location has a Registered Manager assigned | Yes |
    | First users with MFA | Someone other than the owner has joined, and every active user who reads care records has TOTP or a passkey | Yes |
    | Shared devices enrolled | Every active shared or kiosk device is enrolled in device management ([kiosk.md](../compliance/kiosk.md)) | Yes |
    | Escalation chains set | Working chains exist for deterioration (HZ-014), overdue tasks (HZ-008), statutory notifications (HZ-013) and post-fall observations (HZ-027) (`REQUIRED_ESCALATION_CHAINS`, each passing `validateChain`) | Yes |
    | Escalation policies linked | Every validated tool switched on links the tenant's escalation policy (HZ-014) | Yes |
    | Clinical settings reviewed | The clinical lead has decided every clinical tenant default (`CLINICAL_SETTING_PREFIXES`: device auto-lock, post-fall observations, handover shifts, repositioning, bowel and weight prompts, DoLS reminders) since Harbour last changed it (HZ-027, HZ-018) | Yes |
    | People ready | Every current person (not sample) has a photo (HZ-001), an allergy status other than unknown (HZ-007), a resuscitation status, either a decision in force or a recorded "no decision in place" (HZ-015), a communication-needs status (HZ-023) and IDDSI food and drink levels (HZ-016) (`personReadinessGaps`); the screen lists each person and what they lack | Yes |
    | Other settings reviewed | Every other tenant-default setting has a decision since Harbour last changed it | No |
    | Retention reviewed | The staff file option is chosen; every other class is accepted or lengthened, or, for classes set by tenant policy, has a period set or is marked not used; each decision made since the class last changed | Yes |
    | DCB0160 recorded | The tenant's CSO or clinical lead has recorded the DCB0160 assessment for the safety case of the release the tenant runs ([clinical risk management plan](../clinical-safety/clinical-risk-management-plan.md) section 7) | Yes |
    | DPIA signed | The DPIA is signed and not due for review | Yes |
    | Sub-processors acknowledged | Every sub-processor in use is acknowledged since its entry last changed | No |
    | National data opt-out | The organisation has said whether it uses care data beyond direct care; if it does, every current person's opt-out status has been checked | No |
    | Sample data removed | No sample data remains | Yes |

27. **State, not ticks.** No item can be ticked by hand where state can tell. Where a person must
    decide (a setting, a retention class, a sub-processor, the DCB0160 assessment), the decision is
    a record with who and when, and a later change by Harbour reopens it. Each item gives its reason
    in plain English from the same state and links an in-app guide by its key (`guide`).
28. **Help.** In-app guides are keyed by the checklist items and screens; the status page link in
    the help menu comes from configuration once the hosted page exists (H-12, H-116).

### Sample data mode (PLAT-018)

29. **Flagged and plainly invented.** Every sample row carries a sample flag and a batch id. Sample
    people have the family name "Example", a 999-range NHS number that passes its check digit,
    `example.invalid` email addresses, telephone numbers in Ofcom's drama ranges
    (`OFCOM_DRAMA_NUMBER_BLOCKS`, to verify, H-123) and an invented address (an "Example" street,
    and no postcode or the ZZ99 pseudo-postcode area) (`checkSamplePerson`). A sample person carries
    a "Sample" badge on every screen (`samplePersonBadge`) and any print showing sample data carries
    the watermark "SAMPLE DATA: NOT A REAL PERSON" (`samplePrintWatermark`).
30. **Never mixed with real people.** Sample data loads only for the owner
    (`platform.onboarding.manage`) and only before any real person exists. Real records wait until
    the sample data has gone, by every creation path (`REAL_RECORD_CREATION_PATHS`: manual entry,
    enquiry, import, integration, TUPE transfer; `checkRealRecordCreation`). A record about sample
    people is sample; a record linking sample and real records is refused (`sampleFlagForNewRecord`).
    Staff accounts are real and may practise on sample people.
31. **Kept out.** `SAMPLE_DATA_TREATMENT` and `forSurface`: sample records are excluded from
    statutory notifications and clocks, regulatory returns, the full export, reports and dashboards,
    billing and seats, outbound messages, integrations, in-app alerts, escalation chains, handover,
    the downtime pack and bulk prints; a single record's print is watermarked; screens show the
    badge. The central outbound guard in the integrations adapter wrapper calls
    `checkOutboundForSample` before any email, SMS, push, webhook or partner message.
32. **Removed in one step.** Removal deletes the whole batch or nothing: every row must be sample,
    none under a legal hold, none referred to by a real record (`checkSampleDataRemoval`). The
    deletion is done by a narrow security-definer function, `app.remove_sample_batch(batch uuid)`,
    owned by a dedicated no-login role, which deletes only rows
    `WHERE tenant_id = app.current_tenant_id() AND is_sample AND sample_batch_id = $1`, in the same
    transaction as the check; `harbour_app` is never granted DELETE. Audit events about sample
    records stay (opaque ids only) and the removal is audited.

## 3. Permissions

From `packages/domain/src/platform/permissions.ts` (matrix, generated:
[permissions.md](permissions.md)).

| Permission | Allows | Held by (built-in roles) |
| --- | --- | --- |
| `platform.search.use` (new) | Search what the user can already see | Owner, group executive, Registered Manager, deputy, clinical lead, team leader, care worker, agency worker, care coordinator, administrator, HR, quality lead |
| `platform.search.archived` (new) | Include people who have left, and their records | Owner, Registered Manager, deputy, quality lead |
| `people.person.break_glass` (existing) | Break-glass search, with step-up and a reason | Owner, Registered Manager, deputy |
| `platform.export.create` (renamed from `platform.data.export`; step-up; care record, so MFA) | Ask for and download the full export | Owner |
| `platform.onboarding.read` (new) | See the onboarding checklist | Owner, Registered Manager, deputy, quality lead |
| `platform.onboarding.manage` (new) | Load and remove sample data; record onboarding decisions | Owner |
| `platform.dpia.read` (new) | Read the DPIA, records of processing and sub-processor register | Owner, group executive, Registered Manager, deputy, quality lead |
| `platform.dpia.prepare` (new) | Prepare the DPIA and keep the registers current | Owner, Registered Manager, quality lead |
| `platform.dpia.sign` (now step-up; now also the quality lead) | Sign the DPIA as the named lead; answer sub-processor notices | Owner, quality lead |

Existing tenants' role copies gain the new permissions, and have `platform.data.export` renamed,
through a data migration in the schema step that also rewrites `access_grant.permissions` (roles
are versioned per tenant; the migration adds a new version). No API route used
`platform.data.export`.

## 4. Audit events

| Event | When | Holds |
| --- | --- | --- |
| `platform.search.run` | A search ran | Kinds searched and left out, archive flag, query kind, term count, result counts, person scope kind, location ids, `validUntil`, the opaque ids shown and the people shown (care-record views); never the query |
| `platform.search.break_glass` | A break-glass search ran | As above, plus the reason code and a reference to the break-glass record that holds the typed reason |
| `platform.search.refused` | A search was refused | The problem and kinds asked for; never the query |
| `platform.export.requested`, `.ready`, `.failed`, `.downloaded`, `.expired`, `.revoked` | Export lifecycle | Export id, requester, kind and snapshot, row and document counts, bytes, manifest SHA-256, problems and warnings; never row contents |
| `platform.dpia.prepared`, `.signed`, `.review_due` | DPIA lifecycle | Version, SHA-256, signer, basis, triggers |
| `platform.sub_processor.acknowledged`, `.objected`, `.objection_resolved` | Notice responses | Notice id, who, when, resolution (the grounds are in the record, not the event) |
| `platform.onboarding.sample_loaded`, `.sample_removed`, `platform.setting.decided`, `platform.retention.decided`, `platform.dcb0160.recorded` | Onboarding | Batch id and row counts; setting key or record class and decision kind; safety case version |

## 5. Retention classes

| Record | Class |
| --- | --- |
| Search audit events that showed people | `audit_event.care_record`: they record views of care records, kept as long as those records |
| Other search audit events (staff, organisation documents, no results, refusals) | `audit_event` for now; whether they may use the 6-month `security_log` class is for the DPO (H-121) |
| Break-glass search records | `audit_event`, as other break-glass records |
| Export records (who asked, when, status, snapshot, manifest SHA-256, counts) | `audit_event` |
| Export files | Deleted at expiry; never kept as records |
| DPIA versions, sign-offs, sub-processor responses, setting, retention and DCB0160 decisions | `audit_event` as an interim class (accountability evidence, 8 years from creation); the DPO confirms or sets a period (H-115) |
| Sample data | Removed on demand; never retained |
| Onboarding checklist | Not stored: worked out from state |

## 6. Schema for the schema step (expand only)

| Table or column | Kind | Key columns |
| --- | --- | --- |
| Search index | Generated `tsvector` columns, `btree_gin` composite indexes with `tenant_id` first ([ADR-0070](../decisions/0070-search-on-postgres-full-text.md)) | `person` (one vector for the names and preferred name, a second for the room label), `tenant_user` (display name), `document` (title, file name), `care_note` (text); `app.search_terms(text)` immutable `SECURITY INVOKER` function matching rule 2; every query states `tenant_id = $1` first; nothing is marked `LEAKPROOF` |
| `break_glass_event` | Add column | `kind` (`open` or `search`), so break-glass searches have a record holding the typed reason that audit events refer to |
| `tenant_export` | Mutable, versioned | Status (`EXPORT_STATUSES`), kind, since, requested by, requested at, snapshot at, ready at, expires at, revoked at, schema version, storage prefix, bytes, manifest SHA-256, problems and warnings (JSON); partial unique index on `tenant_id` where status is `queued` or `running` |
| `dpia` | Mutable, versioned | Version, status (`draft`, `prepared`, `signed`, `superseded`), prefill (JSON), answers by section (JSON), residual ratings, ICO reference, prepared by (array), version SHA-256, signed by, signed at, typed name, statement, basis (JSON) |
| `sub_processor_notice` | Global (Thapsus) | Sub-processor key, kind, use, announced at, effective from |
| `sub_processor_response` | Append-only | Notice, acknowledged at and by, objection at, by and grounds, resolution and when |
| `tenant_setting_decision`, `retention_decision`, `dcb0160_record` | Append-only | Rate key, record class or safety case version; decision kind; decided by and at |
| `tenant` | Add columns | Designated data protection lead (tenant user), sector, privacy notice link, `uses_data_beyond_direct_care`, marketing and AI-on-free-text switches, AI provider |
| `person` | Add columns | `national_data_opt_out_checked_at`; `communication_needs_status` (people.md) |
| `device` | Add column | `mdm_enrolled` for shared and kiosk devices |
| Sample flag | Add columns | `is_sample` and `sample_batch_id` on person-related tables; `app.remove_sample_batch` security-definer function owned by a no-login role (rule 32) |
| `rate_table` | Add column | `tenant_default` (boolean), replacing `tenantDefaultRateKeys`' reading of the source text |
| Role data migration | Data | Rename `platform.data.export` to `platform.export.create` and add the new permissions in role copies and in `access_grant.permissions` |

Database tests to add with it: RLS and HZ-011 isolation for every new table; `app.search_terms`
gives the terms in `search.test.ts`; a search as each scope returns nothing from another tenant or
outside scope; `EXPLAIN` as `harbour_app` inside `withRequestContext` shows each search uses its
composite index with `tenant_id` as the index condition; no search function or operator Harbour
defines is `LEAKPROOF` or `SECURITY DEFINER`; the export worker
running as `harbour_app` inside `withRequestContext` reads no other tenant's row
(`hazard HZ-070 the export reads only the exporting tenant`); `checkExportCatalogue` against the
migrated database; the partial unique index refuses a second running export; sample removal
deletes every sample row of the batch and leaves every real row
(`hazard HZ-072 sample removal leaves real rows`); append-only grants on the response and
decision tables.

## 7. Data standards

[data-standards.md](data-standards.md) holds the export layout (`tables/`, `current_summary.csv`,
`destroyed.csv`, `schema.json`, `manifest.json`), the manifest fields including `snapshotAt` and
`since`, the CSV formula convention, the derived `<column>_uk_date` columns, the meaning of
`person.allergy_status` codes, and the code lists for exports, DPIA ratings and triggers,
retention decisions, objections, the sample flag and search audit. `EXPORT_SCHEMA_VERSION` (1.1.0)
is bumped on any change to the export shape.

## 8. Clinical safety and data protection

Hazards: HZ-001 (wrong person chosen from search results: identity fields, photo and age for
names-and-rooms roles, people first and exact matches first, same-name warning, closed records
hidden by default, exact NHS number match), HZ-011 (search scope, counts, audit of what was shown,
break-glass search; agency window), HZ-014, HZ-015 and HZ-027 (go-live readiness), HZ-070 (full
export disclosed beyond the organisation), HZ-071 (full export incomplete or misread when a
provider changes system, re-rated) and HZ-072 (sample data mistaken for or mixed with real
records). See the [hazard log](../clinical-safety/hazard-log.md). Nothing here scores, predicts or
recommends care ([medical-device-boundary.md](../compliance/medical-device-boundary.md)).

Data protection: search audit, break-glass search records, export records, DPIA records, notice
responses and onboarding decisions are new processing under B5 (accountability) in the
[records of processing](../compliance/records-of-processing.md). The export goes to the controller
itself, so it is not a disclosure to a third party, but it holds every category and is delivered
only as rule 12 says.

## 9. Acceptance criteria and tests

- Domain (built): `search.test.ts` (normalisation, NHS numbers, plans by role, scope, MFA, the
  agency window, break-glass search, filtering, ranking and same-name warnings, audit);
  `export.test.ts` (catalogue, column types, plan, row and document rules, CSV guard, UK dates and
  times, observation schemas, current summary, schema description, manifest completeness and
  isolation, request and download); `processing-register.test.ts`, `sub-processors.test.ts` and
  `dpia.test.ts`; `onboarding.test.ts` (every item from state, clinical go-live items, person
  readiness, sample data behaviour). Role grants in `access.test.ts`.
- Database (built): `packages/db/src/export-catalogue.test.ts` checks the catalogue against the
  Drizzle schema. Schema step: the tests listed in section 6.
- API: search routes with the plan, the second filter, ranking and the audit event; break-glass
  search alert and limit; export request, worker, manifest and download (`hazard HZ-070`,
  `hazard HZ-071`); DPIA prepare and sign-off; notice responses; onboarding checklist and sample
  data load and removal (`hazard HZ-072`); every route audited.
- Web and mobile: search with the people-who-have-left toggle, same-name warnings and the
  break-glass dialog; offline search label; export page with "changes since"; DPIA and registers
  under Settings, Data protection; onboarding checklist with icon and word for each status and the
  people-readiness list; sample badge on every screen and the print watermark; axe on each page.

## 10. As built (slice 13, domain rules and review fixes)

Domain modules, all pure and exported from `@harbour/domain`: `search.ts`, `export.ts`,
`export-catalogue.ts`, `processing-register.ts`, `sub-processors.ts`, `dpia.ts`, `onboarding.ts`,
`sample-data.ts`; `resolvePlatformRates` in `rates.ts`; the `dpia_sign_off` duty rule; the new
permissions and role grants; `cprRecordsInForce` (care) and the exported transfer-pack statement
normalisers (people) that the current summary reuses. 2,486 tests in the domain package (650 more
than before the slice), 99.7% line coverage; 3 catalogue tests in `packages/db`. Five rate-table
rows added, all to verify. No schema, migration, API, web or mobile change in this slice.

## 10a. As built (slice 13 part 1, the export's record and routes)

- `tenant_export` (migration 0062, numbered after #71's 0060 and the family feed's 0061; merge
  after both): forced RLS with the tenant policy; only holders of `platform.export.create` across
  the organisation, and the export worker (no member, the organisation's view), see or change a
  row; a request is queued in the requester's own name; the partial unique index allows one queued
  or running export per organisation; a guard keeps who asked and what, moves the status forward
  only (`queued` to `running`, `failed` or `revoked`; `running` to `ready`, `failed` or `revoked`;
  `ready` to `expired` or `revoked`; the rest final), revokes in the reviser's own name and never
  soft-deletes; the single download is set once, by the requester, while ready and unexpired. The
  data migration renames `platform.data.export` to `platform.export.create` in role copies and
  grants, audited per tenant. The other new slice 13 permissions are left to their own steps.
- Routes (`apps/api/src/routes/exports.ts`): `POST /v1/exports` (step-up; 202 queued, or 200 with
  the export already in hand; `sinceExportId` for the changes since an earlier snapshot),
  `GET /v1/exports` (step-up, as every export route), `POST /v1/exports/{id}/revoke` (step-up;
  deletes the archive) and `GET /v1/exports/{id}/download` (step-up; `checkExportDownload`; the
  download recorded before the bytes leave, then the archive deleted by the worker; a second fetch is 410
  `export_already_downloaded`). The API streams the archive itself rather than minting a storage
  URL, so the one-time fetch holds. Requested, revoked and downloaded are audited, refusals too.
- Storage: the exports bucket (`S3_EXPORTS_BUCKET`; eu-west-2, SSE-KMS, lifecycle expiry) at
  `tenants/<tenant>/exports/<export>/export.zip`, through the storage port, which now writes and
  reads streams (multipart upload, at most one 8 MiB part in memory). The download opens the
  archive before claiming the single fetch (a failed read leaves it untaken), streams it, and the
  worker deletes it from the outbox event (`platform.export.downloaded`, `.revoked`), retried
  until it is gone. #77 review: a ready export's archive, manifest, snapshot and expiry are frozen;
  the rename is limited to organisation-wide roles and grants, the old name dropped elsewhere,
  every change audited.
- Next (part 2): the worker job that builds the archive (one `REPEATABLE READ` snapshot as
  `harbour_app`, the table files, documents, current summary, `schema.json` and the manifest,
  `ready` or `failed`, audited), the expiry sweep that deletes the archive, and the notification.

## 10b. As built (slice 13 part 2, the export worker)

- `runQueuedExports` (`apps/api/src/jobs/exports.ts`, queue `full-exports`, every minute): for
  every organisation, whatever its status (rule 15), claims the oldest queued export as the job
  (no member, the organisation's view) and builds it (`services/export-build.ts`): as
  `harbour_app` with the organisation's context, in one `REPEATABLE READ` read-only transaction
  (`snapshotAt` is its start); the tables and columns from the database's own catalogue, planned
  with `planExport`; each table read through a cursor twice in the same snapshot (CSV, then JSON
  Lines), rows decided by `exportRowDecision` (soft-deleted out unless held; legal holds on the
  row, the record or its person) and, for a changes-since export, `exportRowChangedSince`; the
  documents' bytes streamed from the documents bucket when `exportDocumentDecision` includes them;
  `destroyed.csv` from the destruction certificates; `current_summary.csv` from the transfer pack's
  statements and `currentSummaryRow`; `schema.json`; the audit chain checked; `manifest.json` from
  `buildExportManifest`. Every file goes straight into a streamed ZIP (`services/zip-writer.ts`:
  deflate, data descriptors, ZIP64 end records; a single file of 4 GiB or more fails the export)
  that the exports bucket receives as a multipart upload. Complete: `ready` with the expiry from
  `export.link_expiry_hours` (capped by the maximum), audited `platform.export.ready` with counts,
  and the requester told in the app and by email, ids only ("Your data export is ready", a link to
  the export page). Incomplete or an error: `failed` with its problems, audited (only when it was still queued or
  running), the requester told by ids only, the archive deleted, `worker.job.failed` logged; another
  organisation's row raises `security.export.foreign_rows` (CloudWatch alarm
  `<prefix>-export-foreign-rows`). Cancelled while it was built: the archive is deleted and no one
  is told it is ready. #78 review: the ZIP writer reads its source and drains the deflater together
  and stops both on a failure; a write waits on the archive's reader only until it drains, closes
  or fails, and a failed upload stops the archive; the snapshot transaction is rolled back and its
  connection released (or discarded) on every failure, with `idle_in_transaction_session_timeout`
  and `statement_timeout` as backstops; the request context is set with `applyRequestContext`,
  holds read with `isUnderLegalHold`, and a destroyed document's tombstone is listed in
  `destroyed.csv` with its certificate rather than exported.
- `sweepExports` (queue `export-expiry`, every 15 minutes): deletes each archive past its expiry,
  then marks the export expired and records `platform.export.expired` (archive deleted), so a
  failed delete is tried again; an export running more than `EXPORT_RUNNING_LIMIT_HOURS` (12, a
  technical limit) is failed and its archive deleted.
- Not yet: sample data (no flag until the sample data step); the web export page (part 3). The
  current summary loads the organisation's people, allergies, advance care records and care
  profiles at once (bounded by the number of people); the tables never are.

## 10c. As built (slice 13 part 3, the export page)

- `/settings/export` (`apps/web/src/app/(shell)/settings/export`, `lib/exports.ts`), in the
  navigation as "Data export" for holders of `platform.export.create` only; anyone else is told in
  words. Every export route needs a step-up with a second factor, so the page sends the person to
  confirm it is you before it lists anything; an action whose step-up lapsed shows the step-up
  notice in words naming the passkey and the authenticator code, with the way back.
- Ask for an export (offered while none is being made); each export's state as an icon and a word
  (waiting to start, being prepared, ready to download, downloaded, expired, failed, cancelled;
  an unknown state warns), when its link expires, its size and the manifest's warnings.
- Download (the requester's own, ready and not yet fetched) opens a sheet first: the file can be
  downloaded only once and holds the records of everyone the organisation supports and employs, so
  it is saved straight away somewhere only authorised people can open. The file streams through a
  same-origin route handler (`/settings/export/{id}/download`), never cached; a refusal returns to
  the page with what happened in words that take focus, or to signing in again.
- Cancel after a confirmation. Arrivals carry `at`, so the same outcome twice is said twice.
- `pnpm --filter @harbour/api exports:run` runs the worker's job once for local journeys; the demo
  owner gets the end-to-end passkey alongside the manager (`HARBOUR_DEMO_E2E_PASSKEY=1`).

## 10d. As built (slice 13, the DPIA in-app)

- Migration 0063: the `dpia` table, one row per version (forced RLS; read with any DPIA
  permission; written by holders of `platform.dpia.prepare`; one version open and one signed at a
  time) and the organisation's data protection governance on `tenant` (the named lead, a member of
  the organisation; sector; privacy notice; DPA date; use beyond direct care; optional processing;
  AI provider). The guard keeps a version's identity and preparers (who only ever grow: whoever
  changes or prepares it joins them), returns a changed prepared version to draft, lets only the
  named lead holding `platform.dpia.sign` sign a prepared version unchanged in their own name
  (never a preparer, also a check constraint, with the signature, statement and basis present),
  and lets a signed version change only to be superseded, by the named lead with a later version
  prepared, and only if that later version is signed in the same transaction (a deferred check).
  Nothing is deleted. On `tenant`, `tenant_governance_guard` lets only a holder of
  `platform.tenant.manage` change the governance columns, and only a member whose role holds
  `platform.dpia.sign` be named lead (`app.member_holds_role_permission`).
- Routes (`apps/api/src/routes/dpia.ts`): `GET /v1/dpia` (state, review triggers, settings,
  missing configuration, the open and signed versions); `PUT /v1/dpia/draft` (saves answers,
  residual ratings and ICO reference with Harbour's prefill refreshed, `expectedVersion`);
  `POST /v1/dpia/draft/prepare` (freezes it with its SHA-256); `POST /v1/dpia/{id}/sign`
  (step-up; `checkDpiaSignOff`, every problem at once as 422 `dpia_not_signable`; the row locked,
  and the version in force superseded only when this one is signed); `PUT
  /v1/settings/data-protection` (`platform.tenant.manage`, `expectedVersion`; naming a different
  lead needs step-up and a member who may sign, audits the old and new lead ids and tells the lead
  replaced, with ids only). The prefill
  reads the configuration (`services/dpia.ts`): locations and regulators, service types, modules
  in force (an AI provider chosen counts the AI module as planned), SMS when connected, device
  modes, the offline window and retention schedule, and counts. Saved, prepared, signed (and
  refused) and governance changes are audited with ids and changed field names only.
- Next: the onboarding checklist (rule 26), which reads the DPIA state, with the decision
  records it needs (settings, retention, DCB0160); sub-processor notices (rules 24 and 25); the
  web screens.

## 10e. As built (slice 13, the onboarding checklist)

- Migration 0064 (after 0063): `tenant_setting_decision`, `retention_decision` and
  `dcb0160_record`, append-only (forced RLS; read with `platform.onboarding.read` or `.manage`;
  written only by a holder of `platform.onboarding.manage` in their own name; no UPDATE, DELETE or
  TRUNCATE), and `tenant.staff_file_option`, which only that holder changes
  (`tenant_staff_file_guard`).
- Domain: `checkSettingDecision` (setting its own figure needs a rate table row of its own),
  `checkRetentionDecision` (rule 26's kinds per class; lengthening or setting needs the
  organisation's own period, a lengthened one longer than the default; the staff file option on
  its own) and `checkDcb0160Recording` (the current safety case only), table-driven.
- Decision routes (`apps/api/src/routes/onboarding.ts`, `platform.onboarding.manage`): `POST
  /v1/onboarding/setting-decisions`, `POST /v1/onboarding/retention-decisions`, `PUT
  /v1/onboarding/staff-file-option` (the organisation record's `expectedVersion`) and `POST
  /v1/onboarding/dcb0160`, each audited (`platform.setting.decided`, `platform.retention.decided`,
  `platform.dcb0160.recorded`), refusals as 422 `decision_not_recordable` and audited too.
  `SAFETY_CASE_VERSION` in the API's configuration names the safety case for the release.
- Default taken (section 20 rule 2): decisions, including the clinical settings and the DCB0160
  record, are made by holders of `platform.onboarding.manage` (the owner), as section 3 says;
  whether the clinical ones need the clinical lead's own permission is for the CSO (H-122).
- `GET /v1/onboarding` (`platform.onboarding.read` or `.manage`): the checklist from
  `onboardingChecklist`, the safety case the DCB0160 assessment must cover, the staff file option
  and the organisation record's version. The state (`services/onboarding.ts`) reads the records:
  locations and their Registered Managers, members' roles and second factors, the rate table's
  tenant defaults and the retention schedule against the decisions, the DPIA state (shared with
  the DPIA routes: `dpiaStateFor`, `tenantFlags`), sub-processors in use, escalation chains,
  validated tools (switched on at any location counts, HZ-014) against the policy links, each
  current person's readiness, and the latest DCB0160 record. Not yet stored, so read plainly
  rather than guessed done: sub-processor acknowledgements (rules 24 and 25; never done until
  then, not a go-live item), device modes and the sample flag (rules 29 to 32; both unknown, so
  `shared_devices_enrolled` and `sample_data_removed` stay open and block go-live, "Harbour does
  not record this yet"; #86 security review H1), the opt-out check date (every current person counts as not
  checked) and a recorded "no decision in place" resuscitation statement (only an active ReSPECT
  or DNACPR record counts, so such a person stays outstanding). Members count by their own
  status, so an invited member has not joined. For each retention class the latest decision
  stands. `SAFETY_CASE_VERSION` must be set in production (Terraform passes it; CI takes the
  newest report in `docs/clinical-safety/safety-case/`), and a test checks the default names a
  report there.

## 10h. As built (slice 13, sub-processor notices, organisation side)

- Migration 0065: `sub_processor_notice` (global, Thapsus's; everyone reads, only the operator
  role announces; never changes) and `sub_processor_response` (append-only, forced RLS; read
  with a DPIA or onboarding permission; written by the application only as the named data
  protection lead holding `platform.dpia.sign` through a role, in their own name, acknowledging
  or objecting; the operator role records a resolution).
- Domain: `noticeResponseFrom` (the latest acknowledgement, the latest objection and the first
  resolution after it) and `subProcessorAcknowledgementsFrom` (the checklist's acknowledgements),
  table-driven.
- Routes (`apps/api/src/routes/sub-processors.ts`): `GET /v1/sub-processors` (the sub-processors
  in use, each acknowledged or not since its latest notice, and every notice with its state and
  when the organisation's window ends); `POST /v1/sub-processors/{key}/acknowledge` (the register
  entry, or a notice with `noticeId`); `POST /v1/sub-processor-notices/{id}/object` (grounds of 20
  characters or more, within the window). Both answers need `platform.dpia.sign` with step-up by
  the named lead (`checkNoticeResponse`), refusals as 422 `notice_response_refused`, audited with
  ids and keys only, never the grounds. The onboarding checklist's `sub_processors_acknowledged`
  now reads the responses and notices. Review of #92: responses are read through roles only
  (`app.holds_role_permission_somewhere`), and the grounds are returned only to DPIA permission
  holders; the register entry is not acknowledged while a notice about it has an open objection;
  each notice's window uses the organisation's notice period in force on the UK date it was
  announced.
- Next: the operator side (announcing a notice with `checkNoticeTiming` across the affected
  organisations, telling their leads, and recording a resolution), then the web screens.

## 11. Open questions

- Retention of DPIA records, export records and onboarding decisions beyond the interim
  `audit_event` class (H-115), and whether search events that showed no person may use the
  `security_log` class (H-121).
- Whether a one-person organisation whose owner is the only possible signer needs an exception to
  rule 21 (H-115).
- The staff file option is not reopened when Harbour changes the staff file rows of the schedule:
  the tenant row does not keep when the option was chosen. Record the choice as a
  `retention_decision` (or keep its time) when the retention screens are built.
- Which onboarding items block go-live, and the person-readiness items (H-122).
- Whether the export controls bring HZ-071 to the target residual rating; until the Clinical Safety
  Officer accepts it, the residual stays 4 and blocks release (H-119).
- The DSCR data migration standard's schema, to confirm the export meets it (H-120).
- Ofcom's drama number ranges (H-123).
- Searching note text after envelope encryption of free text is decided (ADR-0070, revisit).
