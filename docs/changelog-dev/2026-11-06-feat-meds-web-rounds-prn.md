# Web: medicines round, administration, when-required medicines and covert (Phase 2 slice 53)

Branch `feat/meds-web-rounds-prn`, from `integration/phase-2-batch-3b` (051e609b). MEDS-002,
MEDS-003, MEDS-004. No migration and no API change.

## What changed

- **The home's medicines round** (`/medicines-round/{location}`, in the side navigation for holders
  of `medicines.emar.administer`): each person by room. It lists their doses from two hours ago to
  two hours ahead, plus any earlier dose still late or due, time-critical first. Each state is shown
  as an icon and a word, with entry notices, and when-required medicines show when last given.
- **A person's round** (`/people/{id}/medicines/round`, linked from the Medicines tab): the doses with
  the covert record beside the medicine (status, method and pharmacist's advice; H-1354). When-
  required medicines show when last given, the 24-hour total against the maximum, and when the next
  may be given.
- **Recording a dose** on its own page. The medicine is shown beside the person and every allergy
  (HZ-007). The form takes the outcome and coded reason, the amount (offered as prescribed in the
  entry's unit), and covert for a dose given under a covert record. The API's refusals are shown at
  their fields.
- Hazard log: HZ-003, HZ-004, HZ-007 and HZ-026 rows. Spec: medicines.md section 16.

- **Review round 1**:
  - **Clinical safety:** a when-required medicine says "Not now" once the 24-hour maximum is given.
    The 24-hour total is an amount in the entry's unit. A recorded, not-yet-due or under-review dose
    has no record form, even from an old address. "Given covertly" is offered for every dose given
    and warns when there is no current record. The self-administration level is shown beside the
    medicine. The clock-change wording now says what happens to the dose. A controlled-drug notice
    is on the record page. "Given" is not offered for a held entry.
  - **Security:** the server action sends only the form's fields, checked against the contract. The
    pages say when covert records or people's identities cannot be read.
  - **Accessibility:** the reason select is controlled. The home's round uses headings instead of
    repeated region names, and sentences are no longer joined from fragments. Wording and titles
    are fixed. The journey checks focus, the keyboard, the arrival state, the "not on the round"
    state and the Medicines tab with axe.
  - Human actions H-1401 to H-1405 for the CSO.

## Left

- Recording a dose already given, a controlled drug's witness and corrections on the web round
  (H-1403).
- Slice 28's PRN protocol text and outcome check are not in this base. Hazard HZ-117's log entry is
  on slice 28's branch (H-1401).
