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

## Left

- Recording a dose already given, a controlled drug's witness and corrections on the web round:
  follow-ups. A controlled drug is refused by the API in its words until then.
- Slice 28's PRN protocol text and outcome check are not in this base. Hazard HZ-117 is cited in the
  test names only, because its log entry is on slice 28's branch.
