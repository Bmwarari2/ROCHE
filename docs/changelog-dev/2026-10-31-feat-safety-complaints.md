# Complaints and compliments (SAFE-011, Phase 2 slice 18)

Branch `feat/safety-complaints`, stacked on `feat/safety-domain-phase-2` (#137).

## What changed

- Database, migration 0080 (one self-contained file):
  - `complaint` holds the complainant, how and when it arrived, when they knew of the matter, the
    summary, the workflow state, pauses, the acknowledgement, the response, an appeal and its
    response, and why it closed.
  - `compliment` holds the sender, what it says, the staff it praises, the quality statements it is
    evidence for, and a kept copy.
  - Both have forced RLS. Records are seen at the homes in scope, and read, recorded and changed only
    by a holder of `safety.complaint.manage` where the record is, in the recorder's own name.
  - Identity, home, receipt time and recorder never change. The application has no DELETE, and only
    the retention schedule soft-deletes. Versions are captured.
  - Both tables are in the export catalogue (retention class `complaint`). A complaint or
    compliment about a sample person stops sample removal until the removal list takes them.
- Domain: `COMPLAINT_WORKFLOW` keeps its deadline on the record (received: acknowledgement target;
  acknowledged and investigating: response target; an appeal has none), through
  `complaintStateDeadline`. It joins `LISTED_WORKFLOWS`, so complaints show on the approvals list.
- API: `/v1/complaints` (record, list, read, step, pauses) and `/v1/compliments` (record, list, tag
  as evidence).
  - A response is refused in words without the Ombudsman signposted and a kept copy.
  - Clocks use the tenant's working-day targets with the nation's bank holidays, and in England the
    Local Government and Social Care Ombudsman's time limit.
  - Each step writes the new deadline onto the workflow.
  - Audit and outbox events carry ids only. OpenAPI and the client are regenerated.
- Approvals page: the words and state chips for the complaint workflow.
- Docs: `safety.md` (API), `data-standards.md`, `records-of-processing.md` (a new category and the
  lawful-basis note), `retention.md` (compliments until slice 14), the feature register (SAFE-011
  partial), and H-700.
- Merged `origin/main` for the workflow deadline support from #130.

## What is next

- The web screens are slice 62.
- The evidence library (slice 14) links compliments by id; their statement identifiers are not
  checked against the framework until then.
- Sample data removal should take complaints and compliments (the shared removal list in migration
  0069), in the next migration that redefines it.
- The Ombudsman for Wales and other nations comes with their nation packs. For now the response
  wording says nothing about them.
- Migration number: 0080 is the plan's number for this slice. The journal keeps `idx` equal to it,
  so numbers 0071 to 0079 stay free for their slices. It must merge after any of those that land
  first.

## Human actions logged

- H-700: whether complaints and compliments need a processing purpose of their own, and the
  privacy notice wording for complainants.

## Tests

- `packages/db/test/complaints.test.ts` (10): own home and own name, another home or name refused,
  hidden from a member without the permission, never across organisations, identity kept, versions
  captured, never deleted. The full database suite passes (688).
- `packages/domain/src/safety/complaints.test.ts` (new table: the deadline of each state). Workflow,
  registry and platform suites pass.
- `apps/api/test/complaints.test.ts` (10): clocks and the Ombudsman, acknowledge to investigate with
  the workflow deadline, a response refused without signposting then accepted, appeal and close,
  pauses moving the target, the approvals list, refusals by permission and home, future dates,
  another organisation, and audit and events with ids only. `route-gates`, `workflows` and
  `incidents` pass (62).
- `apps/web/src/lib/approvals.test.ts` (43), with the complaint workflow's words and states.

## Security review fixes (#152)

- M1: `safety.complaint.manage` is now a care-record permission, so the complainant's details and
  any linked resident need MFA, as incidents and safeguarding do.
- M2: complaints and compliments no longer copy personal data into `record_version`, which every
  member reads. `app.capture_version_redacted` (migration 0080) keeps only the named non-personal
  columns: ids, home, relationship, channel, dates, state, recorder and version. Every other column
  that held a value reads `[redacted]`. A database test proves that a member without the permission
  reads none of what a complaint or compliment said from the history.
- L3: the API checks that a linked person or document is one the caller can see in their scope
  before it is stored, because the composite foreign keys skip row-level security. An unknown id
  is refused with 422, never a 500. API test: a resident at another home, an unknown person and an
  unknown document are each refused.
