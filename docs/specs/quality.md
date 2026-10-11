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
| `evidence_pack` | mutable, versioned | pack id, recipient (name, organisation, work email), purpose, date range, locations, statement filter, people in scope, staff names (`role_only` or `include`), composed by and at, state (`EVIDENCE_PACK_WORKFLOW`), released by and at, revoked by, at and reason, watermark text | `evidence_pack` |
| `evidence_pack_item` | append-only | pack, record type, record id, record version, statements, field outcomes (`included`, `redacted`, `withheld`) with reasons; excluded items with their reason (internal manifest only) | `evidence_pack` |
| `evidence_pack_link` | mutable | pack, recipient email, token hash (never the token), expires at, revoked at, failed code attempts, last opened at | `evidence_pack` |
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
| `quality.evidence_pack.release` (step-up) | Release a pack by its link, not the person who composed it | As above |
| `quality.evidence.read` | Open a pack released to you (the inspector role, when the inspector has a Harbour account) | Inspector |
| `quality.statement_of_purpose.write` | Draft a revision | Owner, Registered Manager, deputy, quality lead |
| `quality.statement_of_purpose.approve` | Approve a revision, not one you wrote or edited | Owner (Nominated Individual), Registered Manager |
| `safety.notification.submit` (step-up) | Record that the revision was sent to CQC | Owner, Registered Manager |

`quality.evidence.manage` keeps tagging records as evidence (QUAL-002). Revoking a link is always
open to the pack's composers, because withdrawing access can only make things safer.

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
   printed in words (`EVIDENCE_REDACTION_TEXT`):
   - organisational detail is kept;
   - care content is kept only when it is about a person in scope; about anyone else, or about
     nobody known, it is withheld;
   - direct identifiers (NHS number, date of birth, address, telephone) are withheld as not needed
     to assess care, and available on request;
   - third parties (relatives, visitors, other residents, witnesses who are not staff) become their
     role in brackets, for example "[relative]";
   - staff names become their role unless the request needs names (staffing evidence);
   - free text may name anyone, so it is withheld until a person has redacted it by hand; the
     redacted copy is shown with who did it.
   Titles are generic labels Harbour builds, never free text.
4. **Watermark** (`evidencePackWatermark`), on every page: "Prepared for [recipient],
   [organisation]. Purpose: [purpose]. Made [dd/mm/yyyy hh:mm]. Pack [id]. Do not share further."
   A long purpose is shortened at a word boundary to `MAX_WATERMARK_PURPOSE_LENGTH` characters.
5. **Release** (`checkEvidencePackRelease`). Only a draft with at least one item; by a holder of
   `quality.evidence_pack.release` with a sign-in within the step-up window; never by the person who
   composed it (a second pair of eyes on the redaction before anything leaves the provider).
6. **The link** (ADR-0050). One link per recipient: an opaque random token, stored only as a hash,
   that opens only after the recipient enters a one-time code sent to the bound email address.
   Expiry defaults to `evidence_pack.link_expiry_days.default` days and may be set up to
   `evidence_pack.link_expiry_days.max` days (tenant policy defaults, marked to verify, not
   statutory). `evidencePackLinkAccess` refuses a draft or discarded pack, a revoked link, an expired
   link (at the expiry instant), a link locked after `EVIDENCE_LINK_MAX_CODE_ATTEMPTS` wrong codes,
   a visitor who has not entered the code, and anyone whose verified email is not the recipient's
   (case and spaces ignored). Every open is audited.
7. **After the link ends.** When the link expires or is revoked, the rendered bundle is deleted
   (`evidencePackBundleDeletable`); the manifest (items with record versions, redactions, recipient,
   purpose, link events) stays as proof of the disclosure under the `evidence_pack` class and can
   rebuild the pack from the record versions.

### Statement of purpose (QUAL-009)

8. **Checklist** (`checkStatementOfPurpose`). The CQC (Registration) Regulations 2009 Schedule 3,
   in its words, as five items: aims and objectives (para 1); the kinds of services and the range
   of needs they meet (para 2); names and contact details of the provider and any registered
   manager (full name, business address, business telephone, email where available) and, for the
   registered person, the address for notices and, if they agree to email service, the email
   address (para 3, substituted by S.I. 2012/921); the legal status of the provider (para 4); the
   locations (para 5). Read on legislation.gov.uk on 11 October 2026. A statement with no
   registered manager listed is complete under Schedule 3 ("any registered manager") but carries a
   warning.
9. **Versions and change summary** (`statementOfPurposeChanges`). Every approved version is fixed;
   a change starts a new draft (`startStatementOfPurposeRevision`). The summary works section by
   section in plain English: "Location added: Harbour Lodge", "Registered manager removed: ...",
   "Provider business telephone number changed", "Aims and objectives reworded". The first version
   loaded into Harbour is the `baseline`: the statement CQC already holds.
10. **Registration prompts** (`statementOfPurposeRegistrationPrompts`, Harbour's reading, to
    confirm with CQC, H-97). Adding or removing a location usually needs an application to vary the
    conditions of registration (Health and Social Care Act 2008 s.19); a new registered manager
    applies to be registered as a manager (s.14); a new legal entity must itself be registered
    (s.10). Harbour prompts; it does not decide.
11. **Approval** (`checkStatementOfPurposeApproval`). Only a draft, complete against Schedule 3, that
    differs from the current version; by a holder of `quality.statement_of_purpose.approve` (the
    registered provider or a registered manager, not a deputy); never by its author or anyone who
    edited it. Approval supersedes the previous version.
12. **Notification to CQC** (`statementOfPurposeNotificationState`,
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
  copy of free text), `POST .../release` (step-up; returns the link once, never stored),
  `POST .../revoke`, `POST .../discard`.
- Public link routes outside the tenant API: `POST /p/evidence/{token}/code` (sends the one-time
  code to the bound address, rate-limited), `POST /p/evidence/{token}/verify`,
  `GET /p/evidence/{token}/bundle` (streams the watermarked PDF; never a presigned bucket URL).
- `GET`, `POST /v1/statement-of-purpose/versions`, `PUT .../{id}` (drafts only), `POST
  .../{id}/approve`, `POST .../{id}/notification` (step-up), `GET .../{id}/changes`.
- Audit events: `quality.evidence_pack.composed`, `.released`, `.revoked`, `.discarded`,
  `.code_sent`, `.code_failed`, `.opened`, `.bundle_deleted`; `quality.statement_of_purpose.drafted`,
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
whistleblowers, other residents), so it sits in the log beside HZ-022. The statement of purpose
touches no hazard: it holds no care data. Medical-device boundary: unchanged; the pack copies
records and applies the provider's redaction rules
([medical-device-boundary.md](../compliance/medical-device-boundary.md)).

## 8. Data protection and data standards

The evidence pack is a disclosure of special category data to a regulator or commissioner. Lawful
basis: legal obligation where CQC requires the information (Health and Social Care Act 2008 s.64),
otherwise the basis of the provider's regulated activity; special category condition Article 9(2)(h)
with DPA 2018 Schedule 1 paragraph 2(2)(f) (management of social care services), to be confirmed by
the DPO (H-96). Minimisation is the default (rules 2 and 3); the recipient, purpose and every open
are recorded; the bundle is deleted at link end. Retention: `evidence_pack` for the manifest and
link; `organisation_document` for statement of purpose versions ([retention.md](retention.md)).
Statement of purpose versions hold the provider's and registered managers' business contact details
(records of processing B6). Field mapping:
[data-standards.md](data-standards.md#packs-and-governance-phase-1-slice-11).

## 9. Acceptance criteria and tests

- Domain (built, slice 11): `packages/domain/src/quality/evidence-pack.test.ts` (request checks;
  field rules; item exclusions with UK dates; composition, coverage and versions; watermark;
  release with separation of duties, step-up and expiry limits; link access; bundle deletion;
  permissions) and `packages/domain/src/quality/statement-of-purpose.test.ts` (rate row verified;
  Wales fails loudly; Schedule 3 checklist; change summary; registration prompts; approval; the
  regulation 12(3) clock; recording the notification; permissions);
  `packages/domain/src/shared/email.test.ts`.
- Database: RLS and HZ-011 isolation for the new tables; append-only `evidence_pack_item`; token
  hashes only; fixed approved statement versions.
- API: `hazard HZ-050 the rendered pack contains no third party's name and no person outside its
  scope` (snapshot of a rendered fixture pack); the link refuses a forwarded recipient, an expired
  link and a revoked link; the bundle is deleted at link end; step-up on release and notification;
  the phase gate's "inspector pack export renders" PDF test.
- Web: Playwright journeys (compose, review redactions, release, revoke; statement draft, approve,
  record the notification) with axe.

## 10. Open questions

- The DPO confirms the redaction rules, the lawful basis for disclosure, the `evidence_pack`
  retention period and the link expiry defaults (H-96).
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
| `evidence-pack.ts` | `EVIDENCE_FIELD_KINDS`, `checkEvidencePackRequest`, `evidenceItemExclusion`, `minimiseEvidenceField`, `EVIDENCE_REDACTION_TEXT`, `composeEvidencePack`, `evidencePackWatermark`, `EVIDENCE_PACK_WORKFLOW`, `checkEvidencePackRelease`, `defaultEvidencePackLinkExpiry`, `evidencePackLinkAccess`, `EVIDENCE_LINK_MAX_CODE_ATTEMPTS`, `evidencePackBundleDeletable` | Rules 1 to 7 |
| `statement-of-purpose.ts` | `STATEMENT_OF_PURPOSE_ITEMS`, `LEGAL_STATUSES`, `checkStatementOfPurpose`, `statementOfPurposeChanges`, `statementOfPurposeRegistrationPrompts`, `STATEMENT_OF_PURPOSE_WORKFLOW`, `checkStatementOfPurposeApproval`, `statementOfPurposeNotificationState`, `checkStatementOfPurposeNotificationRecord`, `startStatementOfPurposeRevision` | Rules 8 to 12 |
| `rates.ts` | `EVIDENCE_PACK_RATE_KEYS`, `resolveEvidencePackPolicy`, `STATEMENT_OF_PURPOSE_RATE_KEYS`, `resolveStatementOfPurposeRates` | The link policy and the regulation 12(3) period |
| `../shared/email.ts` | `isPlausibleEmail`, `normaliseEmail` | Recipient addresses, checked with a loop (no backtracking) |
