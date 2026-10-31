# Recommended answers applied to casework, references and leavers (H-802 to H-806, H-873 to H-879)

Branch `feat/web-workforce-people`. Owner instruction of 31/10/2026: every open human question takes
its recommended answer now, reviewed at the testing phase
(`docs/plans/recommended-answers.md` on `docs/production-google-cloud`). Each row in
[human-actions.md](../plans/human-actions.md) is marked "recommended answer applied 31/10/2026
(review at testing)".

## What changed

- **H-802, DBS referral decisions:** the DBS decision is also due after a redeployment, or an action short of dismissal that removes the member from regulated activity.
  - The flag is decided with the outcome and only with that outcome.
  - Domain (`referralDecisionsDue`, `checkCaseMove`), the database's CHECK and guard, the API's move route and the decide form.
- **H-804, support appointing a case manager:** support tickets let Thapsus support appoint the case manager a ticket names when every case manager has left.
  - A holder of `platform.user.manage` raises the ticket; the data protection lead approves it with step-up; support appoints once through `app.operator_appoint_case_manager`, without reading the case.
  - The appointment is audited to the organisation, and its owners are told.
  - Tenant routes `/v1/workforce/casework-support-tickets`; the operator route `/operator/tenants/{tenantId}/casework-support-tickets/{ticketId}/appoint`.
- **H-805, casework export and subject access:** a case manager exports their case as JSON with a fresh step-up (`GET /v1/workforce/cases/{id}/export`, a download on the case page, audited).
  - For a staff subject access request, `raiseCaseworkDsarTasks` gives each case manager a task to collect the case, through the definer `app.casework_for_subject_access` (ids only, never content).
- **H-806, retention class:** `employee_case.retention_class`, set by the database as the case closes.
  - `casework_no_sanction` (6 years after closure, a new row in retention.md) applies to a grievance, no case to answer and a withdrawn case.
  - A case ending in a sanction, dismissal or referral, or concerning safeguarding, stays with the staff file.
- **H-873, when access ends:** at the later of the end of the leaving day and the end of a rostered shift that starts on it (`accessEndsAt`).
  - The rota answers through `RotaPort`; `NO_ROTA` answers "no shift" until scheduling merges.
- **H-874, files with no date of birth:** a leaver with no date of birth gives HR a task to record it.
  - A file with no keep-until date comes up for a person's decision after the after-leaving period, once.
- **H-876, references:** a reference request is a conduct reference by default.
  - "Requester not verified" replaces "no consent to share", which stays valid only on requests declined with it before.
- **H-879, leavers' sessions:** the leaver sweep signs the leaver out of every device, unless they still work for another organisation.
  - Unsent entries stay on the device for hand-over.
  - Audited by ids and counts.
- **Migration 0116:** the two case columns and the ticket table, with row-level security, guards and history. Also the two definers, with their ACLs listed in the definer test, and the decline reason CHECK.
- **Docs:** workforce.md rules 17, 22 and 23 and the known gaps; retention.md; records of processing; data standards; the export catalogue.

## Tests

- **Domain:**
  - `casework.test.ts`: H-802 rows, `caseRetentionClass` table, the removal flag on the move.
  - `induction.test.ts`: access ending across BST and GMT, with and without a night shift; the file review; references.
- **Database:** `packages/db/test/recommended-answers.test.ts` (18):
  - the flag;
  - the retention class set only by the database;
  - tickets, raised, approved and used once, never by the application role or a member;
  - the operator appointment and its refusals;
  - the DSAR definer and who may call it;
  - the decline reason.
  - Definer ACLs and RLS coverage are re-run.
- **API:**
  - `casework.test.ts`: the flag refused with a dismissal; the retention class; the export by the case manager only; DSAR tasks to the case manager; the operator appointment end to end, with an audit to the organisation.
  - `induction.test.ts`: the shift port holding access; sessions kept for a member of another organisation; the date-of-birth and review tasks; references.
  - `route-gates.test.ts` updated.

## Known gaps

- Screens to raise and approve support tickets (the routes exist).
- The rota adapter for `RotaPort`.
- Wiring the DSAR workbench to `raiseCaseworkDsarTasks` once main is merged.
