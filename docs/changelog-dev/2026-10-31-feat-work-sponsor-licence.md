# Sponsor licence, staff data protection and LDSS

Branch `feat/work-sponsor-licence` (Phase 2 slice 35; WORK-003, WORK-007, WORK-011).

## What changed

- Migration 0097: `sponsored_worker`, `sponsor_absence`, `sponsor_report`,
  `staff_privacy_acknowledgement` and `staff_image_consent` (both append-only), `ldss_claim`, and
  `tenant.staff_privacy_notice_version`. Forced RLS on every table: sponsor records are HR only
  (`workforce.immigration.read`, `workforce.sponsor.manage`) and never one's own, their earlier
  versions hidden the same way; acknowledgements and image consent are made only by the member;
  LDSS claims need `workforce.ldss.manage`. No delete for anyone.
- Domain rules with table-driven tests (`packages/domain/src/workforce/sponsorship.ts`):
  unauthorised absence past the limit in consecutive working days, the visa warning window,
  Appendix D gaps, LDSS transitions, acknowledgement of the notice in force, the latest image
  decision. Two rate rows, both to verify: `sponsor.unauthorised_absence_working_days` and
  `sponsor.visa_expiry_warning_days`.
- Three permissions: `workforce.immigration.read` and `workforce.sponsor.manage` (sensitive, HR and
  the owner, not the Registered Manager) and `workforce.ldss.manage`.
- API: sponsored workers (salary check, visa state, Appendix D gaps, absence flag, report clocks),
  absences, reports, marking a report reported; the staff privacy notice version, the member's own
  acknowledgement and image consent, and HR's read of them; LDSS claims. Audited with ids and
  codes only. OpenAPI and the client regenerated.
- Staff DSARs (slice 15) collect the new member-linked tables; the export catalogue describes
  every column.
- Docs: workforce.md section 12, records of processing (B3 extended, new B3a for consent-based
  image use), data standards, retention mapping, feature register, human actions H-900 to H-909.

## Found, not fixed here

- No reminders yet for a visa due soon or a report due (slice 17); absences are entered by HR, not
  drawn from rota or leave; the family feed does not yet check staff image consent (slice 56,
  H-905). Listed in workforce.md section 12.6.
