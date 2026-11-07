# User guides: safety, quality and platform, second pass (Phase 2 slice 83)

Branch `docs/guides-safety-quality-platform-2`, from `main` at daa038a7. The first pass
(`2026-10-31-docs-guides-safety-quality-platform.md`) was written before several screens merged.

## What changed

- **15 new guides.** Outbreaks: declare, keep the line list, fill in the report, close
  (SAFE-013). Deaths: keep the death record, record a mortality review (SAFE-014). Missing
  persons: keep the timeline, close an episode, write a Herbert Protocol profile (SAFE-015).
  Disclosures: log a request, review the records, approve or refuse, release and hand over the
  pack, record a coroner's report to prevent future deaths (SAFE-016). Import of medicines, care
  plans or staff file checks, with imported medicines held "not yet checked" (PLAT-014, HZ-005).
- **About 30 guides brought up to `main`**: the policy, quality dashboard, PIR and DSPT guides no
  longer say their screens arrive with the next merge; the import guides follow the import screen
  (**Import records**, what the file holds, undo of medicines, care plans and staff checks); death
  and missing person guides link the new records; speak-up guides name the outside routes the
  screen names; data rights point police, coroner and solicitor requests to **Disclosure
  requests**; spec rule numbers and branch names are out of the body text.
- Role indexes, the guides README and the register's user docs column link every guide; the
  README's duplicated intro line and the "screens with the next merge" notes are gone; seven older
  guides that were missing from the table or register were added when `main` was merged into
  slice 82.

## No screen yet

- INTG-006 dm+d release history, INTG-007 identity and vetting checks, INTG-013 e-signature and
  scanning paper MARs, LMS import (WORK-006), sending a locked pay run to payroll (SCHED-008),
  single sign-on settings (PLAT-005), importing contacts and allergies (PLAT-014).
- Safety: appointing the Freedom to Speak Up lead and exporting speak-up cases; IPC audits; staff
  on the outbreak line list (H-955); correcting a death step; the Herbert Protocol photograph;
  a second fetch of a disclosure pack and refusing a request before it is ready.

## H-1150 to H-1158 (from the first pass)

- Fixed in code: H-1150, H-1151, H-1156. Partly: H-1152 (speak-up leads alerted; no lead, no
  acknowledgement clock, no appointment screen). Not yet: H-1153, H-1154, H-1155, H-1157, H-1158.

## Found, not fixed here (for the builders)

- Disclosures: some text says the approver "did not prepare it", the rule says "did not log"; a
  collected record that no longer exists may stay "Still to review"; "second factor" wording; only
  Access to Health Records requests get a due date.
- The outbreak report is "UKHSA report" on one page and "Outbreak report to the health protection
  team" in the notification centre.
- Import: the undo dialog says "Remove {n} people" for medicines, care plan and staff imports;
  **Import records** shows only to people who can add and see people.
- `docs/specs/quality.md` has duplicated section numbers and two empty stub headings.
