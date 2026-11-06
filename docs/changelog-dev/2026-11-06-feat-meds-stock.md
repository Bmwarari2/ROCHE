# 6 November 2026: medicines stock, ordering, disposal and temperatures (slice 42; MEDS-008; ADR-0103)

Branch `feat/meds-stock`, from `feat/meds-cd-register`. Migration 0138. Hazard HZ-132 (new) and
HZ-003 (causes and controls). Human actions H-1320 to H-1329, each with a recommended answer.

- **Spec:** [medicines.md](../specs/medicines.md) section 15. **ADR:** ADR-0103.
- **Domain:** `packages/domain/src/medicines/stock.ts`, table-driven. It covers:
  - movement signs and balances;
  - the dose hook and the correction difference;
  - counts;
  - disposal witnesses;
  - the 28-day cycle and reorder prompts;
  - order steps;
  - temperature ranges, and the task's fixed words.
- **Database (0138):**
  - Stock items: one per person and product, never a controlled drug.
  - Movements: append-only, each with a balance the database checks.
  - Disposals: confirmed by their own witness, once; without one only where the organisation's
    rate allows.
  - Orders: their lines change only while the order is a draft.
  - Readings: the database takes the range from the rate table, and refuses one out of range
    without its task.
  - Person and location scope; forced RLS.
- **API:**
  - `/v1/people/{id}/medicine-stock`, `/v1/medicine-stock/...`, `/v1/medicine-disposals/...`,
    `/v1/locations/{id}/medicine-cycle`, `/medicine-orders` and `/medicine-storage`, and
    `/v1/medicine-orders/...` and `/v1/medicine-storage/...`.
  - Slice 22's hook moves stock on a given dose and its corrections. "Not available: out of
    stock" raises an urgent task.
  - The daily `medicines-reorder-prompts` job.
  - An out-of-range reading raises an urgent task that the task engine escalates when overdue.
  - The pharmacy port has a mock only (`PHARMACY_ORDERS`, off by default and in production).
- **Rates:** `medicines.order.prompt_days_before`, `medicines.temperature.acknowledge_minutes`
  and `medicines.disposal.witness_required`, to verify.
- **Docs:** the hazard log, records of processing (B1), data standards, the feature register
  (MEDS-008 partial) and human actions.

## Not built

- Medicines for leave and body-map charting of creams and patches (H-1328).
- Household remedies (H-1320).
- The live pharmacy client (H-1321).
- Missed-reading reminders (H-1322).
- Screens.
