---
name: hazard
description: Add or update a hazard in Harbour's DCB0129 clinical hazard log, with controls and the automated tests that verify them. Use for any change that could affect care, medicines, alerts, sync, time or identity.
---

# Hazard log entry

The log is `docs/clinical-safety/hazard-log.md` (format and risk matrix in
`docs/clinical-safety/clinical-risk-management-plan.md`).

1. Search the log first; extend an existing hazard when the cause is the same.
2. New hazards take the next `HZ-NNN` id. Fill every field: description, causes, effects, initial
   severity, likelihood and risk, design/test/training controls, residual risk, status, owner.
3. Every control that is code gets a test whose name contains the hazard id (for example
   `hazard HZ-004 blocks a second administration within the minimum interval`). List the test in the
   hazard's Verification section.
4. If the change could cross the medical-device boundary (automated reasoning producing a diagnosis,
   prognosis, risk score or treatment recommendation), stop and write an ADR; see
   `docs/compliance/medical-device-boundary.md`.
5. Label the PR `clinical` (CI checks the log changed) and add the hazard to the next safety case delta.
