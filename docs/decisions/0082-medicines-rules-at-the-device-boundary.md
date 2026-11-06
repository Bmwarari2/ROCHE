---
status: "proposed"
date: 2026-10-31
decision-makers: Claude Code (lead engineer), taking the Phase 2 plan's default; the CSO with a pharmacist accepts or changes it (H-514)
consulted: master prompt 5.2, 10.2 and 10.3; docs/compliance/medical-device-boundary.md sections 3, 4 and 6; docs/plans/phase-2.md (decisions table); NICE SC1 and CQC time-sensitive medicines guidance as the master prompt cites them
informed: everyone working on lane A (medicines), the CSO, the data protection lead
---

# Medicines rules at the medical-device boundary

## Context and problem statement

Section 10.2 asks the eMAR for "late and early warnings with time-critical rules (Parkinson's,
paracetamol 4-hour gap, bisphosphonate 30 minutes before food)", and section 10.3 for blocking a
duplicate within the minimum interval. The rate table holds `medicines.paracetamol.min_interval_hours`
and `medicines.bisphosphonate.before_food_minutes`. But the medical-device boundary (section 3) says
the interval comes "from the prescription or PRN protocol, not from Harbour", and applying a
paracetamol rule across products (a co-codamol entry and a paracetamol entry) needs Harbour to know
which products contain paracetamol: ingredient matching, which section 6 lists as a grey area beside
matching a recorded allergen to a medicine's dm+d ingredients (HZ-007). How does the eMAR apply
time-critical and interval rules, and show allergies, without Harbour deciding which medicines they
apply to by its own reasoning?

## Decision drivers

- Stay outside the UK Medical Devices Regulations: Harbour applies rules a person or the tenant
  configured; it never decides clinically which medicines a rule applies to (boundary section 2).
- Safety (HZ-003, HZ-004, HZ-007, HZ-009): time-critical doses must be on time, a second
  paracetamol-containing medicine must not be given within the gap, allergies must be in view.
- Every rule is visible and attributable: who set it, who checked it, from what source.
- Statutory and tenant figures come from the rate table, never literals (section 18).

## Considered options

1. **Tags a person sets at transcription, second-checked, with tenant lists as suggestions** (the
   plan's default).
2. Automatic matching on dm+d ingredients (VTM, and the VMP's ingredient table) for interval rules
   and allergens.
3. No cross-product rules: only each entry's own prescribed interval; allergies shown only on the
   person's header.

## Decision outcome

Chosen option 1, because it gives the cross-product protection the master prompt asks for while
leaving the clinical judgement (which medicines a rule applies to) with a person, checked by a
second person, as every other part of the MAR entry is.

- **Tags.** A MAR entry carries `tags` (`time_critical`, `paracetamol`, `bisphosphonate`,
  `psychotropic`) set by the transcriber and confirmed by the second check like the rest of the
  entry; changing a tag is a new version (medicines.md rule 6). Harbour suggests a tag only when the
  tenant's own list for that tag holds the product's exact dm+d VMP (`suggestedTags`); it never
  suggests or sets one from an ingredient, a name or another product.
- **Time-critical.** An entry tagged `time_critical` has the narrower dose window
  (`medicines.time_critical.*`, never wider than the regular `medicines.dose_window.*`), so it is
  late, and escalated, sooner (HZ-003). The tenant maintains the time-critical list (H-514).
- **Intervals.** An entry's own minimum interval is the one the prescription or PRN protocol states,
  transcribed and checked (`minimumIntervalMinutes`). The tenant's paracetamol rule
  (`medicines.paracetamol.min_interval_hours`) applies across every entry a person tagged
  `paracetamol`, measured in elapsed time on the drift-corrected clock; a dose inside either needs an
  override reason (HZ-004, HZ-009, HZ-010).
- **Before food.** An entry tagged `bisphosphonate` shows the before-food instruction with
  `medicines.bisphosphonate.before_food_minutes`, beside the label's own words.
- **Psychotropic.** The tag feeds the PRN psychotropic report (slice 28); the list is the tenant's.
- **Allergies.** Shown beside every medicine on the round and the MAR with no automated allergen
  matching (boundary section 6); in reconciliation the completer confirms they compared the allergies
  in the sources with the recorded allergies.

### Consequences

- Good, because no rule depends on Harbour's reading of ingredients: a missing tag is a transcription
  error the second check is there to catch, not a silent software decision.
- Good, because the figures are the tenant's, from the rate table, and the lists are the tenant's.
- Bad, because a person must remember to tag a combination product (co-codamol) as paracetamol;
  the tenant list's suggestion helps only for products on it. The residual risk is recorded on
  HZ-004 and HZ-005 for the CSO.
- Neutral, because allergen matching may be revisited with regulatory advice (boundary section 5,
  "Regulatory opinion needed"); that would be a new ADR superseding this one.

### Confirmation

- `packages/domain/src/medicines/timing.test.ts`: `hazard HZ-003 time-critical medicines escalate at
  the earlier threshold`; `intervals.test.ts`: the paracetamol rule across tagged entries and never
  for an untagged one, and `hazard HZ-009` and `hazard HZ-010` interval tests;
  `mar-entry.test.ts`: `ADR-0082 tags come from a person at transcription, offered only from the
  tenant's own lists` (no suggestion by ingredient).
- The clinical-safety reviewer agent checks every lane A pull request for ingredient matching; the
  boundary question in the pull request template is answered.

## Pros and cons of the options

### Tags at transcription, checked, with tenant lists as suggestions

- Good, because a person decides, and a second person checks, as the boundary requires.
- Bad, because it relies on correct tagging (mitigated by the second check and the tenant lists).

### Automatic ingredient matching

- Good, because a combination product could never be missed.
- Bad, because it is decision-support logic that may bring Harbour within the medical-device
  regulations, and errors in matching would be silent.

### No cross-product rules

- Good, because it is simplest.
- Bad, because it drops the paracetamol protection section 10.2 asks for (HZ-004).

## More information

Medicines spec rules 13 to 20 ([medicines.md](../specs/medicines.md)); boundary section 6 updated
in the same pull request; the plan's decisions table
([phase-2.md](../plans/phase-2.md#decisions-taken-for-this-phase)). Revisit when the CSO and the
pharmacist answer H-514, or when regulatory advice on decision-support functions is received.
