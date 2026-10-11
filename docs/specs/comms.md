# Communication and portals (`comms`) - specification

Master prompt section 15.1. Phase 1 builds letter and email templates with approval (slice 11)
and, in slice 12, the family feed and the communications integrations; handover acknowledgement
(COMMS-006) is specified with the handover in [care.md](care.md) rule 8. The person's portal,
professional access, messaging and the public site arrive in Phase 4. Status per feature:
[feature register](feature-register.md).

## 1. Purpose and register rows

Letters and emails that matter (an admission letter, a fee review, an incident follow-up, a duty of
candour letter) say the right things about the right person, in words someone with authority has
approved, and never put health details where they do not belong.

| Phase 1 rows | Later rows |
| --- | --- |
| COMMS-007 letter and email templates with approval (slice 11); COMMS-001 family feed (slice 12); COMMS-006 handover acknowledgement (care.md) | COMMS-002 to COMMS-005, COMMS-008 (Phase 4) |

PLAT-009 (document store) names "merge-field templates": this spec is where they are defined; a
rendered letter is stored as a document about the person.

## 2. Schema (for the schema and API step)

Forced RLS on every table (ADR-0002). Templates are tenant configuration with no personal data;
rendered letters follow the person they are about.

| Table | Kind | Key columns | Retention class |
| --- | --- | --- | --- |
| `letter_template` | mutable | name, kind (`TEMPLATE_KINDS`), channel (`letter`, `email`), current approved version | `organisation_document` |
| `letter_template_version` | mutable while draft, then fixed | template, version, state (`TEMPLATE_WORKFLOW`), name, subject (email), body, author, contributors, approved by and at, retirement reason | `organisation_document` |
| `letter` | append-only | template version, person, recipient (the person or one of their contacts), channel, the personal-data fields used, whether it holds special category data, results to follow (candour), incident and its grade (incident and candour letters), rendered document (PDF for letters; for email, the delivery and the document), sent by and at, delivery reference | `letterRetentionClass`: `serious_incident` for an incident or candour letter about an incident graded serious, otherwise `care_record` |

Field mapping: [data-standards.md](data-standards.md#packs-and-governance-phase-1-slice-11);
purposes: [records of processing](../compliance/records-of-processing.md).

## 3. Permissions

From `packages/domain/src/platform/permissions.ts` (matrix: [permissions.md](permissions.md)).

| Permission | Allows | Held by (built-in roles) |
| --- | --- | --- |
| `comms.template.write` | Write and change draft templates | Owner, Registered Manager, deputy, quality lead, administrator |
| `comms.template.approve` | Approve a version (not one you wrote or edited), supersede or retire one | Owner, Registered Manager, deputy, quality lead |
| `comms.letter.manage` | Make and send letters and emails from approved templates | Owner, Registered Manager, deputy, administrator |
| `people.person.read` or `people.demographics.read` | Required as well, in scope, for every person-bound field merged | As the person's scope |

Duty of candour and incident letters also need `safety.incident.manage` for the incident (the API
checks it when it fills the `incident.*` and `candour.*` fields).

## 4. Rules that are easy to get wrong

Every rule has a table-driven test in `packages/domain/src/comms/` (named with HZ-051 where it
controls that hazard). No figure is hard-coded: `fee.notice_days` is filled from
`cma.fee_review_notice_days` in the rate table by the caller.

1. **Typed merge fields** (`MERGE_FIELDS`). Each field has a type (`text`, `date`, `datetime`,
   `money` in whole pence, `number`), a data class (`none`, `personal`, `special_category`) and
   whether it belongs to one person receiving care (`personBound`: the person's own details, a
   contact's details, their fees, incidents and candour details). Incident and candour details are
   special category data. Three flags say where a field may go: `multiLine` (addresses, the
   incident summary and the candour texts can run over several lines), `notInEmail` (the NHS
   number and date of birth identify the person outright) and `allowsResultsToFollow` (only
   `candour.results`).
2. **Syntax** (`parseTemplateText`). Fields are written `{{field.name}}` (lower case, digits,
   underscores and dots). An unclosed field, a stray `}}`, a malformed name or a field not in the
   catalogue is refused with the field named. The parser is a loop, not a regular expression, so
   it cannot backtrack on long input (the CodeQL ReDoS gate); bodies are limited to
   `MAX_TEMPLATE_BODY_LENGTH` characters.
3. **Where personal data may go** (`checkTemplateDefinition`; ADR-0051).
   - An email needs a subject of at most `MAX_TEMPLATE_SUBJECT_LENGTH` characters that uses only
     fields with no personal data (subjects show in inbox previews and notifications) and no
     `multiLine` field (a line break in a subject is a header break).
   - The subject may not hold a character that can break or disguise an email header
     (`hasUnsafeHeaderCharacter`): C0 and C1 control characters (CR and LF among them), DEL,
     U+2028 and U+2029, and the bidirectional controls (U+061C, U+200E, U+200F, U+202A to U+202E,
     U+2066 to U+2069). The check runs on the template and again on the rendered subject, after
     the values are merged (rule 7).
   - Incident follow-up and duty of candour letters are letters only (`LETTER_ONLY_KINDS`): they
     cannot be email templates at all.
   - A special category field never goes in an email body, and nor does a `notInEmail` field (NHS
     number, date of birth); such content goes as a letter (by post, by hand or through the
     portal). Other personal fields may go in an email body and are flagged.
4. **Required content and the relevant person.** A duty of candour letter must contain the
   written notification's contents from regulation 20(4) of the 2014 Regulations: the account of
   the facts (`candour.account`, 20(4)(a)), the enquiries to be made (`candour.enquiries`, (b)), the
   results of further enquiries (`candour.results`, (c)) and an apology (`candour.apology`, (d)).
   - **Results to follow.** The first notification usually comes before the enquiries end, so
     `candour.results` alone may take a `results_to_follow` marker with an optional expected date.
     It prints standard words (`resultsToFollowText`): "The results of our further enquiries are
     not available yet. We will write to you with them by dd/mm/yyyy." The rendered letter carries
     `resultsToFollow`, and the API step keeps the candour record's "enquiries and results shared"
     step ([safety.md](safety.md) schema) open until a letter without the marker is sent. A blank
     `candour.results` is still refused.
   - **Who receives it** (`checkCandourRelevantPerson`). Regulation 20(7): the relevant person is
     the service user or, on their death, where they are under 16 and not competent, or where they
     are 16 or over and lack capacity in relation to the matter, a person lawfully acting on their
     behalf. A representative recorded without one of those bases is refused
     (`representative_basis_not_met`), and so is the service user when one applies
     (`representative_required`). A candour letter renders only for the relevant person on the
     candour record: the service user, or that representative as one of the person's contacts
     (`candour_recipient_required`, `candour_wrong_recipient`). Harbour's reading, to confirm with
     the CSO and a solicitor (H-103).
5. **Approval and separation of duties** (`checkTemplateApproval`, `TEMPLATE_WORKFLOW`). Only a
   draft with no problems, that differs from the approved version, approved by a holder of
   `comms.template.approve` who neither wrote nor edited it (`checkTemplateEdit` adds every editor
   to the contributors).
6. **Versions** (`startTemplateRevision`, `currentApprovedTemplate`). An approved version never
   changes; any change is a new draft that needs approval again, and until then the approved version
   stays in use. Approving the new version supersedes the old; a template can be retired with a
   reason.
7. **Rendering** (`renderTemplate`):
   - only an approved version renders (HZ-051);
   - every field used needs a value of its type; a missing or blank value refuses the letter rather
     than leaving a gap (HZ-051);
   - every person-bound value must belong to the person the letter is about, and a recipient must
     be that person's contact; otherwise the letter is refused (HZ-051);
   - values are formatted in British style (dd/mm/yyyy, 24-hour UK time, pounds and pence);
   - for HTML email every value and every piece of the template's own text is escaped
     (`escapeHtml`), paragraphs become `<p>` and line breaks `<br>`; nothing in a template or value
     can inject markup;
   - the rendered email subject is checked again for header-breaking characters (a value could
     carry one) and must pass the outbound title check (`outboundTitleProblem`);
   - a letter's text goes to the PDF renderer (Typst) as data, never as markup: values and template
     text are passed as strings the template prints, so nothing typed can run as Typst code;
   - a duty of candour letter needs the candour record's relevant person and the recipient, and
     they must match (rule 4);
   - the result lists the personal-data fields used and whether special category data is present,
     for the "check before sending" screen and the audit trail.
8. **Before sending** (the API step). The sender sees the person's name and photo (HZ-001), the
   recipient, and the flagged personal-data fields, and confirms; the letter, the template version
   and the fields used are stored and audited.
9. **Plain English** (`templateStyleWarnings`, optional and advisory). Sentences over
   `MAX_SENTENCE_WORDS` words, capitals used for emphasis (acronyms such as CQC and NHS excepted) and
   title-case template names are pointed out; nothing is blocked.

## 5. API, audit events and outbox events

For the schema and API step (none of this is built in slice 11):

- `GET` and `POST /v1/letter-templates`, `GET /v1/letter-templates/{id}/versions`,
  `POST .../versions` (a new draft from the approved one), `PUT .../versions/{versionId}` (drafts
  only), `POST .../versions/{versionId}/approve`, `.../retire`, `GET /v1/merge-fields`.
- `POST /v1/people/{id}/letters/preview` (renders, returns the flags; nothing stored),
  `POST /v1/people/{id}/letters` (renders, stores the document, sends email through the
  `comms.email` port or marks a letter printed), `GET /v1/people/{id}/letters`.
- Audit events: `comms.template.drafted`, `.approved`, `.retired`; `comms.letter.previewed`,
  `comms.letter.sent` (template version, person, recipient, fields used, never the content).
- Outbox events: `comms.letter.sent` (safety links a candour letter to the candour record's written
  notification step).

## 6. Offline behaviour

None: templates and letters are online-only office tasks.

## 7. Clinical safety

HZ-051 (a letter or email carries another person's details, or wrong or unapproved content) is new
with this spec. Its controls include the person check on every person-bound value, approval by a
second person, letter-only kinds, identifiers kept out of email, header-safe subjects, the candour
recipient check and the "results to follow" words that keep the follow-up due (rules 3, 4 and 7). HZ-001 applies to the "check before sending" screen. Duty of candour letters relate
to HZ-013 through the candour clock in [safety.md](safety.md). Medical-device boundary: unchanged;
templates merge recorded values and add no clinical content
([medical-device-boundary.md](../compliance/medical-device-boundary.md)).

## 8. Data protection and data standards

Templates hold no personal data. Rendered letters hold the person's and their contact's data and,
for incident and candour letters, special category data; they are disclosures to the recipient
under the purpose of the record they relate to (B1 or B2; candour letters B7). Email is used only
for content without special category data or identifiers such as the NHS number and date of birth
(ADR-0051, for the DPO to accept, H-99). Recipient addresses are printable ASCII only, lower-cased
without Unicode case-folding, so two different addresses cannot be treated as one. Retention:
templates `organisation_document`; letters `care_record`, or `serious_incident` for an incident or
candour letter about an incident graded serious (`letterRetentionClass`, [retention.md](retention.md)).
Field mapping: [data-standards.md](data-standards.md#packs-and-governance-phase-1-slice-11).

## 9. Acceptance criteria and tests

- Domain (built, slice 11): `packages/domain/src/comms/templates.test.ts` (catalogue; parsing and
  hostile input; definition checks; header-unsafe characters and multi-line fields in subjects;
  letter-only kinds; identifiers kept out of email; candour contents, results to follow and the
  relevant person; approval and separation of duties; edits and versions; rendering, escaping and
  formatting; HZ-051 wrong person, missing values and unapproved versions; letter retention;
  permissions), `packages/domain/src/comms/template-style.test.ts` and
  `packages/domain/src/shared/email.test.ts`.
- Database: RLS for the new tables; fixed approved versions; append-only `letter`.
- API: `hazard HZ-051 a letter cannot be made with another person's details`; email delivery
  through the guarded `comms.email` port, which refuses a header-unsafe subject again; a Typst
  render test with a value full of Typst syntax that prints as text; audit without content.
- Web: Playwright journeys (author, approve by another user, preview with flags, send) with axe.

## 10. Open questions

- The DPO accepts ADR-0051 (no special category data or identifiers in email bodies) and the data
  classes of the merge fields (H-99).
- The CSO and a solicitor confirm the "results to follow" wording and Harbour's reading of the
  relevant person under regulation 20(7) (H-103).
- Starter templates (admission, fee review, incident follow-up, duty of candour) need wording
  reviewed by the provider's adviser; Harbour ships the fields, not legal wording.
- Welsh-language versions of a template (Phase 7) will be a second body per version.

## 11. As built (slice 11, domain rules)

`packages/domain/src/comms/`, exported from `@harbour/domain`; pure functions with no I/O. No
schema, API or web changes in this slice.

| Module | Main exports | For |
| --- | --- | --- |
| `templates.ts` | `MERGE_FIELDS`, `TEMPLATE_KINDS`, `LETTER_ONLY_KINDS`, `TEMPLATE_REQUIRED_FIELDS`, `parseTemplateText`, `hasUnsafeHeaderCharacter`, `checkTemplateDefinition`, `TEMPLATE_WORKFLOW`, `checkTemplateApproval`, `checkTemplateEdit`, `startTemplateRevision`, `currentApprovedTemplate`, `CANDOUR_REPRESENTATIVE_BASES`, `checkCandourRelevantPerson`, `resultsToFollowText`, `renderTemplate`, `formatMergeValue`, `escapeHtml`, `letterRetentionClass` | Rules 1 to 8 |
| `template-style.ts` | `templateStyleWarnings`, `MAX_SENTENCE_WORDS`, `TEMPLATE_ACRONYMS` | Rule 9 |
