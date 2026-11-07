# Location evidence and lone-worker location only under a signed DPIA (H-1555)

Branch `fix/scheduling-clock-evidence-dpia`, from `main` at daa038a7. A security and data
protection fix found by the slice 84 DPIA review.

- **The bug**: `PUT /v1/locations/{id}/clock-setting` turned on location or NFC clock-in evidence
  (employee monitoring, H-527) whenever the caller sent `dpiaApproved: true`; the lone-worker
  location flag had no DPIA check; neither flagged the signed DPIA for review.
- **The fix**: two monitoring flags, `scheduling.lone_worker.location` and the new
  `scheduling.clock.location_evidence` (the organisation's intent to use clock evidence), count in
  the DPIA's basis, so turning one on flags the signed DPIA for review (`feature_enabled`). Location
  or NFC clock evidence is accepted, kept at clock-in, and a lone-worker location stored, only when
  the flag is on and the latest signed DPIA covers it; otherwise the setting is refused (422,
  `dpia_monitoring_not_covered`, audited) and clock-in keeps `none`. `dpiaApproved` is kept for
  compatibility, deprecated and ignored; the audit records the id of the signed DPIA relied on
  (`dpiaId`). `GET` and `PUT /v1/locations/{id}/clock-setting` add `inUse` (whether the evidence
  is in effect there); the lone-worker route's `locationEvidence` is documented as the
  organisation-wide value; a lone-worker event's audit says whether a point sent was kept
  (`locationKept`).
- **Migration 0153** (`signed_dpia_covers(flag)`): a security-definer function answering one
  question, the signed DPIA's id when its basis lists the flag and NULL otherwise, so callers never
  read the feature list; needed because the DPIA's row-level policy hides it from carers and lone
  workers whose requests run the check (ADR-0133 owner and grants; definer ACL test). Narrowed
  from a whole-feature-list function after the security review. Renumbered to the next free
  number at merge if #188 takes 0153 first.
- Tests: domain (table-driven basis, coverage and review triggers), API (refusals with a client
  tick, flag off, DPIA not covering; acceptance when covered; clock-in evidence; lone-worker
  location; review trigger; another organisation's signed DPIA never relied on; a genuinely
  superseded version), database (definer ACLs; the definer answers only for the caller's
  organisation and never from a superseded version).
- Docs: records of processing, `scheduling.md`, `data-standards.md`.
- Register: SCHED-011 (wellbeing) and INTG-007 (vetting adapters) were `todo` with code on
  `main`; both are now `partial` with spec, code and tests linked, and the summary counts and
  STATUS's overall line are corrected.
