# How to set indicator targets

Set your organisation's own targets for the quality dashboard: an organisation default for each
indicator, and a location's own target where it needs one.

These screens arrive with the next merge; until then they are on the `feat/quality-dashboard-pir`
branch.

**Who can do this**: a location's own target: the Registered Manager and the deputy manager for
their locations, and the owner, the group executive and the quality and compliance lead. The
organisation default, and a location target looser than it: only the owner, the group executive
and the quality and compliance lead, who manage quality for the whole organisation.

**Register row**: QUAL-005.

## Steps

1. In the side bar, choose **Quality dashboard**, then **Set targets for** the location.
2. The page **Indicator targets** has a section for each indicator Harbour counts: **Falls**,
   **Pressure ulcers**, **Medication incidents**, **Overdue reviews** and **Incidents reviewed in
   time**.
3. Under **Organisation default** or the location's own target, see the current target or **No
   target set**.
4. Fill in the two numbers. For an indicator where lower is better:
   - **Within target at or below**;
   - **Close to target up to**.
   Where higher is better, the fields say **Within target at or above** and **Close to target down
   to**. The hint says the unit, for example a percentage from 0 to 100, or a rate per occupied
   bed-days.
5. Choose **Save** with the indicator and level named, for example **Save Rose House's target for
   Falls**. The page says "Target saved."

## Clear a target

1. Read the note above the button. It says what the indicator will then be rated against, for
   example the organisation default.
2. Choose **Clear** with the indicator and level named, for example **Clear Rose House's target for
   Falls**. The page says "Target cleared."

## Good to know

- Targets are your organisation's own, never a Harbour score. Harbour does not suggest one.
- A location's own target wins over the organisation default. On the dashboard, the organisation
  default is shown beside it.
- A location's target cannot be less strict than the organisation's, unless someone who manages
  quality for the whole organisation sets it.
- With no target, a figure is shown but not rated.
- The rules: [quality spec section 17, rules 18 and 19](../../specs/quality.md#17-phase-2-domain-rules-slice-8-qual-001-002-004-005-006-008-012),
  and section 22 (rule 41) of the quality spec on the `feat/quality-dashboard-pir` branch.
