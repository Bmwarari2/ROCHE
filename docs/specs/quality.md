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
   | `care_note` | `category`, `occurred_at`, `late_entry` | none | `author` | none | `text`, `tags` (any word a person chose) |
   | `observation` | `chart`, `occurred_at` | `values`, `news2` | `recorded_by` | none | `comment` |
   | `body_map_mark` | none | `region`, `side`, `mark_type`, `category`, `size` | `recorded_by` | none | `note` |
   | `assessment` | `tool`, `tool_version`, `next_due_on` | `score`, `band`, `workings` | `assessor` | none | none |
   | `care_plan_section` | `domain`, `published_version` | none | `published_by` | none | `need`, `outcome`, `strengths`, `contingency` |
   | `risk_assessment` | `template`, `review_date` | `likelihood`, `severity`, `rating` | `assessor` | none | `hazard`, `controls`, `positive_risk` |
   | `activity_record` | `format` | `attendance`, `engagement` | `staff` | none | `activity`, `notes` |
   | `visit_log` | `kind`, `starts_at`, `ends_at` | `restrictions_applied` | `recorded_by` | `visitor_name` | `visitor_relationship`, `restriction_reason`, `notes` |
   | `advance_care_record` | `kind`, `completed_on`, `review_due_on`, `status` | `cpr_decision` | none | `clinician_name` | `details`, `withdrawn_reason` |

   Care notes and observations also have `recorded_at`, `late_entry`, `clock_drift`,
   `correction_of` and `back_entry` (organisational, Harbour's own words) and `correction_reason`
   and `paper_reference` (free text); incidents have `recorded_at`, `late_entry` and `clock_drift`.
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

After #60 review round 1: release re-reads every included record in the releaser's scope and is
refused (409 `record_changed`, naming each) when one was corrected or changed since it was added or
the releaser cannot open it. Each entry says how it came to be: "Correction of an earlier entry
recorded [time]" (reason free text), "Written on paper at [paper time] during a [kind] outage from
[time], and entered in Harbour later" (paper reference free text), "Recorded in Harbour [time]" and
a wrong device clock. Readings use a label and unit per chart field (`observationReading`), and
only the chart schema's own enum values count as codes. Every time is UK time with GMT or BST
(`formatUkDateTimeWithZone`). The token responses say `no-store`; the API logs no request bodies.
Human actions H-221 to H-223.

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
audits `quality.statement_of_purpose.unrouted` at most daily and tries again. The alert names the
version and the due date ("Statement of purpose version 2 is overdue at CQC"; "It was due at CQC
by 13/11/2026. ..."; H-219), hazard HZ-080 (DCB0129 scope for the CSO, H-224). Tests:
`apps/api/test/statement-of-purpose.test.ts`.

## 15. As built (slice 11, API part 2c: the public link routes and the PDF)

`apps/api/src/routes/evidence-link.ts`, `apps/api/src/services/evidence-link.ts`,
`apps/api/src/services/evidence-pack-pdf.ts`, migration 0058 (`feat/quality-evidence-pack-public`).
A deviation from section 5's paths, on #56's security review: the token is never in a URL Harbour
serves; it goes only in a request body (as invitation links do), and opening the pack needs only
the session cookie.

| Route | Built as |
| --- | --- |
| `POST /p/evidence/code` `{ token }` | The token's SHA-256 looked up with `app.evidence_pack_link_for_token`; an unknown token is 404 (a platform audit event). In the link session: a link that no longer opens says why (410); at most `MAX_LIVE_CODES_PER_LINK` (3) codes open at once (429); a six-digit code from the cryptographic source is stored as HMAC-SHA256 of the link and code under `EVIDENCE_LINK_SECRET`, its lifetime worked out by the database; the code alone is emailed to the bound address, with no link; `.code_sent` |
| `POST /p/evidence/verify` `{ token, code }` | Not six digits: 422, not counted. With the link row locked, the code is compared in constant time with the link's open codes; a right one is marked used (`.code_verified`) and sets the signed session cookie (HttpOnly, Secure, SameSite=Strict, path `/p/evidence`, at most `EVIDENCE_LINK_SESSION_MINUTES` and never past the link's expiry); a wrong one adds one to `failed_code_attempts` in the same transaction (`.code_failed`), and at `EVIDENCE_LINK_MAX_CODE_ATTEMPTS` (5) the link locks for good (`.link_locked`, 410) |
| `GET /p/evidence/bundle` | The cookie alone (its signature, its expiry); `evidencePackLinkAccess` on every request (released, not revoked, not expired, not locked, the session's address the recipient's); refused once the bundle is deleted; the watermarked PDF drawn from the manifest and bundle through the ADR-0040 writer (included items only; withheld and redacted fields say why; the watermark on every page), `no-store`, attachment, never stored; `last_opened_at` and `.opened` |

Every request runs as the link session (migration 0058: `app.link_id` and `app.link_pack_id`, no
member, scope 'none'), which reaches that link, its pack, items, bundle and codes alone, reads the
pack, items and bundle only, and nothing of the statement of purpose, whatever scope it claims.
Throttled per client address (the trusted-proxy hop, `throttleAddress`) and per link, in each API
instance's memory. `/p/*` responses are `no-store`. `EVIDENCE_LINK_SECRET` comes from Secrets
Manager (the `api` secret's `evidence_link_secret`) and the API refuses to start in production
without it. Tests: `apps/api/test/evidence-link.test.ts`, `packages/db/test/evidence-pack.test.ts`
(the link session). Human actions H-225 to H-227.

After #66 review round 1: the printed pack's header gives the composing and release times with GMT
or BST, and its first page says it shows the records as they stood when it was released (H-222);
a field the bundle has no value for prints "Withheld: not available in this pack". A link session
reads none of `audit_event`, `tenant_user`, `notification`, `task`, `document`,
`role_assignment`, `access_grant` or `outbox_event`, and a trigger refuses it revoking its link.
The per-address throttle uses one shared bucket when no client address is known, audit rows take
the address from the trusted hop, and the cookie is `__Host-harbour_evidence_session` (path `/`),
its content encrypted with AES-256-GCM and signed, so the recipient's address is not readable in
it.

## 16. Web screens (QUAL-003 and QUAL-009, `feat/web-evidence-sop`)

Spec, permission matrix and test list written before the code (section 20 rule 3). The web holds
nothing of its own: every rule is the API's (sections 13 to 15), and the screens say in words what
it decides. Online only (section 6).

### Screens

| Route | Shows | Who sees it |
| --- | --- | --- |
| `/quality/evidence-packs` | Every pack the API lists, newest first: recipient and organisation, purpose, dates, state as an icon and a word, composed and released times | `quality.evidence_pack.compose` or `.release` |
| `/quality/evidence-packs/new` | Compose: recipient (name, organisation, work email), purpose, from and to dates (dd/mm/yyyy, inclusive), locations (ticked from the composer's own), the people in scope (ticked, never "everyone"), staff names (roles only, the default, or names), the key questions asked for (every one, or those ticked) | `quality.evidence_pack.compose` |
| `/quality/evidence-packs/[id]` | "What will be shared" first: the recipient and their address, purpose, dates, locations, the people in scope by name, staff names, the watermark printed on every page, and the counts of records shown, fields withheld and fields redacted. Then every record in the pack with each field's outcome (shown, redacted by hand, withheld) as an icon and a word with the reason in words, and the value the pack shows; the records left out and why (internal only, never sent); the links with their expiry in words; and the actions below | `quality.evidence_pack.compose` or `.release` |
| `/quality/statement-of-purpose` | The CQC notification clock for an approved revision (due, overdue, sent, sent late) as an icon and a word with the due date; the draft (Schedule 3 gaps, warnings, what changed against the current version with the registration prompts, the editor, approve and discard); the current version; every version | `quality.statement_of_purpose.write` or `.approve` or `safety.notification.submit` |
| `/quality/statement-of-purpose/[id]` | One version: its content, state, who approved it and when, its CQC notification and what it changed against the version it superseded | As above |

The sidebar shows "Evidence packs" and "Statement of purpose" to the same holders.

### Evidence pack actions

| Action | Permission (API) | The screen |
| --- | --- | --- |
| Compose | `quality.evidence_pack.compose` | Checks the form first (every field, dates real and in order, at least one location and one person) and lists every problem at once; the API checks again |
| Add records | compose, draft | Choose a person in scope; their care notes, observations and incidents in the pack's dates are listed (read in the composer's own scope, so audited as care-record views by the API); tick records and the key questions each is evidence for |
| Redact free text by hand | compose, draft | For each withheld free-text field: the original from the composer's own view of the record where the web can read it, to edit; "Save the redacted copy". A copy that still names someone is refused in the API's words (rule 4). Says that redacting makes you a contributor, so someone else must release |
| Release | `quality.evidence_pack.release`, step-up, not a contributor | Shown only to a non-contributor; a contributor is told why they cannot. How long the link works (days, up to the maximum read from the rate table; the default preselected), the expiry in words before sending, and a box to tick: "I have read every record and redaction in this pack". The link appears once, in the page only (never in a URL, never stored by the web), with the recipient's address and "the code goes to them separately by email" |
| New link | release, step-up, not a contributor, released pack with a live latest link | As release; the old link stops working at once, and the screen says so |
| Revoke | compose, released | A reason; the link stops at once and the bundle is deleted |
| Discard | compose, draft | A reason; the bundle is deleted |

Quality statement ids stay opaque until QUAL-001 (section 1). Until the framework model arrives
the web offers the five CQC key questions as the ids (`safe`, `effective`, `caring`,
`responsive`, `well-led`), which the API's id pattern accepts; QUAL-001 replaces the list with the
quality statements and maps these to their key question.

The link the screen shows is `PUBLIC_WEB_URL/evidence#<token>`: the token in a fragment never
reaches a server in a URL, a log or a Referer (as invitations do). The public page is below.

### Statement of purpose actions

| Action | Permission (API) | The screen |
| --- | --- | --- |
| Load the baseline | `quality.statement_of_purpose.write`, no versions yet | The editor, empty, titled "The statement CQC already holds" |
| Start a revision | write, no draft | One button; the draft starts from the current version |
| Edit a draft | write | Every Schedule 3 item: aims and objectives; kinds of service (one per line) and the needs met; the provider's and each registered manager's full name, business address, telephone and email; the address for notices, consent to email service and that email; legal status (and detail for "other"); each location's name, address and CQC location id. Managers and locations can be added and removed; each keeps its id, so the change summary and registration prompts follow them. Saving says that an editor cannot approve |
| Approve | `quality.statement_of_purpose.approve`, not the author or an editor | Shown only when the draft is complete; says that approval starts the 28-day clock (the figure from the API's due date, never a literal) and shows the registration prompts first |
| Discard | write | A reason |
| Record that it was sent to CQC | `safety.notification.submit`, step-up | When (just now or earlier, never in the future) and the CQC reference or how it was sent; late shows as late |

### Tests

- Unit (`apps/web/src/lib/evidence-packs.test.ts`, `statement-of-purpose.test.ts`): the compose
  form reader (every problem at once; dates; no "everyone"); the field outcome chips; the link
  state and expiry in words (live, ending today, expired, revoked, locked, replaced); who may
  release (contributors told why); the expiry choices never past the maximum; the shareable link
  keeps the token in the fragment; the statement form reader (lists one per line, managers and
  locations keep their ids, empty email as null); the notification chip and due words.
- Journeys with axe in light and dark themes: `apps/web/e2e/evidence-pack.spec.ts` (HZ-050: the
  manager composes, adds a care note, redacts its text by hand and cannot release; the owner,
  stepped up, sees what will be shared, releases, sees the link once with its expiry in words,
  and the manager revokes it) and `apps/web/e2e/statement-of-purpose.spec.ts` (HZ-080: the manager
  drafts and cannot approve; the owner approves; the due clock shows; the owner, stepped up,
  records the notification).

As built (`feat/web-evidence-sop`, review round 1, security, clinical safety and accessibility):

- The link's origin is `PUBLIC_WEB_URL` (the local server outside production), never a request
  header; without it release and a new link are not offered and the page says why.
- A hand redaction shows the original (incidents only, read once by id) read-only beside an empty
  box and refuses an unchanged copy; a care note is not read across the people in scope to
  prefill it (DPIA R13), so the composer opens the record. Refusing an unchanged copy in the API
  too is left for the API (`redactionLeaks` cannot see it).
- Days left (link expiry and the CQC due date) are UK calendar days ("today", "tomorrow", "in n
  days"), never rounded up, and the release preview uses `addUkDays` as the API does; approval
  says the period from `cqc.statement_of_purpose.revision_notice_days`.
- People are listed with date of birth and communication needs; withdrawing a pack asks for a
  confirmation; record choices carry their time in the name; focus moves to the form, link panel
  or row it concerns; each statement error names its field; the server actions check their input.
- Left for later: the API's English refusal text is not yet marked `lang="en-GB"` in the shared
  error summary (Phase 7, Welsh); revoking stays with compose holders, as specified (a question
  for the CSO).

### The public inspector page (`/evidence`)

Signed out, no product shell, the title "Evidence pack" (never a person, recipient or pack),
`noindex` and no Referer. Built after #113's first review.

- The token is read from the fragment once and taken out of the address bar at once; it is kept
  only in the page's memory and sent only in JSON bodies to the page's own route handlers
  (`/api/evidence/code`, `/api/evidence/verify`), which pass it to the API's `/p/evidence/code` and
  `/verify` in a body. The handlers take same-origin JSON posts only (the origin from
  `PUBLIC_WEB_URL`, never the request), pass on the user agent and the trusted-proxy client
  address, log nothing, and answer `no-store`. A code that is not six digits is refused before it
  is sent, so it is never counted.
- A right code makes the API set its HttpOnly, Secure, SameSite=Strict session cookie for that
  link alone (`__Host-`, path `/`); the handler passes it back unchanged, and the token is
  forgotten. "Download the pack" calls `/api/evidence/bundle`, which forwards that cookie (the
  only credential), streams the watermarked PDF as `evidence-pack.pdf` with `no-store` and
  `nosniff`, and stores nothing.
- Views, each starting with a heading that takes focus and an icon with words: open (ask for a
  code), enter the code (a code that does not match, or too many requests, is said at the field
  and linked from the summary), ready (the download, with "do not share it further"), withdrawn,
  expired, locked, for someone else, not found, unreachable, and opened without its token (which
  still offers the download to a browser that already has a session).
- Tests: `apps/web/src/lib/evidence-link.test.ts`; `apps/web/e2e/evidence-pack.spec.ts`
  (`hazard HZ-050 the inspector opens the link in their own browser with an emailed code and
  downloads the pack`: no request URL carries the token, a code that does not match refused at the
  field, a real PDF downloaded; `hazard HZ-050 a withdrawn link says so in the inspector's browser
  and offers no code`), axe in light and dark. The development email adapter keeps codes in the
  API's memory, so the journey issues one more code with `pnpm --filter @harbour/api
  e2e:evidence-code <address>` (`apps/api/scripts/e2e-evidence-code.ts`: an `example.invalid`
  address only, refused unless the database is local and NODE_ENV is development or test, stored
  exactly as the API stores codes).

After #113's security review (round 2): the public bodies are capped at 4 KiB however they are
sent (`apps/web/src/lib/json-body.ts`, also used by the invitation page); the fragment is cleared
again once Next.js has patched history, so a router refresh never writes the token back (the
invitation page too); the session cookie is a browser-session cookie, and "Finish and remove
access from this browser" clears it; the bundle route passes on only the link's session cookie,
and the PDF carries `content-security-policy: default-src 'none'; sandbox`; the token is
forgotten after any result that ends the flow, including one the page cannot read.

## 17. Phase 2 domain rules (slice 8: QUAL-001, 002, 004, 005, 006, 008, 012)

Master prompt section 11.2 with section 20 rule 3: domain types, the permission matrix, the rules
and the test list come before code. This slice is pure domain rules in new files under
`packages/domain/src/quality/` (lane E): no schema, API or screens. The schema and API slices that
use them are 14 (framework and evidence library), 19 (audits), 25 (policies), 32 (data security
evidence) and 47 (dashboard and PIR); the screens are 64 and 65. Every figure is read from
`rate_table` (`resolveQualityPhase2Rates` in `quality-rates.ts`); no rule in this slice is a
statutory clock. No new hazard: HZ-129 (an indicator shown as good when its data is missing)
belongs to slice 47, and this slice writes the rule it will test (rule 22).

### 17.1 Domain types

| Module | Types | For |
| --- | --- | --- |
| `quality-framework.ts` | `FrameworkVersion` (id, framework key, regulator `cqc`, `ciw`, `care_inspectorate` or `rqia`, version number, state `draft`, `published` or `retired`, published and retired dates, source citation, key questions each with their statements, evidence categories), `FrameworkMapping` (tenant mapping of a framework version: version number, statement entries with a local title, owner role and the evidence categories the tenant expects, made by and at), `EvidenceTag` (record type and id, statement ids, framework version id, tagged by and at) | QUAL-001, QUAL-002 |
| `quality-audits.ts` | `AuditTemplate` (key, title, kind `medication`, `care_plans`, `ipc`, `environment`, `dignity`, `night_visit`, `mock_inspection` or `other`, framework version id, questions each with a weight, the statements it evidences, and whether a "no" needs an action), `AuditAnswer` (`yes`, `partial`, `no`, `not_applicable`, or unanswered), `AuditRecord` (template, framework version it was scored against, answers, self-rating, actions, completed by and at), `AuditAction` (question, description, owner, due date) | QUAL-004 |
| `quality-indicators.ts` | `IndicatorDefinition` (key, numerator and denominator descriptions, multiplier, unit, direction `lower_is_better` or `higher_is_better`, method in words), `IndicatorInput` (numerator, denominator, coverage: the share of the period and locations with data), `IndicatorTarget` (tenant targets: green and amber thresholds), `IndicatorResult` (value or null, status `green`, `amber`, `red` or `no_data`, reason, method shown) | QUAL-005 |
| `quality-pir.ts` | `PirDataPoint` (key, CQC question area, label, source, unit), `PirValue` (value, as of, source records count, or missing with why), `PirDraft` (each data point with its value or "not available", never a guessed zero) | QUAL-006 |
| `policies.ts` | `PolicyVersion` (policy key, version number, state `draft`, `published`, `superseded`, `retired`, change size `minor` or `major`, review due date, roles that must read it, published by and at), `PolicySignature` (staff member, version, signed at), `ReadAndSignStatus` (who must sign, who has, who is outstanding and since when, who is overdue a reminder) | QUAL-008 |
| `quality-data-security.ts` | `DsptSubmission` (financial year, submitted on, status `standards_met`, `approaching_standards`, `standards_not_met`), `CertificateRecord` (kind `cyber_essentials`, `cyber_essentials_plus`, `ico_registration`; reference; issued on; expires on when the certificate says), `RenewalStatus` (`current`, `due_soon`, `expired`, `missing`) | QUAL-012 |

### 17.2 Permissions

Existing permissions only (packages/domain/src/platform/permissions.ts); the schema slices add any
read permission they need, with their own matrix rows.

| Permission | Allows in these rules | Held by (built-in roles) |
| --- | --- | --- |
| `quality.evidence.manage` | Change a tenant framework mapping; tag a record as evidence | Owner, Registered Manager, deputy, quality lead |
| `quality.audit.manage` | Complete an audit, give the self-rating, raise its actions | Owner, Registered Manager, deputy, nurse in charge, quality lead |
| `quality.policy.manage` | Publish a policy version and choose who must read it | Owner, Registered Manager, deputy, quality lead |
| `quality.dsar.manage` | Record DSPT submissions, Cyber Essentials and ICO registration records (the data security evidence sits with the breach and DSAR registers, section 5.1) | Owner, Registered Manager, deputy, quality lead |

Separation of duties: a policy version is never published by the only person who wrote it when
the tenant requires a second reviewer (`requireSecondReviewer`, rule 25); an audit's self-rating is
given by a person, never worked out from its score (rule 15).

### 17.3 Rules

Each rule has a table-driven test named after it.

**Framework (QUAL-001)**

1. A framework version is data: key questions, statements and evidence categories are rows, never
   code. `checkFrameworkVersion` refuses a version with no key questions, a key question with no
   statements, no evidence categories, a duplicate statement or key question id, or an id outside
   the opaque id pattern the evidence pack already accepts (`^[A-Za-z0-9._-]{1,64}$`). The number
   of statements is whatever the published framework has; Harbour never checks for 34.
2. Versions move `draft` to `published` to `retired` (`FRAMEWORK_WORKFLOW`); a published version's
   content never changes (a change is a new version).
3. `frameworkInForce(versions, regulator, on)`: the published version for that regulator whose
   published date is on or before the UK date and not retired by then; the latest when two
   qualify; null when none, never a guess.
4. Historical audits keep the version they were scored against (`auditFrameworkVersion`): the audit's
   own version id is looked up, even when retired; a missing version fails loudly.
5. Tenant mappings are versioned (`checkMappingChange`): the next version number is the last plus
   one; every statement in the mapping exists in the mapped framework version; only a holder of
   `quality.evidence.manage` makes the change. `mappingAt(mappings, at)` gives the mapping that was
   in force at a moment, so a past audit is read with the mapping of its time.

**Evidence library (QUAL-002)**

6. `checkEvidenceTag`: at least one statement; every statement exists in the framework version the
   tag names; the version is published (a retired version takes no new tags); the record type is a
   known evidence record type or one of the Phase 2 additions (`audit`, `compliment`, `policy`,
   `survey`); a record in a restricted silo (speak-up, employee relations casework, legal advice)
   is never tagged, as rule 2 of the evidence pack says; the tagger holds `quality.evidence.manage`.
7. `evidenceCoverage(tags, framework)`: for each statement, how many records evidence it, and the
   statements with none, listed (a gap is shown, never hidden).

**Audits (QUAL-004)**

8. `checkAuditTemplate`: at least one question; weights are positive whole numbers; every statement
   a question evidences exists in the template's framework version.
9. `scoreAudit`: the score is the weighted share of answerable questions, where `yes` counts in
   full, `partial` counts half and `no` counts nothing; `not_applicable` questions leave both sides;
   unanswered questions make the audit incomplete. The score is null (never 0 or 100) when nothing
   is answerable. The percentage is shown with the method in words.
10. `checkAuditCompletion`: every question answered; every `no` (and `partial`) on a question that
    needs an action has an action with a description, an owner and a due date on or after the audit
    date; the self-rating is given; the person holds `quality.audit.manage`.
11. The self-rating is a whole number in the CQC scale read from the rate table
    (`cqc.rating_scale.min`, `cqc.rating_scale.max`), with the CQC words: 1 inadequate, 2 requires
    improvement, 3 good, 4 outstanding (`SELF_RATING_WORDS`, keyed by the number).
12. A default action due date, when the auditor does not choose one, is
    `quality.audit.action_due_days` UK days after the audit (tenant default).
13. `nextAuditDue(lastCompletedOn, frequencyMonths)`: the schedule's own frequency (tenant data),
    calendar months, clamped to the month's last day; overdue on the day after.
14. Mock inspections are audits of kind `mock_inspection` whose questions are mapped to statements;
    `auditFindingsByStatement` groups `no` and `partial` answers by statement for the evidence library.
15. Nothing works out a rating from a score: the self-rating is a person's judgement, recorded with
    who gave it (no solely automated significant decisions, section 5.1).

**Indicators (QUAL-005)**

16. Every indicator is a definition with its method in words: numerator, denominator, multiplier
    and unit ("Falls per 1,000 occupied bed-days: falls recorded ÷ occupied bed-days × 1,000"). The
    multiplier for bed-day rates is `quality.indicator.bed_days_base` from the rate table.
17. `computeIndicator`: value is numerator ÷ denominator × multiplier, rounded to one decimal for
    display, exact underneath; a zero or missing denominator gives null.
18. `checkIndicatorTarget`: green and amber thresholds in the direction of the indicator (for
    `lower_is_better`, green ≤ amber); targets are the tenant's, never Harbour's.
19. `ragStatus`: `green` within the green threshold, `amber` within amber, `red` beyond, in the
    indicator's direction; boundaries count as the better band.
20. Coverage: a result counts only when its data covers the whole period and every location in the
    view (`coverage` 1); less gives `no_data` with the reason "Data incomplete for this period".
21. Status is always a word with an icon on screen (section 5.4); this slice gives the word.
22. **Missing data is never shown as good** (for HZ-129, slice 47): a null value, a zero or
    missing denominator, incomplete coverage, a missing target or an unknown indicator gives
    `no_data` with its reason, never `green`, and never a value of 0. A count indicator with a
    genuine zero and full coverage is green only when its target says zero is green.

**PIR (QUAL-006)**

23. `PIR_DATA_POINTS` lists the data points by CQC question area (Safe, Effective, Caring,
    Responsive, Well-led): headcount, vacancies, agency hours, training compliance, supervision,
    incidents, medication errors, complaints and digital records; each names the source slice that
    publishes it. The list is confirmed against CQC's current PIR questions (H-602).
24. `assemblePirDraft`: each data point with its value and as-of date and the number of records
    behind it; a data point with no value says "Not available in Harbour" with the reason, never
    0; nothing is submitted to CQC (the Registered Manager reviews and copies across).

**Policies (QUAL-008)**

25. Versions move `draft` to `published` to `superseded` or `retired` (`POLICY_WORKFLOW`); one
    published version per policy; publishing supersedes the last.
    `checkPolicyPublication`: a review date after the publication date and no later than
    `policy.review_interval_months.max` after it; at least one role must read it; the publisher holds
    `quality.policy.manage`; with `requireSecondReviewer`, the publisher is not the author.
26. Read-and-sign (`readAndSignStatus`): everyone holding a listed role on the publication date or
    later must sign; a signature on this version counts; after a `minor` change a signature on the
    previous published version still counts; after a `major` change it does not. People who left
    are not counted. Outstanding people are listed with the date they became due.
27. Reminders: a person outstanding for `policy.read_and_sign.reminder_days` UK days or more since
    their last reminder (or since publication) is due one (`readAndSignRemindersDue`).
28. `policyReviewStatus`: `current`, `due_soon` within `policy.review_due_soon_days` of the review
    date, `overdue` after it.

**Data security evidence (QUAL-012)**

29. `dsptDeadline(on, rates)`: the next DSPT submission deadline on or after a UK date, from
    `dspt.submission_deadline.month` and `.day` (the 30 June deadline), for the financial year it
    closes (the year that ends 31 March before it).
30. `dsptStatus`: `submitted` when a submission for that year exists, `due_soon` within
    `quality.renewal_reminder_days` of the deadline, `overdue` after it, `due` otherwise; a
    submission rated `standards_not_met` is submitted but flagged.
31. `certificateStatus`: Cyber Essentials (and Plus) certificates expire
    `cyber_essentials.certificate_valid_months` after issue unless the certificate gives its own
    expiry; the ICO registration renews `ico.registration.renewal_months` after it; `due_soon`
    within `quality.renewal_reminder_days`; `expired` after; `missing` when there is no record
    (never assumed current).

### 17.4 Rate rows added (docs/specs/rates.md)

`cqc.rating_scale.min` and `.max` (the CQC ratings scale, master prompt 11.2 "self-rating 1 to 4"),
`quality.indicator.bed_days_base` (master prompt 11.2 "per 1,000 bed-days"),
`quality.audit.action_due_days`, `policy.read_and_sign.reminder_days`,
`policy.review_due_soon_days`, `policy.review_interval_months.max`, `quality.renewal_reminder_days`
(tenant defaults, to verify), `cyber_essentials.certificate_valid_months` and
`ico.registration.renewal_months` (to verify against the scheme and the ICO).

### 17.5 Tests

Table-driven, in `packages/domain/src/quality/` beside each module, at 90% line coverage or more:
`quality-framework.test.ts` (rules 1 to 7), `quality-audits.test.ts` (8 to 15),
`quality-indicators.test.ts` (16 to 22, the last as `rule 22 missing data is never shown as
good`), `quality-pir.test.ts` (23, 24), `policies.test.ts` (25 to 28), `quality-data-security.test.ts`
(29 to 31) and `quality-rates.test.ts` (the rows resolve from rates.md; a missing row fails loudly).
