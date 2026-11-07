# Carer's and parental leave: no decline on the screen, postpone to new dates (H-970)

Branch `fix/workforce-leave-postpone`.

## What changed

- The absences screen offered "Decline" for every request, but the domain, the API and the
  database (`absence_statutory`, migration 0107) refuse to decline statutory leave, so a manager's
  decline of carer's or parental leave failed. The screen now offers approve or postpone for
  carer's and unpaid parental leave, approve only for the other statutory kinds (each saying the
  law does not let them refuse it), and approve or decline for the rest.
- Postponing now takes new dates. The approver gives the new first and last days and a reason;
  the request becomes `postponed` and the new dates become approved leave pointing back at it
  (`absence.postponed_from_id`, migration 0153), with cover needs raised as for any approved leave.
  Only the approver who postponed it may write that leave, for the same member, home and kind, once.
- The domain (`checkPostponement`, `postponementLimits`) refuses new dates of a different length,
  dates not after the first day asked for and today, a first day later than the limit, a decision
  after the last day for notice, and parental leave without the approver's confirmation about the
  child's birth or placement and 18th birthday. Limits from four new rate-table keys (England,
  Wales and Scotland), verified on legislation.gov.uk and gov.uk on 07/11/2026:
  `carers_leave.postpone_max_months` 1 and `carers_leave.postpone_notice_days` 7 (Carer's Leave
  Regulations 2024 reg 8, notice also before the leave was due to start);
  `parental_leave.postpone_max_months` 6 and `parental_leave.postpone_notice_days` 7 (Maternity
  and Parental Leave etc. Regulations 1999 Sch 2 para 6).
- The API shows each approver the latest new first day and the last day for notice
  (`AbsenceItem.postponement`), and the request's new dates (`postponedTo`). Audit:
  `scheduling.absence.postponed` with the new leave's id, and `scheduling.absence.approved` for the
  new leave with the request's id; never the reason.
- A postponed absence shows as "Postponed" with an icon, and says the dates the leave is given
  instead.
- Spec: scheduling.md section 17 rule 1a. Data standards, records of processing and the export
  catalogue name the new column.

## What is next

- Northern Ireland rows come with its nation pack; until then a postponement there is refused
  (`absence_postpone_no_rate`) and the screen offers approve only.
- The e2e journey in `apps/web/e2e/pay-time.spec.ts` covers the decline of annual leave; a
  postponement journey can follow.

## Review round: accessibility and security

- The reason's label says it is needed to decline or postpone; the postponement's errors are listed
  in the order of the fields (new dates, confirmation, reason); a statutory request with one
  choice has it chosen already; "unduly disrupted" became "serious problems for the service"; a
  postponed request says "New dates: ... to ...", so "Postponed" is not said twice.
- New journeys in `apps/web/e2e/pay-time.spec.ts`: parental leave postponed (no decline, the
  errors of an empty postponement, then new dates and the confirmation) and maternity leave
  approved as its only choice.
- API test: a postponement at a stale version is refused with 409 and gives no leave on new dates.
  Migration 0153 says the date limits are the domain's and the API's, and that the postponing
  approver is accountable on both rows.
