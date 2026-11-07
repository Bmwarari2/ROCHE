# Web: stock, homely remedies, errors and reviews (Phase 2 slice 55)

Branch `feat/meds-web-stock-errors`, from `integration/phase-2-batch-3b` (051e609b). MEDS-007,
MEDS-008, MEDS-012, MEDS-013. No migration and no API change.

## What changed

- **Medicines stock** (`/medicines-stock/{location}`, in the side navigation):
  - the ordering cycle;
  - orders, started from the medicines in force, then submitted or cancelled;
  - storage areas and temperature readings, each reading's state shown as an icon and words, as
    the API decided it (HZ-132).
- **A person's stock**: items, receipts, counts, returns, disposals and the disposal witness. A
  balance below nought is said in words (HZ-003).
- **Homely remedies**:
  - the home's protocols: add, change with a reason, and withdraw;
  - a person's doses: each is checked against the protocol before it can be recorded, with the
    person and every allergy beside the form (HZ-120, HZ-007);
  - a dose can be marked entered in error.
- **Medication errors**: the error record on the incident, with the escalations in the API's words
  (HZ-134).
- **Medication reviews**: per person, and a tracker for the home.
- **Reports** (`/medicines-reports/{location}`): the override, PRN and error trend reports, as tables
  (HZ-119).
- **Links** from the person's Medicines tab, the stock page and the incident.
- **Docs**: medicines.md section 18; hazard log rows for HZ-003, HZ-007, HZ-119, HZ-120, HZ-132 and
  HZ-134.

## Left

- Stock has no expiry field in the contract, so expiry states are not shown.
- The disposal witness list and the staff a homely remedy protocol names need a staff list that
  holders of `medicines.*` can read. Today they use the workforce and members routes where the reader
  has them.
- Recording a homely remedy dose already given is not offered on the web.

## Review fixes (2026-11-07)

- Homely remedies (HZ-120): the person's current medicines are listed beside the dose form, a
  protocol with no dm+d product says it cannot be checked against the MAR, and the giver confirms
  the comparison (H-1410, provisional).
- Storage temperatures (HZ-132): the state is "In range" or "Out of range" only, as the API decided,
  with the figures beside it; after recording, the state and figures take focus (H-1411, provisional).
- Accessibility: order lines in a captioned table; arrivals take focus on the order and stock pages;
  report period errors and refusals are said on arrival; disposal says it cannot be undone;
  communication needs beside each person on orders, medication errors and the review tracker.
- Security: the witness form shows only for a disposal found on the person; permissions come from
  what reaches the person; an order must belong to the home in the address.

## The comparison stored (2026-11-07)

- A homely remedy dose now needs `medicinesCompared: true` from every client. The API stores it on
  the dose (`medicines_compared`, migration 0155, with a database check on doses given from then on)
  and audits it with the allergy confirmation (HZ-120, H-1410). It is also in the export.
