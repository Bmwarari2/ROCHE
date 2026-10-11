---
status: proposed
date: 2026-10-11
decision-makers: Claude Code (lead engineer); the CSO accepts or rejects (human action H-60)
consulted: master prompt sections 5.2 and 10.1; docs/compliance/medical-device-boundary.md; NICE NG249
informed: everyone working on the care module
---

# Risk assessment ratings: the NPSA matrix on the assessor's judgements, and no falls rating

## Context and problem statement

Master prompt 10.1 asks for positive risk assessments with "hazard, who, likelihood, severity,
controls, residual risk, review date". Slice 4b (register row CARE-002) must store a risk rating.
The medical-device boundary says Harbour never produces "its own risk score" and never a falls
prediction score (section 4). Is a likelihood and severity rating a risk score of the kind the
boundary rules out, and how should Harbour band it?

## Decision drivers

- Reg 12 and the master prompt require likelihood, severity and residual risk to be recorded.
- The boundary: no algorithm of Harbour's own scores a person's clinical risk; NICE NG249 1.1.1
  says not to use falls risk prediction tools.
- Staff and inspectors expect a familiar matrix, not a Harbour invention.

## Considered options

- Record likelihood and severity only, with no rating.
- Rate with the published NPSA 5 x 5 matrix on the assessor's own judgements, and never rate falls.
- Let each tenant configure its own matrix now.

## Decision outcome

Chosen option: "the NPSA matrix on the assessor's judgements, never rating falls", because the
inputs are the assessor's judgements (Harbour adds no parameters and infers nothing), the arithmetic
is shown (likelihood x severity), and the banding is a published risk-management matrix used across
the NHS rather than a Harbour scale: National Patient Safety Agency, A risk matrix for risk managers
(January 2008): 1 to 3 low, 4 to 6 moderate, 8 to 12 high, 15 to 25 extreme. The rating describes
the hazard the assessor identified, not the person's clinical prognosis. The falls template records
the answers and the controls and refuses a likelihood or severity (NG249 1.1.1); falls risk is
assessed through the NG249 multifactorial pathway instead.

### Consequences

- Good, because the master prompt fields are captured without Harbour scoring a person's health.
- Good, because a residual risk of high or extreme needs a positive-risk statement, so accepted risks
  are explained.
- Bad, because some providers use a different matrix; tenant-configurable matrices wait for tenant
  templates (a later phase), labelled as the tenant's own.
- Neutral, because the bands are the published matrix and live in code with the citation, like the
  validated tools' bands; they are not rate-table figures.

### Confirmation

`packages/domain/src/care/risk-assessment.test.ts` checks every matrix product against its band,
that the falls template never rates, and that bed rail gaps are checked against the MHRA figures in
the rate table. The CSO reviews this reading with the other boundary readings (human action H-60).

## More information

Implementation: `packages/domain/src/care/risk-assessment.ts`; spec: docs/specs/care.md section 5;
boundary: docs/compliance/medical-device-boundary.md section 6. Revisit when tenants can author
their own templates. To change this decision, add an ADR that supersedes it.
