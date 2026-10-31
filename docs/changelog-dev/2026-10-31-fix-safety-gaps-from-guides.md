# Safety gaps found by the slice 83 guides

Branch `fix/safety-gaps-from-guides`, cut from main. It merges
`docs/guides-safety-quality-platform` (slice 83, the guides it fixes), so it lands after or with
that branch. No migration.

## What changed

- Safeguarding (HZ-126): a raised concern tells the managers of the log at the person's home at
  once, in the app, through the overdue chain (H-598 taken as the recommended answer), with a task
  "Decide on a safeguarding referral" due at the referral target. The raiser is left out; when they
  are the only manager at the home the other homes' managers are told, else the raiser is told and
  it is audited `raiser_only`. A manager other than the raiser opening the concern stops the chain.
  The task is completed, attributed, by referring or recording why not, and the general overdue-task
  engine leaves it alone.
- Care workers raise a concern from **Safeguarding** in the menu and from the person's
  Safeguarding measures tab. The form chooses nobody by default, shows each person's date of birth,
  and a carer stays on the page with a confirmation instead of landing on a forbidden page.
- The update form asks what will happen to the protective measures when the concern ends; changing
  the measures clears the answer unless the same update gives it; the concern shows it.
- Speak-up (new hazard HZ-131): every Freedom to Speak Up lead is told in the app when a concern
  arrives, naming nobody, urgent for care quality or safety. The first version dated an anonymous
  alert to the start of the day; the clinical review showed the time-ordered id dated it anyway and
  the blurred time buried the alert, so it now carries the real time. No lead is counted in the
  operator's unrouted signal.
- A breach notice from Thapsus links to its breach in the register.
- `safety.whistleblowing.read` is granted to no built-in role until the anonymised view exists
  ([ADR-0125](../decisions/0125-speak-up-anonymised-view-not-yet-granted.md)). Organisations
  provisioned before keep it in their copies of the built-in roles, where it opens nothing.
- The import guide says what to do about a person imported by mistake; H-1158 is reopened for the
  CSO.

## Decisions logged

H-1152 (updated), H-1158 (reopened), H-1160 to H-1165 in `docs/plans/human-actions.md`.
