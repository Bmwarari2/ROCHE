# Controlled drug recording page: journey and navigation (H-1518)

Branch `feat/web-cd-recording-journey`, from `main`. Follows #205, whose accessibility review asked
for a browser journey for the new page.

## What changed

- `apps/web/e2e/cd-recording.spec.ts`: the Registered Manager finds the page in the navigation,
  turns recording off at the demo home (refused first without a reason or the restart, then sent to
  sign in again for the second step), sees the register say the paper register is the record, and
  turns it on again with the three confirmations (refused first without them). A nurse and a care
  worker are offered no entry, no form and no checkbox. Axe in light and dark at each state.
- The journey found the page had no way in: it is now in the navigation ("Controlled drug
  recording", for holders of both permissions), with a home chooser at `/medicines-settings`.
- The page's "could not check" state is a component, `CdRecordingSetting`, unit-tested, since a
  browser journey cannot make the API's flags unreadable.
- STATUS: H-1518 is built (#205). The hazard log's HZ-115 verification and `medicines.md` 15
  name the journey and the page.

No migration, no API change, no personal data.
