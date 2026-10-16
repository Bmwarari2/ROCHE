# Quality and governance (`quality`) - specification

Master prompt section 11.2, with section 4 (the inspector role and separation of duties) and
section 5.1 (data protection). Phase 1 builds two features: the inspector evidence pack export and
the statement of purpose with change tracking. The compliance framework model, the evidence library
in full, audits, the quality dashboard, PIR prefill, policies and the other registration records
arrive in Phase 2 and 3. Status per feature: [feature register](feature-register.md).

## 1. Purpose and register rows

Give an inspector exactly the evidence they asked for, about exactly the people they need, with
nobody else's details in it, by a link only they can open, for a limited time; and keep the
statement of purpose complete, versioned, approved by the right person and sent to CQC on time.

| Phase 1 rows | Later rows |
| --- | --- |
| QUAL-003 inspector evidence pack export (PDF bundle, watermarked, time-limited link); QUAL-009 statement of purpose with change tracking | QUAL-001 framework model and QUAL-002 evidence library tagging (Phase 2; slice 11 takes statement ids as opaque strings); QUAL-004 to QUAL-008, QUAL-010 to QUAL-013 |

## 2. Schema (for the schema and API step)

Forced RLS on every table (ADR-0002). Evidence packs are visible to tenant-wide quality roles and
to managers at the pack's locations; the inspector sees a released pack only through its link.

| Table | Kind | Key columns | Retention class |
| --- | --- | --- | --- |
| `evidence_pack` | mutable, versioned | pack id, recipient (name, organisation, work email), purpose, date range, locations, statement filter, people in scope, staff names (`role_only` or `include`), composed by and at, editors (every user who changed the draft), state (`EVIDENCE_PACK_WORKFLOW`), released by and at, revoked by, at and reason, watermark text | `evidence_pack` |
| `evidence_pack_item` | append-only | pack, record type, record id, record version, statements, field outcomes (key, kind from the map, `included`, `redacted` or `withheld`, reason, redacted by); excluded items with their reason (internal manifest only) | `evidence_pack` |
| `evidence_pack_link` | mutable | pack, recipient email, token hash (never the token), issued by and at, replaces link (on a re-issue), expires at, revoked at, failed code attempts (never reset), last opened at | `evidence_pack` |
| `evidence_pack_link_code` | append-only, then marked used | link, code hash (never the code), issued at, used at | `evidence_pack` |
| `evidence_pack_bundle` | document | the rendered PDF bundle, deleted when the link expires or is revoked (`evidencePackBundleDeletable`) | deleted at link end; the manifest stays |
| `statement_of_purpose_version` | mutable while draft, then fixed | version, state (`STATEMENT_OF_PURPOSE_WORKFLOW`), kind (`baseline`, `revision`), content (Schedule 3 sections), author, contributors, approved by and at, change summary, registration prompts, notification due at, notified at, by and evidence (CQC reference or how it was sent) | `organisation_document` |

Opens of a pack, failed codes and revocations are audit events. Field mapping:
[data-standards.md](data-standards.md#packs-and-governance-phase-1-slice-11); purposes:
[records of processing](../compliance/records-of-processing.md).

## 3. Permissions

From `packages/domain/src/platform/permissions.ts` (matrix: [permissions.md](permissions.md)).

| Permission | Allows | Held by (built-in roles) |
| --- | --- | --- |
| `quality.evidence_pack.compose` | Compose a pack (evidence, people in scope, redactions by hand), discard a draft, revoke a released pack's link | Owner, Registered Manager, deputy, quality lead |
| `quality.evidence_pack.release` (step-up) | Release a pack by its link, or issue a new link to the same recipient; never by anyone who composed, redacted or edited the pack | As above |
| `quality.evidence.read` (care record, so MFA) | Open a pack released to you, when the inspector has a Harbour account | Inspector only |
| `quality.statement_of_purpose.write` | Draft a revision | Owner, Registered Manager, deputy, quality lead |
| `quality.statement_of_purpose.approve` | Approve a revision, not one you wrote or edited | Owner (Nominated Individual), Registered Manager |
| `safety.notification.submit` (step-up) | Record that the revision was sent to CQC | Owner, Registered Manager |

`quality.evidence.manage` keeps tagging records as evidence (QUAL-002). Revoking a link is always
open to the pack's composers, because withdrawing access can only make things safer.

`quality.evidence.read` opens care records outside the provider, so it is marked as a care-record
permission (MFA, section 5.3) and held by the inspector role alone. Owners, managers, deputies and
quality leads do not need it: they see the internal manifest through `quality.evidence_pack.compose`,
and a group executive's consolidated reporting never includes a pack. Least privilege, tested in
`evidence pack permissions`.

## 4. Rules that are easy to get wrong

Every rule has a table-driven test in `packages/domain/src/quality/` (named with its hazard ID
where one applies). Figures come from `rate_table`: the link expiry default and maximum are tenant
policy defaults (resolved with `resolveEvidencePackPolicy`), the statement of purpose notice period
is statutory (`resolveStatementOfPurposeRates`, England only until the nation packs).

### Inspector evidence pack (QUAL-003, HZ-050)

1. **Request** (`checkEvidencePackRequest`). A named recipient, their organisation, a work email
   that looks real, a purpose of at least `MIN_EVIDENCE_PURPOSE_LENGTH` characters, a valid date
   range (UK dates, inclusive) and at least one location. The people in scope are chosen
   explicitly; there is no "everyone".
2. **Selection** (`evidenceItemExclusion`). An item is left out, with the reason kept in the
   internal manifest, when it is in a restricted silo (speak-up concerns, employee relations
   casework, legal advice: never in a pack), outside the date range in UK time, at a location not
   asked for, untagged, tagged only to statements not asked for, or about people none of whom are
   in scope. An item about two people, one in scope, is included and the other person's details
   are withheld field by field.
3. **Minimisation and redaction** (`minimiseEvidenceField`), field by field, each with its reason
   printed in words (`EVIDENCE_REDACTION_TEXT`). The kind of a field comes from a typed map
   (`EVIDENCE_FIELD_KIND_MAP`, read with `evidenceFieldKind`), never from the caller, and a field the
   map does not name is treated as free text:
   - organisational detail is kept;
   - care content is kept only when it is about a person in scope; about anyone else, or about
     nobody known, it is withheld;
   - direct identifiers (NHS number, date of birth, address, telephone) are withheld as not needed
     to assess care, and available on request;
   - third parties (relatives, visitors, other residents, witnesses who are not staff, outside
     clinicians) become their role in brackets, for example "[relative]";
   - staff names become their role unless the request needs names (staffing evidence);
   - free text may name anyone, so it is withheld until a person has redacted it by hand; the
     redacted copy is shown with who did it.
   Roles come from two closed lists (`EVIDENCE_PARTY_ROLES`, `EVIDENCE_STAFF_ROLES`); a role not on
   them prints as "[another person]" or "[member of staff]". Titles are generic labels Harbour
   builds, never free text.

   | Record type | Organisational | Care content | Staff name | Third party | Free text |
   | --- | --- | --- | --- | --- | --- |
   | `incident` | `type`, `occurred_at`, `location`, `severity`, `emergency_services` | `harm_grade`, `injury` | `raised_by`, `closed_by`, `staff_involved`, `witness_staff` | `witness_other`, `family_informed` | `description`, `immediate_actions` |
   | `care_note` | `category`, `tags`, `occurred_at`, `late_entry` | none | `author` | none | `text` |
   | `observation` | `chart`, `occurred_at` | `values`, `news2` | `recorded_by` | none | `comment` |
   | `body_map_mark` | none | `region`, `side`, `mark_type`, `category`, `size` | `recorded_by` | none | `note` |
   | `assessment` | `tool`, `tool_version`, `next_due_on` | `score`, `band`, `workings` | `assessor` | none | none |
   | `care_plan_section` | `domain`, `published_version` | none | `published_by` | none | `need`, `outcome`, `strengths`, `contingency` |
   | `risk_assessment` | `template`, `review_date` | `likelihood`, `severity`, `rating` | `assessor` | none | `hazard`, `controls`, `positive_risk` |
   | `activity_record` | `format` | `attendance`, `engagement` | `staff` | none | `activity`, `notes` |
   | `visit_log` | `kind`, `starts_at`, `ends_at` | `restrictions_applied` | `recorded_by` | `visitor_name` | `visitor_relationship`, `restriction_reason`, `notes` |
   | `advance_care_record` | `kind`, `completed_on`, `review_due_on`, `status` | `cpr_decision` | none | `clinician_name` | `details`, `withdrawn_reason` |

   Every type also has `person_name` and `room` (care content, so kept only for a person in scope)
   and `nhs_number`, `date_of_birth`, `address` and `phone` (direct identifiers, always withheld).
   `visitor_relationship` is typed by a person ("my son's partner, Jo"), so it is free text. A new
   column on any of these records joins the map in the same change, and the test
   `covers every evidence record type` fails until it does.
4. **Checking a hand redaction** (`redactionLeaks`). A hand-redacted copy is withheld again
   (`redaction_incomplete`) when it still contains the name of a third party on the record, a staff
   name while the pack shows roles only, the name of a person on the record who is outside the
   pack's scope, or a run of ten or more digits however spaced (an NHS or telephone number). Names
   are matched whole and by each part of three letters or more, ignoring case, with plain string
   search (no regular expressions over the text). The check catches slips; it does not replace the
   releaser's read-through.
5. **Watermark** (`evidencePackWatermark`), on every page: "Prepared for [recipient],
   [organisation]. Purpose: [purpose]. Made [dd/mm/yyyy hh:mm]. Pack [id]. Do not share further."
   A long purpose is shortened at a word boundary to `MAX_WATERMARK_PURPOSE_LENGTH` characters.
6. **Release** (`checkEvidencePackRelease`). Only a draft with at least one item; by a holder of
   `quality.evidence_pack.release` with a sign-in within the step-up window; never by anyone who
   shaped the pack. The contributors (`evidencePackContributors`) are the composer, every person
   who redacted free text by hand (`redactedBy` on each field) and every other editor of the draft.
   A second pair of eyes that did none of the work reads the redactions before anything leaves the
   provider.
7. **The link** (ADR-0050). One link per recipient: an opaque random token, stored only as a hash,
   that opens only after the recipient enters a one-time code sent to the bound email address.
   Expiry defaults to `evidence_pack.link_expiry_days.default` days and may be set up to
   `evidence_pack.link_expiry_days.max` days (tenant policy defaults, marked to verify, not
   statutory). `evidencePackLinkAccess` refuses a draft or discarded pack, a revoked link, an expired
   link (at the expiry instant), a link locked after `EVIDENCE_LINK_MAX_CODE_ATTEMPTS` wrong codes,
   a request with no verified session for this link, and a session whose verified email is not the
   recipient's (case and spaces ignored, ASCII only). Every open is audited.
8. **Codes** (`checkEvidencePackCode`, `isWellFormedEvidenceCode`, `failedCodeAttemptsAfter`).
   - A code is `EVIDENCE_LINK_CODE_DIGITS` (6) digits from the platform's cryptographic random
     source, stored only as a hash and compared in constant time by the API.
   - It lasts `evidence_pack.code_valid_minutes` minutes (tenant policy default, at most 10) and is
     used once; asking for a new code does not extend the old one.
   - A code entered for another link, not six digits, already used or past its time is refused
     before it is compared.
   - The failed-attempt count only ever goes up: a correct code does not reset it, so a guesser
     cannot take turns with the real recipient. At the limit the link locks for good.
   - A correct code sets an HttpOnly, Secure, SameSite=Strict session cookie for that link alone
     (`EvidencePackLinkSession`: the link id and the address the code went to). The verification
     lives in that session, never on the link row, so verifying in one browser opens nothing in
     another.
9. **A new link is a release** (`checkEvidencePackLinkReissue`). After a lock-out or a lost email,
   a new link needs the same checks as release (permission, step-up, not a contributor, expiry
   within the maximum), goes to the same recipient only (anyone else needs a new pack), and revokes
   the old link in the same transaction.
10. **After the link ends.** When the link expires or is revoked, the rendered bundle is deleted
    (`evidencePackBundleDeletable`); the manifest (items with record versions, redactions,
    recipient, purpose, link events) stays as proof of the disclosure under the `evidence_pack`
    class and can rebuild the pack from the record versions.

### Statement of purpose (QUAL-009)

11. **Checklist** (`checkStatementOfPurpose`). The CQC (Registration) Regulations 2009 Schedule 3,
   in its words, as five items: aims and objectives (para 1); the kinds of services and the range
   of needs they meet (para 2); names and contact details of the provider and any registered
   manager (full name, business address, business telephone, email where available) and, for the
   registered person, the address for notices and, if they agree to email service, the email
   address (para 3, substituted by S.I. 2012/921); the legal status of the provider (para 4); the
   locations (para 5). Read on legislation.gov.uk on 11 October 2026. A statement with no
   registered manager listed is complete under Schedule 3 ("any registered manager") but carries a
   warning.
12. **Versions and change summary** (`statementOfPurposeChanges`). Every approved version is fixed;
   a change starts a new draft (`startStatementOfPurposeRevision`). The summary works section by
   section in plain English: "Location added: Harbour Lodge", "Registered manager removed: ...",
   "Provider business telephone number changed", "Aims and objectives reworded". The first version
   loaded into Harbour is the `baseline`: the statement CQC already holds.
13. **Registration prompts** (`statementOfPurposeRegistrationPrompts`, Harbour's reading, to
    confirm with CQC, H-97). Adding or removing a location usually needs an application to vary the
    conditions of registration (Health and Social Care Act 2008 s.19); a new registered manager
    applies to be registered as a manager (s.14); a new legal entity must itself be registered
    (s.10). Harbour prompts; it does not decide.
14. **Approval** (`checkStatementOfPurposeApproval`). Only a draft, complete against Schedule 3, that
    differs from the current version; by a holder of `quality.statement_of_purpose.approve` (the
    registered provider or a registered manager, not a deputy); never by its author or anyone who
    edited it. Approval supersedes the previous version.
15. **Notification to CQC** (`statementOfPurposeNotificationState`,
    `checkStatementOfPurposeNotificationRecord`). Regulation 12(3): "The registered person must
    provide written details of any revision to the statement of purpose to the Commission within
    28 days of any such revision." The revision is made on approval, so a revision is due
    `cqc.statement_of_purpose.revision_notice_days` days (verified) after approval, in UK wall-clock
    time; a baseline needs no notification. Recording the submission needs
    `safety.notification.submit` with step-up (section 4), a time not before approval and the CQC
    reference or how it was sent. Overdue revisions escalate like other notification clocks
    (safety.md rule 10); a late submission is recorded as late.

## 5. API, audit events and outbox events

For the schema and API step (none of this is built in slice 11):

- `GET` and `POST /v1/evidence-packs` (compose a draft from the request; the server gathers the
  tagged items in scope and runs `composeEvidencePack`), `GET /v1/evidence-packs/{id}` (the
  manifest with outcomes and reasons), `PUT .../items/{itemId}/fields/{key}/redaction` (a redacted
  copy of free text; runs `redactionLeaks` and records the editor), `POST .../release` (step-up;
  returns the link once, never stored), `POST .../links/{linkId}/reissue` (step-up; revokes the
  old link and returns the new one once), `POST .../revoke`, `POST .../discard`.
- Public link routes outside the tenant API: `POST /p/evidence/{token}/code` (sends a new
  one-time code to the bound address, rate-limited; never in the same message as the link),
  `POST /p/evidence/{token}/verify` (on a correct code marks it used and sets the HttpOnly session
  cookie for this link; a wrong code adds one to the failed count), `GET /p/evidence/{token}/bundle`
  (needs that session; streams the watermarked PDF with `no-store`; never a presigned bucket URL).
- `GET`, `POST /v1/statement-of-purpose/versions`, `PUT .../{id}` (drafts only), `POST
  .../{id}/approve`, `POST .../{id}/notification` (step-up), `GET .../{id}/changes`.
- Audit events: `quality.evidence_pack.composed`, `.redacted`, `.released`, `.link_reissued`,
  `.revoked`, `.discarded`, `.code_sent`, `.code_failed`, `.link_locked`, `.opened`,
  `.bundle_deleted`; `quality.statement_of_purpose.drafted`,
  `.approved`, `.notified`.
- Outbox events: `quality.evidence_pack.released`, `quality.evidence_pack.revoked`,
  `quality.statement_of_purpose.approved` (starts the notification clock; the notification centre
  reminds the Registered Manager), `quality.statement_of_purpose.notification_overdue`.

## 6. Offline behaviour

None: composing, releasing and opening evidence packs and editing the statement of purpose are
online-only manager tasks.

## 7. Clinical safety

HZ-050 (an evidence pack exposes a third party or a person outside its scope) is new with this
spec: the harm is to people whose details reach someone they did not expect (safeguarding,
whistleblowers, other residents), so it sits in the log beside HZ-022. Its controls are the typed
field map, the leak check on hand redactions, release and re-issue only by someone who did not
shape the pack, and codes and sessions bound to one recipient (rules 3 to 9). The statement of purpose
touches no hazard: it holds no care data. Medical-device boundary: unchanged; the pack copies
records and applies the provider's redaction rules
([medical-device-boundary.md](../compliance/medical-device-boundary.md)).

## 8. Data protection and data standards

The evidence pack is a disclosure of special category data to a regulator or commissioner. Lawful
basis: legal obligation where CQC requires the information (Health and Social Care Act 2008 s.64),
otherwise the basis of the provider's regulated activity; special category condition Article 9(2)(h)
with DPA 2018 Schedule 1 paragraph 2(2)(f) (management of social care services), to be confirmed by
the DPO (H-96). Minimisation is the default (rules 2 and 3); the recipient, purpose and every open
are recorded; the bundle is deleted at link end. One-time codes are stored only as hashes and
verification lives in a browser session, not on the link. Retention: `evidence_pack` for the manifest and
link; `organisation_document` for statement of purpose versions ([retention.md](retention.md)).
Statement of purpose versions hold the provider's and registered managers' business contact details
(records of processing B6). Field mapping:
[data-standards.md](data-standards.md#packs-and-governance-phase-1-slice-11).

## 9. Acceptance criteria and tests

- Domain (built, slice 11): `packages/domain/src/quality/evidence-pack.test.ts` (request checks;
  the field-to-kind map for every record type; field rules; the leak check on hand redactions;
  item exclusions with UK dates; composition, coverage and versions; watermark; release and
  re-issue by non-contributors with step-up and expiry limits; codes; link access by session;
  bundle deletion; the code lifetime ceiling; permissions) and `packages/domain/src/quality/statement-of-purpose.test.ts` (rate row verified;
  Wales fails loudly; Schedule 3 checklist; change summary; registration prompts; approval; the
  regulation 12(3) clock; recording the notification; permissions);
  `packages/domain/src/shared/email.test.ts`.
- Database: RLS and HZ-011 isolation for the new tables; append-only `evidence_pack_item`; token
  and code hashes only; failed code attempts never decrease; fixed approved statement versions.
- API: `hazard HZ-050 the rendered pack contains no third party's name and no person outside its
  scope` (snapshot of a rendered fixture pack); the link refuses a forwarded recipient, another
  browser without its own session, a used or expired code, an expired link and a revoked link; a
  re-issue revokes the old link; the session cookie is HttpOnly, Secure and SameSite=Strict; the
  bundle is deleted at link end; step-up on release and notification;
  the phase gate's "inspector pack export renders" PDF test.
- Web: Playwright journeys (compose, review redactions, release, revoke; statement draft, approve,
  record the notification) with axe.

## 10. Open questions

- The DPO confirms the redaction rules and the field-to-kind map, the lawful basis for
  disclosure, the `evidence_pack` retention period, the link expiry defaults and the code lifetime
  (H-96).
- CQC confirms the registration prompts and that approval is the date of the revision (H-97).
- Whether CQC's own statement of purpose template asks for more than Schedule 3 (for example the
  regulated activities and service user bands per location) could not be checked (the CQC page
  refused automated access on 11 October 2026); the checklist holds the legal minimum.
- Nation packs (Phase 7) add the CIW, Care Inspectorate and RQIA statement rules and periods.

## 11. As built (slice 11, domain rules)

`packages/domain/src/quality/`, exported from `@harbour/domain`; pure functions with no I/O. No
schema, API or web changes in this slice.

| Module | Main exports | For |
| --- | --- | --- |
| `evidence-pack.ts` | `EVIDENCE_FIELD_KINDS`, `EVIDENCE_RECORD_TYPES`, `EVIDENCE_FIELD_KIND_MAP`, `evidenceFieldKind`, `EVIDENCE_PARTY_ROLES`, `EVIDENCE_STAFF_ROLES`, `checkEvidencePackRequest`, `evidenceItemExclusion`, `minimiseEvidenceField`, `redactionLeaks`, `EVIDENCE_REDACTION_TEXT`, `composeEvidencePack`, `evidencePackWatermark`, `evidencePackContributors`, `EVIDENCE_PACK_WORKFLOW`, `checkEvidencePackRelease`, `checkEvidencePackLinkReissue`, `defaultEvidencePackLinkExpiry`, `EVIDENCE_LINK_CODE_DIGITS`, `isWellFormedEvidenceCode`, `failedCodeAttemptsAfter`, `checkEvidencePackCode`, `evidencePackLinkAccess`, `EVIDENCE_LINK_MAX_CODE_ATTEMPTS`, `evidencePackBundleDeletable` | Rules 1 to 10 |
| `statement-of-purpose.ts` | `STATEMENT_OF_PURPOSE_ITEMS`, `LEGAL_STATUSES`, `checkStatementOfPurpose`, `statementOfPurposeChanges`, `statementOfPurposeRegistrationPrompts`, `STATEMENT_OF_PURPOSE_WORKFLOW`, `checkStatementOfPurposeApproval`, `statementOfPurposeNotificationState`, `checkStatementOfPurposeNotificationRecord`, `startStatementOfPurposeRevision` | Rules 11 to 15 |
| `rates.ts` | `EVIDENCE_PACK_RATE_KEYS`, `resolveEvidencePackPolicy`, `EVIDENCE_CODE_MAX_VALID_MINUTES`, `STATEMENT_OF_PURPOSE_RATE_KEYS`, `resolveStatementOfPurposeRates` | The link and code policy and the regulation 12(3) period |
| `../shared/email.ts` | `isPlausibleEmail`, `normaliseEmail` | Recipient addresses: printable ASCII only, lower-cased in ASCII (no Unicode case-folding), checked with a loop (no backtracking) |

## 12. As built (slice 11, schema: migration 0057)

`packages/db/src/schema/quality.ts` and migration 0057 (`feat/quality-evidence-pack`). Forced RLS
with the tenant policy on every table; the routes, audit and outbox events of section 5 follow
in the API step.

| Table | Built as |
| --- | --- |
| `evidence_pack` | Mutable, versioned. Visible to holders of `quality.evidence_pack.compose` or `.release` at every one of its locations, in a scope covering them all, who can see every person in scope (`app.evidence_pack_visible`, `app.evidence_pack_permitted`); composed as a draft in the composer's own name. The request is fixed once composed (compose a new pack to change it); editors are added by the database; it moves only along `EVIDENCE_PACK_WORKFLOW` in the mover's name; release needs an included item, a holder of release at every location and someone outside `app.evidence_pack_contributors` (composer, editors, hand redactors, item writers) |
| `evidence_pack_item` | Append-only. Included items carry field outcomes, never the shown values or a redacted copy (kinds, outcomes and reasons checked against the domain's lists; keys, labels and titles bounded); excluded items carry their reason (`EVIDENCE_EXCLUSION_REASONS`). A hand redaction is a new row superseding the item, in the redactor's name, and makes them an editor |
| `evidence_pack_bundle` | The shown values (hand-redacted copies included) by item and field key, written while a draft; whoever writes or changes it, other than the composer, becomes an editor and so a contributor; deleted (content cleared, never restored) when the link ends (`link_ended`) or the pack is revoked or discarded. Not versioned, so no copy survives in the history; not exported |
| `evidence_pack_link` | Mutable, versioned. Only for a released pack, to its recipient, by a non-contributor holding release at every location, expiring within `evidence_pack.link_expiry_days.max` (UK days; no figure refuses). One live link per pack; a new one replaces the last, revoked as `reissued` first. Failed attempts never go down; a revoked link is final; an open is recorded only while the link is live (released, unrevoked, unexpired, under 5 failed codes) |
| `evidence_pack_link_code` | Issued only for a live link; `valid_until` worked out by the database (`evidence_pack.code_valid_minutes`, at most 10); only `used_at` may change, once, before it lapses, while the link is live (a column grant) |
| `statement_of_purpose_version` | Readable by holders of `quality.statement_of_purpose.write` or `.approve` or `safety.notification.submit` anywhere (`app.holds_permission_anywhere`); drafted by holders of write, numbered by the database; the first is the baseline. A draft's editors join its contributors; approval of the content as it stands, different from the current version, by an approver who is neither author nor contributor, supersedes the current version inside the same trigger and sets `notification_due_at` for a revision (`cqc.statement_of_purpose.revision_notice_days`, UK days). Approved versions are fixed except the CQC notification, recorded once by a holder of `safety.notification.submit` |

The public link routes find a link with `app.evidence_pack_link_for_token(token_hash)` (the API passes the SHA-256 hex digest, never the raw token) (security
definer, owned by the NOLOGIN role `harbour_evidence_link_reader`, which reads only the link's
tenant, id, pack and token hash), then work in that organisation as the system on that link alone.
Tests: `packages/db/test/evidence-pack.test.ts`; the RLS coverage test lists `evidence_pack_item`
as append-only; the export catalogue classifies every new column (token and code hashes secret).
Opening a released pack with a Harbour inspector account (`quality.evidence.read`) needs a policy
of its own in the API step.

## 13. As built (slice 11, API part 2a: evidence pack routes and the bundle sweep)

`apps/api/src/routes/evidence-packs.ts`, `apps/api/src/services/evidence-pack.ts`, contracts in
`packages/contracts/src/quality.ts` (`feat/quality-evidence-pack-api`).

| Route | Built as |
| --- | --- |
| `GET /v1/evidence-packs`, `GET .../{id}` | `quality.evidence_pack.compose` or `.release` (scope of whichever the session may use); the manifest has every current item, each field's outcome, reason in words and the value the pack shows while the bundle exists (never a withheld one), the contributors and the links (never a token or code). Opening the manifest is audited (`quality.evidence_pack.viewed`) |
| `POST /v1/evidence-packs` | Compose: the domain's request check, every person and location visible to the composer, the watermark worked out with the pack id and the database's time; `.composed` |
| `POST .../{id}/items` | Records named by type, id and statements (tagging until QUAL-002), read in the composer's scope (anything else is 404), a corrected entry refused (add the correction), a record already in the pack refused; `composeEvidencePack` keeps or excludes each and minimises every field; only shown values go to the bundle; `.items_added` with counts and record ids. Record types so far: `care_note`, `observation` (numbers, yes or no and codes are the reading; any other text in the values, such as a drink or an override reason, is free text), `incident` (care content withheld as not clearly about one person when it has several) |
| `PUT .../items/{itemId}/fields/{key}/redaction` | Free text only, on a draft, while the record is unchanged; earlier hand redactions stand in their redactors' names; a copy that leaks (rule 4) is refused with 422 and nothing stored; otherwise a superseding item row and the bundle updated; `.redacted` |
| `POST .../release` | Release permission with step-up (`requirePermission`), then `checkEvidencePackRelease` with the database's contributors and the rate-table policy, then the database's own checks; the link is issued in the same transaction; the 256-bit token is returned once and only its SHA-256 stored; `.released` and the outbox `quality.evidence_pack.released` (pack, link, expiry) |
| `POST .../links/{linkId}/reissue` | The pack's latest link only, while it has not ended and the bundle exists (an ended link means a new pack); `checkEvidencePackLinkReissue`; the old link revoked as `reissued` and the new one issued in one transaction; `.link_reissued` |
| `POST .../revoke`, `POST .../discard` | Compose permission with a reason; revoking also revokes the live link (`pack_revoked`); both delete the bundle at once (`.bundle_deleted`); revoke publishes `quality.evidence_pack.revoked` |

Refusals decided in the API and those the database raises (separation of duties 403, workflow
409) are audited as denied. The worker's `evidence-bundle-sweep` queue (every 5 minutes, per
organisation as the system) deletes every bundle whose pack is revoked or discarded or whose links
have all ended (revoked or expired), audited `quality.evidence_pack.bundle_deleted` with the reason.
Tests: `apps/api/test/evidence-packs.test.ts`.

Still to come: the statement of purpose routes and its overdue job (part 2b), the public link
routes with codes, the session cookie and the PDF (part 2c), and the remaining record types.

## 14. As built (slice 11, API part 2b: the statement of purpose)

`apps/api/src/routes/statement-of-purpose.ts`, `apps/api/src/services/statement-of-purpose.ts`
(`feat/quality-statement-of-purpose-api`, stacked on part 2a).

| Route | Built as |
| --- | --- |
| `GET /v1/statement-of-purpose/versions` | Holders of `quality.statement_of_purpose.write` or `.approve` or `safety.notification.submit`; newest first, each with the Schedule 3 gaps in words, the warnings and where a revision stands against the regulation 12(3) clock (`not_required`, `due`, `overdue`, `notified` with `late`), read from the times the database set |
| `POST .../versions` | Write: the first version is the baseline and needs its content; later drafts are revisions starting from the current version unless content is given; one draft at a time (409); `.drafted` |
| `PUT .../{id}`, `POST .../{id}/discard` | Write, drafts only, against the loaded version; an editor joins the contributors; `.edited`, `.discarded` |
| `POST .../{id}/approve` | Approve: `checkStatementOfPurposeApproval` (not the author or an editor, complete, changed) with `cqc.statement_of_purpose.revision_notice_days`, then the database's guard; the change summary and registration prompts stored; `.approved` and the outbox `quality.statement_of_purpose.approved` (version, kind, due date) |
| `POST .../{id}/notification` | `safety.notification.submit` with step-up: `checkStatementOfPurposeNotificationRecord`, never a time in the future; once; a submission after the due date shows as late; acknowledges the overdue alerts; `.notified` |
| `GET .../{id}/changes` | A draft against the current version, an approved one against the version it superseded, with the registration prompts |

The worker's `statement-of-purpose-overdue` queue (hourly) tells every active holder of
`safety.notification.submit` anywhere once, urgently, through the tenant's overdue escalation
chain, about an approved or superseded revision past its due date with no notification recorded,
and publishes `quality.statement_of_purpose.notification_overdue` once; with nobody to tell it
audits `quality.statement_of_purpose.unrouted` at most daily and tries again. Tests:
`apps/api/test/statement-of-purpose.test.ts`.
