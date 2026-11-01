# Phase 2 clean-ups

Branch `chore/phase-2-cleanups`.

## What changed

- End-to-end accessibility helpers wait for the page title before running axe, so a check no longer
  runs against a page that has not finished loading (`waitForTitle` in `apps/web/e2e/support.ts`).
- Hazard log, data standards and retention tables that had lost their header or separator rows, or
  were split by a blank line, render as tables again. HZ-126 (one target residual risk, the proposed
  figure, which the CSO rates) and HZ-130 (in the summary table) were already right on `main`.
- Duplicate section numbers fixed: quality.md now runs 18 (complaints) to 22 (data security
  evidence); workforce.md runs 2b to 2e; disclosure requests are safety.md section 12. Links,
  register anchors, human actions and code comments follow; older changelog fragments are left as
  they were written.
- docs/plans/phase-2.md lists the migration numbers (0104 to 0137) and ADR numbers (0098 to 0125) in
  use, by branch, and says numbers are now given out at assignment.
- Disclosure packs are stored as documents (category `disclosure_pack`, retention class
  `serious_incident`, linked to the request) in the documents bucket, instead of under the exports
  bucket's `tenants/` prefix, which expires after 30 days. The general document routes neither
  accept nor serve the category. Packs written before this change are still read from the exports
  bucket.
- Migration 0137 brings existing tenants' built-in roles up to the current definitions, in the 0038
  pattern and audited: the staff file, HR document, DBS risk assessment, sponsor, immigration and
  LDSS grants for owner, registered manager, deputy manager and HR, and the Freedom to Speak Up lead
  and employee relations caseworker roles where a tenant lacks them. A new ratchet test compares
  every built-in role with its first definition on `main` plus every backfill, so a permission added
  without a backfill fails.

## Data protection and clinical safety

- No new personal data or processing. The disclosure pack's storage location changed; the records of
  processing and data standards say so. No hazard changes.

## What is next

- Packs issued before this change stay in the exports bucket until it expires them; on any
  environment holding real packs, copy them across before then (none hold real data today).
