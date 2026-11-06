# How to read the quality dashboard

The quality dashboard shows care indicators for one location over whole months, counted from what
is recorded in Harbour. Each figure shows how it is worked out and where it stands against your
organisation's own target.

These screens arrive with the next merge; until then they are on the `feat/quality-dashboard-pir`
branch.

**Who can do this**: the Registered Manager and the deputy manager for their own locations; the
owner, the group executive and the quality and compliance lead for every location. Care workers,
senior carers and nurses cannot.

**Register row**: QUAL-005.

## Steps

1. In the side bar, choose **Quality dashboard**. It opens on last month.
2. Under **Location and months**, choose the **Location**.
3. Under **Months**, choose **From** and **To**: whole months that have ended, up to 12 at a time.
4. Choose **Show indicators**.
5. The heading names the location and months. Under it, "Counted at" gives the date and time the
   figures were counted.
6. Each indicator card shows:
   - its status: **Within target**, **Close to target**, **Outside target** or **No rating**, each
     with an icon;
   - the figure, for example a rate per occupied bed-days or a percentage;
   - if there is no rating, the reason;
   - its working: what was counted, what it is measured against, the **Period**, the **Source**,
     **How it is worked out** and the **Target**.

If the months are the wrong way round or more than 12, the page says **There is a problem**, names
it and shows last month instead.

## Important

- **Missing or incomplete data is never rated.** Five indicators (missed visits, training
  compliance, agency hours, complaints and staff turnover) wait for parts of Harbour that are not
  built yet. They show "No data: Harbour does not record this yet." and are never rated. A period
  that is not complete in Harbour, for example before the location started recording here or with
  a downtime whose paper records are not yet entered, shows "No data" with that reason, never a
  figure.
- **A small count is withheld, never shown as 0.** A count too small to share without pointing at
  one person shows "Withheld: fewer than" the number. Its status against your target is still
  shown, so a rising problem is not hidden. A real zero is shown as 0.
- **Targets are your organisation's own, never a Harbour score.** With no target, a figure says
  "No target is set, so this is not rated." To set them, choose **Set targets for** the location
  (see [How to set indicator targets](set-indicator-targets.md)).
- Records added later, for example from a device that was offline, appear in a later view.
- The figures are counts only. They do not diagnose or predict anything about a person.
- The rules: [quality spec section 17, rules 16 to 22](../../specs/quality.md#17-phase-2-domain-rules-slice-8-qual-001-002-004-005-006-008-012),
  and sections 22 and 23 of the quality spec and hazard HZ-129 (a quality indicator or audit score
  falsely reassures), both on the `feat/quality-dashboard-pir` branch.
