# Medical-device boundary

| Item | Value |
| --- | --- |
| Status | Draft v0.1, Phase 0 |
| Owner | `[CSO name - human action]` with the engineering lead |
| Source requirement | Master prompt 5.2 and 16.2 |
| Regulator guidance | [MHRA: software and AI as a medical device](https://www.gov.uk/government/publications/software-and-artificial-intelligence-ai-as-a-medical-device/software-and-artificial-intelligence-ai-as-a-medical-device); [DHSC: using AI in adult social care](https://www.gov.uk/guidance/using-ai-in-adult-social-care) |

## 1. Why this matters

Under the UK Medical Devices Regulations 2002, software is a medical device when its manufacturer intends it to be used for a medical purpose, such as diagnosis, prevention, monitoring, treatment or alleviation of disease. The MHRA guidance above explains how this applies to software and AI. Whether Harbour is a medical device turns on its **intended purpose** as Thapsus states it and on what the software actually does. Thapsus's position is that Harbour is **not** a medical device, and this document is the boundary that keeps that true. Crossing it would bring UK conformity assessment, registration with the MHRA and post-market surveillance duties, and would change the clinical safety case.

## 2. Intended purpose statement

> Harbour is a digital social care record and operational platform for regulated adult social care providers. It stores, displays and transmits care information, applies rules that the provider configures, and calculates published validated assessment tools exactly as published, showing the calculation. It does not diagnose, predict, score risk with its own algorithms, or recommend treatment or medication. Clinical judgement and escalation remain with the provider's staff and follow the provider's own policies.

This statement is used, unchanged, in the clinical safety case, the user guides, the app store listings (the Google Play listing carries a "not a medical device" statement, master prompt 17.3) and the DPA template.

## 3. What Harbour does

| Harbour may | Example |
| --- | --- |
| Store, display and transmit care information | Care plans, notes, charts, MAR, body maps, documents |
| Apply rules the tenant configures | Reposition every 4 hours as written in the care plan; flag an overdue task; escalate an unacknowledged alarm after 10 minutes |
| Show arithmetic on recorded values against targets a person has set | Running fluid total against the daily target in the care plan |
| Calculate published validated tools exactly as published, with the formula shown | NEWS2, MUST, Waterlow, Braden, Abbey, PAINAD, Cornell, Barthel, OHAT (section 5) |
| Link a result to the tenant's own escalation policy | "Your policy for a NEWS2 score of 5 or more" opens the tenant's document |
| Enforce safety rules on record-keeping | Refuse an administration without person, dose and outcome; block a duplicate within the prescribed minimum interval (the interval comes from the prescription or PRN protocol, not from Harbour) |
| Draft, summarise and search records with the optional AI module, labelled as drafts for human review | Shift handover draft generated from records |

## 4. What Harbour must never do

| Harbour must never | Notes |
| --- | --- |
| Produce a diagnosis or suggest one | Including "possible infection", "likely UTI" or similar labels derived by the software |
| Produce a prognosis or predict an outcome | Including deterioration prediction from trends |
| Produce its own risk score | Only published validated tools. **No falls prediction scores**: the NG249 multifactorial falls assessment is used instead (master prompt 10.1) |
| Recommend treatment, medication or a dose | No dose calculation, dose-range advice or medicine suggestions |
| Interpret observations clinically beyond the published tool's banding | A trend chart is display; a statement that the trend "indicates" something is interpretation |
| Analyse images clinically | No automated wound measurement, staging or classification from photos |
| Make a solely automated decision with significant effect on a person | UK GDPR Arts 22A to 22D; no workflow state changes on AI output alone |
| Let the AI module answer clinical questions | Scope lock and classifier route the user to the right tool or clinician (master prompt 16.2) |
| Let a tenant modify a validated tool's scoring | Locked templates; a tenant's own form may score, but is labelled as the tenant's local tool, not a validated one |

## 5. Validated tools: calculated exactly as published, formula shown

Rules for every validated tool:

1. Implemented exactly as published, citing publisher, edition and URL in code and on screen. No re-weighting, no extra parameters, no changed thresholds.
2. The screen shows each input's sub-score, the total, and the published banding. The user can check the arithmetic by hand.
3. Incomplete input gives no total.
4. The result links to the tenant's escalation policy. Harbour states the published band; it does not add a recommendation.
5. Each stored score records the tool edition and the code version.
6. Table-driven tests cover every band boundary and the publisher's worked examples (hazard HZ-012 in the [hazard log](../clinical-safety/hazard-log.md)).
7. The CSO checks each implementation against its source before release `[CSO - human action]`, and Thapsus confirms the publisher's terms for using the tool in software `[human action]`.

The formula shown to users for the three Phase 1 tools:

| Tool | Formula shown | Source |
| --- | --- | --- |
| NEWS2 | Total = respiration rate score + SpO2 score (Scale 1, or Scale 2 only where a clinician has recorded that decision) + air or oxygen score (supplemental oxygen scores 2) + systolic blood pressure score + pulse score + consciousness score (new confusion, voice, pain or unresponsive scores 3) + temperature score. Each parameter score comes from the published chart. Bands shown: total 0 to 4, a score of 3 in any single parameter, total 5 to 6, total 7 or more | [RCP NEWS2](https://www.rcp.ac.uk/improving-care/resources/national-early-warning-score-news-2/) |
| MUST | Step 1 BMI score from BMI = weight (kg) / height (m) squared; Step 2 unplanned weight-loss score from percentage loss in the past 3 to 6 months; Step 3 acute disease effect score; overall risk = Step 1 + Step 2 + Step 3, banded low (0), medium (1), high (2 or more). Where height or weight cannot be measured, the published alternative measurements are offered | [BAPEN MUST](https://www.bapen.org.uk/must-and-self-screening/must-calculator) |
| Waterlow | Total = sum of the category scores on the published card (build and weight for height, continence, skin type, mobility, sex and age, malnutrition screening, and the special-risk categories), banded at risk, high risk and very high risk as published | Published Waterlow scoring card `[authoritative source and terms - human action]` |

**Implementation (Phase 1)**: NEWS2, MUST, Waterlow and Braden are calculated exactly as published in `packages/domain/src/care/` (`news2.ts`, `must.ts`, `waterlow.ts`, `braden.ts`). Each scoring table is a versioned constant with the publisher, edition and source cited in a code comment; `VALIDATED_TOOLS` in `tools.ts` carries the same citation for the screen; every result stores its `toolVersion` and the workings (each item, the value recorded and its points). Incomplete or impossible input returns a typed error and no total. NEWS2 returns the RCP chart 2 and chart 4 wording unchanged. MUST and Waterlow band the exact BMI and round it to one decimal place only for display, so a MUST BMI of 18.49 scores 2. Braden bands use the publisher's wording (severe risk, high risk, moderate risk, at risk), and a total of 19 or more reads "Below the at-risk threshold". The NG249 falls pathway (`falls.ts`) follows NICE's recommendations by setting (1.1.7 in residential care; 1.1.3, 1.1.4 and 1.1.6 in the community), names the recommendation that applies, returns follow-up tasks only, and a test asserts that it returns no numeric score. Waterlow and Braden are listed in `TOOLS_AWAITING_LICENCE_CONFIRMATION` until H-25 is closed.

**Stored results (Phase 1, slice 4b)**: `POST /v1/people/{id}/assessments` runs the calculator on the server by its tool key (`validated-assessment.ts`) and stores the tool key and version, the answers, the score, the band, the workings, the follow-ups raised and the next due date; the client never sends a score. The NG249 falls pathway is stored with no score and no band. Corrections are new rows that supersede the original with a reason. Waterlow and Braden are refused while their `care.tool.waterlow` and `care.tool.braden` flags are off: off by default for every tenant, on only in the demo tenant, until H-25 is closed. Follow-up intervals (MUST rescreening, weighing, reviews) come from the rate table; Harbour schedules them and adds no recommendation.

Where the Waterlow card leaves room for reading, the reading taken is stated in the source comment of `waterlow.ts` for CSO review:

| Reading | Card text | Harbour |
| --- | --- | --- |
| Obese at 30 | "Above average BMI 25-29.9"; "Obese BMI > 30" | A BMI of 30.0 or more scores 2 |
| Exact BMI bands | Bands written to one decimal place, with gaps between 24.9 and 25 and between 29.9 and 30 | Under 20, 20 up to 25, 25 up to 30, 30 or more, on the exact BMI |
| Medication, maximum 4 | "Cytotoxics, long term/high dose steroids, anti-inflammatory: max of 4", no per-item score | 4 when any listed medicine applies, however many |
| Weight lost as categories | "0.5-5 kg = 1; 5-10 kg = 2; 10-15 kg = 3; > 15 kg = 4" (bands share end points) | The assessor chooses the band; no kilogram entry |
| Neurological deficit capped at 6 | "Diabetes, MS, CVA 4-6; motor/sensory 4-6; paraplegia (max of 6) 4-6" | Each condition 4 to 6 at the assessor's choice; category total capped at 6 |

**Regulatory opinion needed** `[human action]`: MHRA guidance indicates that software performing calculations that inform clinical decisions can be a medical device. Thapsus's position is that reproducing a published paper tool exactly, with every sub-score and the banding visible so the user can verify it, and leaving the response to the provider's own policy, is a record-keeping aid. This position should be confirmed by regulatory advice before the Phase 1 tools are used by a live tenant.

## 6. Grey areas that need an ADR and CSO review before they are built

| Proposed feature | Phase | Question to answer |
| --- | --- | --- |
| Matching a recorded allergen to a medicine's dm+d ingredients on the administration screen (HZ-007) | 2 | Is automatic matching a decision-support function? The safe default is to display allergies beside the medicine without automated matching |
| Dependency tool converting categories to care hours | 1 | Tenant-editable scale, not a clinical score; label as the tenant's own tool |
| Wound photos with a ruler | 1 | Display only; no measurement from the image |
| AI summaries that include clinical notes | 6 | Draft labelled "generated from records"; scope lock blocks interpretation; covered by the DPIA AI addendum |
| Weight-loss or fluid alerts | 1 | Allowed only as tenant-configured thresholds, displayed as "your policy threshold", not as Harbour's assessment |
| Risk assessment rating (likelihood x severity) | 1 | Decided in [ADR-0032](../decisions/0032-risk-assessment-rating.md) (proposed, CSO to accept, H-60): the assessor's own likelihood and severity, multiplied and banded with the published NPSA 2008 matrix (1 to 3 low, 4 to 6 moderate, 8 to 12 high, 15 to 25 extreme); the formula is shown and Harbour adds no parameters. The falls template is never rated (NICE NG249 1.1.1) |

## 7. The question every clinical PR answers

The PR template's clinical-safety section contains this question. A PR labelled `clinical` cannot merge until it is answered.

> **Medical-device boundary**: Does this change make Harbour apply automated reasoning to produce a diagnosis, prognosis, risk score, or treatment or medication recommendation; interpret clinical data beyond a published tool's banding; change how a validated tool is calculated or displayed; or let AI output change a record or workflow without a human? **No** / **Yes** (an ADR and CSO review are required before merge, and this document is updated in the same PR).

The `clinical-safety-reviewer` agent checks the answer against the diff. A "Yes" is not a failure; it means the boundary decision is made deliberately and recorded.

## 8. Human actions

| Action | Owner |
| --- | --- |
| Obtain a regulatory opinion confirming the validated-tool calculation position (section 5) | Brian |
| Confirm terms for using NEWS2, MUST and Waterlow in software, and the authoritative Waterlow source | Brian with CSO |
| Review and approve this boundary statement | CSO |
