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

**NEWS2 on the device (Phase 1, slice 10)**: the mobile app runs the same `calculateNews2` from `@harbour/domain` on the device, so a score shows with no signal. It uses the SpO2 scale the person's synced care profile sets (scale 2 only where a clinician recorded it); when the profile or the scale is not on the device it shows no total (rule 3) and says the scale is not on the device, and the server scores the readings on upload. With a total it shows every parameter's points, the formula and the published bands (rule 2), the RCP clinical risk, response, monitoring and chart 4 clinical response wording unchanged, the source with the tool version and a link to the RCP page (rule 1), and the line "Follow your organisation's escalation policy for this score" (rule 4); it adds no advice of its own. The device sends the readings only, never a score: the API recalculates on upload and raises the alert and tasks (`apps/mobile/src/care/charts.ts`, `apps/mobile/src/components/News2Panel.tsx`). Both the server's calculator and the device's path from typed readings are tested against `NEWS2_REFERENCE_VECTORS`, fixed readings whose points for every parameter, totals and bands were worked by hand from the RCP charts, so two errors cannot cancel out (rule 6; `packages/domain/src/care/news2-vectors.ts`); the CSO spot-checks them (human action H-129). Whether chart 4's ward wording suits homes without nurses, and whether the points could be shown when the SpO2 scale is not on the device, are CSO decisions (H-127, H-128). Linking the tenant's escalation policy document from the device is a follow-up (the document is not stored offline yet).

**Escalation policy link (Phase 1, care API follow-ups; rule 4)**: the organisation configures which of its own policies each validated tool's result links (`escalation_policy_link`: per tool, optionally per band and per location, a title, a reference and one of its own documents; holders of `quality.policy.manage`). Every stored result of NEWS2, MUST, Waterlow, Braden and the NG249 falls pathway is returned with `escalationPolicy`: the organisation's link for the result's tool and band (a location's own first), or `not_configured`. The web shows it on every assessment result and every NEWS2 entry (`EscalationPolicyLine`): the policy's title and reference, linking its document, or, with an icon, "No escalation policy is configured for this result. Follow your organisation's procedures and tell the nurse in charge.", never nothing (#26 review round 2, C6), and on the NEWS2 result shown straight after saving (#26 review round 3). That sentence sends staff to the organisation's own procedures and the nurse in charge; it names no clinical response. It shows on every band, NEWS2 0 included, where the RCP's own response is routine monitoring, so "tell the nurse in charge" may read as Harbour adding to the published response; whether it should show only for bands that need a response is for the CSO (H-73; HZ-008). Who an urgent alert actually reached is said from the route kept on the entry, never assumed (#26 review round 3; HZ-014). The link is chosen by fixed lookup on the tool, the published band and the place (`escalationPolicyFor` in `packages/domain/src/care/escalation-policy.ts`); Harbour writes none of the policy's words, so the result still carries no recommendation of Harbour's own. Tests: `hazard HZ-012 the link is the organisation's own policy, never a Harbour recommendation`, the web tests and the Playwright journeys with axe for a configured policy (NEWS2) and none configured (MUST), and the HZ-014 tests listed in the hazard log. The phone shows the link next (H-73); the lookup order is for the CSO (H-163).

Where the Waterlow card leaves room for reading, the reading taken is stated in the source comment of `waterlow.ts` for CSO review:

| Reading | Card text | Harbour |
| --- | --- | --- |
| Obese at 30 | "Above average BMI 25-29.9"; "Obese BMI > 30" | A BMI of 30.0 or more scores 2 |
| Exact BMI bands | Bands written to one decimal place, with gaps between 24.9 and 25 and between 29.9 and 30 | Under 20, 20 up to 25, 25 up to 30, 30 or more, on the exact BMI |
| Medication, maximum 4 | "Cytotoxics, long term/high dose steroids, anti-inflammatory: max of 4", no per-item score | 4 when any listed medicine applies, however many |
| Weight lost as categories | "0.5-5 kg = 1; 5-10 kg = 2; 10-15 kg = 3; > 15 kg = 4" (bands share end points) | The assessor chooses the band; no kilogram entry |
| Neurological deficit capped at 6 | "Diabetes, MS, CVA 4-6; motor/sensory 4-6; paraplegia (max of 6) 4-6" | Each condition 4 to 6 at the assessor's choice; category total capped at 6 |

**Notification, capacity and post-fall rules (Phase 1, slices 6 and 7)**: these stay inside the boundary and add no score. The incident classifier (`packages/domain/src/safety/classifier.ts`) records a health care professional's opinion of harm, in the regulations' words, and applies the regulations' tests (CQC Registration Regulations 2009 regs 16 and 18, RIDDOR 2013, regulation 20 of the 2014 Regulations) to decide which notifications to draft; it does not assess an injury. The capacity rules (`packages/domain/src/care/mca/`) check that a recorded assessment follows the Mental Capacity Act's two-stage test; the assessor decides. The post-fall checklist (`packages/domain/src/safety/post-fall.ts`) applies tenant-configurable observation figures (defaults from NICE NG232, to be confirmed by the CSO, human action H-66) and NG232's published criteria for seeking urgent medical advice, linked to the tenant's post-fall policy; it does not judge the injury or recommend treatment, and a test asserts it returns no score.

**Downtime pack, evidence pack and templates (Phase 1, slice 11)**: these stay inside the boundary and add no score. The downtime pack (`packages/domain/src/operations/downtime-pack.ts`) copies recorded allergies, resuscitation decisions, IDDSI food and drink levels, communication needs, care plan summaries and risk assessments. Where resuscitation records disagree it prints every record in force and says so in the section, pointing to the signed forms and the home's policy; it never chooses between them or ranks them. Allergies are ordered by their recorded severity only (unknown with severe), which sorts recorded values and adds no judgement. Where a value is missing or cannot be read it says so and tells staff to check; where information is held elsewhere (PEEPs, the paper MAR) it says where. With the eMAR, the medicines section lists doses as scheduled and recorded (due, given, PRN last given) and recommends nothing. Back-entry rules check times, outages and possible duplicates, not clinical content. The evidence pack selects and redacts records; letter templates merge recorded values and add no clinical wording.

**Family feed and notifications (Phase 1, slice 12)**: these stay inside the boundary. The feed
(`packages/domain/src/comms/`) composes fixed sentences about activities, visits, appointments,
photos and care plan updates, and words a member of staff wrote for the family; it has no kind for
observations, charts, assessments, validated tool results, body maps, medicines or incidents, and
it refuses staff-written words that name a validated tool or a score, or read as a diagnosis or a
prognosis (`FEED_CLINICAL_TERMS`, a backstop behind the staff member's decision, checked on
normalised text, each part of a hyphenated word and without plural endings). Staff words that
announce an event or claim how the person is (`FEED_EVENT_TERMS`, `FEED_WELLBEING_TERMS`) are word
lists, not an assessment: they only ask a manager to confirm before publishing (HZ-061). Care plan
sections such as end of life and medicines are never announced (`FEED_CARE_PLAN_DOMAINS`).
Approved phrases say what happened, never how the person is. Notifications carry an approved
generic line and a link only. Nothing interprets, scores or predicts
([comms.md](../specs/comms.md) rules 7 to 13).

**Medicines record and reconciliation (Phase 2, slice 2)**: these stay inside the boundary and add
no score or recommendation (`packages/domain/src/medicines/`; [medicines.md](../specs/medicines.md)
rules 1 to 12). A dose is transcribed exactly as prescribed, as a number and a unit dm+d permits for
the product; Harbour checks how it is written (a zero before the point, no trailing zero, micrograms,
nanograms and units in full) and never calculates, converts or range-checks it. Schedules are the
prescribed wall-clock times expanded over the MAR cycle; Harbour suggests no time and no gap, and
when a clock change brings two prescribed times together it keeps both doses and flags them for
the nurse in charge rather than choosing. In a reconciliation a person decides every medicine on
the MAR and every line in the sources; Harbour never infers a stop from a medicine missing from a
letter, never pairs a line with an entry itself, and shows a difference on a link the person made by
dm+d identity only (another VMP, another brand of the same VMP, or not coded), never by comparing
ingredients; a medicine started while an entry for the same VMP continues is flagged as a possible
duplicate by that identity alone, and another product with the same ingredient is never flagged
(#135 review). Which sources can show that a medicine continues is a record-keeping rule about the
document (the discharge letter, a prescription or the GP record), not a judgement about the
medicine. Allergies in the sources are compared with the recorded allergies by the person, who
confirms it; Harbour matches no allergen (the section 6 grey area, decided in ADR-0082 with slice 3).
The time-critical and minimum-interval rules (ADR-0082) are slice 3's and are not in this slice.

**Administration, PRN and controlled drugs (Phase 2, slice 3)**: these stay inside the boundary
(`packages/domain/src/medicines/`; [medicines.md](../specs/medicines.md) rules 13 to 27;
ADR-0082). Harbour compares the amount recorded with the dose on the entry, or on its checked dosing
record for a variable dose, and asks why when they differ; it never calculates a dose, suggests one
or says whether one is safe. Time windows, the paracetamol gap and the PRN maximum are the
prescriber's or the tenant's figures, applied to entries a person tagged; Harbour adds no interval
of its own and matches no ingredient. A dose over the prescribed 24-hour maximum is refused and the
prescriber decides; a dose inside an interval needs a person's reason. A dose the person took
themselves, or their family gave, is recorded as a fact; over the maximum it is flagged and
escalated to the nurse in charge, whose organisation's policy decides what follows: Harbour adds no
clinical advice (#162 clinical review; H-1062). "Remaining" is the prescriber's maximum less the
total recorded, arithmetic on a figure a person set (section 3), and says nothing about whether
another dose is safe; the CSO confirms that reading (H-1065). A dose in another unit is named as
not counted, never converted. A scheduled dose is not recorded before its window opens, which is
the tenant's own figure; a variable dose comes from the newest dosing record a person transcribed
and another checked, never from a calculation. Late doses stay outstanding and are escalated;
Harbour never makes a missed dose due again (a treatment decision). Competence is a record of an
observed sign-off, not an assessment. The controlled drugs register checks arithmetic and
signatures, not the medicine.

**Dependency tool and required care hours (Phase 2, slice 12)**: these stay inside the boundary and add no score. The dependency scale is the organisation's own tool ([scheduling.md](../specs/scheduling.md) section 13): the organisation writes its shift periods, its categories with care minutes per period, its skill-mix minimums and its review interval, and a second member approves each version. A member of staff chooses each person's category from that scale and records why and who decided; Harbour never proposes, derives or checks a category from care records, observations or assessments. The required care hours for a shift are the organisation's own figures added up for the people living at the location (`staffingRequirement` in `packages/domain/src/scheduling/dependency.ts`), with the method shown step by step, the scale's name, version and approval as the source, and the notice "These hours come from your organisation's own dependency scale. Harbour adds up the figures your organisation set; it does not assess anyone's needs or judge safe staffing." The comparison with the rota (`compareStaffing`, shown by slices 21 and 59) says only whether the rota's hours and skills reach the organisation's figures, in its own words; it carries no score, risk level, prediction or recommendation, and never blocks a rota. A test asserts the result has no score or risk field (HZ-123). The scale is not a validated tool and is never labelled as one. The CSO confirms this reading (H-710).

**Regulatory opinion needed** `[human action]`: MHRA guidance indicates that software performing calculations that inform clinical decisions can be a medical device. Thapsus's position is that reproducing a published paper tool exactly, with every sub-score and the banding visible so the user can verify it, and leaving the response to the provider's own policy, is a record-keeping aid. This position should be confirmed by regulatory advice before the Phase 1 tools are used by a live tenant.

## 6. Grey areas that need an ADR and CSO review before they are built

| Proposed feature | Phase | Question to answer |
| --- | --- | --- |
| Matching a recorded allergen to a medicine's dm+d ingredients on the administration screen (HZ-007) | 2 | Decided in [ADR-0082](../decisions/0082-medicines-rules-at-the-device-boundary.md) (proposed, CSO and a pharmacist to accept, H-514): allergies are displayed beside every medicine with no automated matching; in a reconciliation the completer confirms they compared the sources' allergies with the recorded ones |
| Applying time-critical and minimum-interval rules (Parkinson's medicines, the paracetamol gap across products, bisphosphonates before food) | 2 | Decided in [ADR-0082](../decisions/0082-medicines-rules-at-the-device-boundary.md): the rules apply to entries a person tags at transcription and a second person checks; Harbour suggests a tag only from the tenant's own list of exact dm+d VMPs, never by ingredient or name; each entry's own interval is the prescription's or PRN protocol's; the figures are the tenant's, from the rate table |
| Dependency tool converting categories to care hours | 2 | Built as the safe default in slice 12 (section 5, "Dependency tool and required care hours"): the organisation's own scale, labelled as its tool, categories chosen by staff with a reason, hours added up with the method shown, no score or judgement of safe staffing. The CSO confirms the reading and decides whether it needs an ADR of its own (H-710) |
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
