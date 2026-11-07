# Printable MAR chart and controlled drugs register page (Phase 2 slice 50)

Branch `feat/meds-printable-mar`, from `integration/phase-2-batch-3b` (051e609b). MEDS-014. No
migration.

## What changed

- **API**: `GET /v1/people/{id}/mar/print?month=` and `GET /v1/controlled-drugs/pages/{pageId}/print`.
  Both are PDFs drawn when asked and never stored, audited by id (`medicines.mar.printed`,
  `medicines.cd.printed`).
- **The MAR chart** for a month shows the allergies (most severe first, unknown never shown as none)
  and a key to the codes. Each medicine shows every dose by day, with its outcome code, the giver's
  initials, and covert and corrected marks. A dose with no outcome is said in words. When-required
  doses show as recorded, and the staff initials are listed.
- **The register page** shows every entry with its running balance and signatures, each correction
  under its entry, and every stock check in words (H-1331's format).
- Every page names the person and says when it was printed and that it is not the live record.
- **Web**: "Print the MAR chart" on the Medicines tab (choose a month), and "Download the register
  page (PDF)" on a register page.
- **Docs**: a new hazard, HZ-122 (allocated to slice 50 in the phase plan), and an HZ-007 row;
  medicines.md section 17; H-1331 updated.

## Left

- The CSO and a pharmacist confirm the register page's format, and whether a sealed PDF is needed
  (H-1331).
