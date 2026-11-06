---
status: "accepted"
date: 2026-11-06
decision-makers: Thapsus engineering (Claude Code, under the working agreement)
consulted: CSO and a pharmacist (to confirm, H-1320 to H-1329)
informed: Design partner
---

# Medicines stock per person and product, controlled drugs left to their register

## Context and problem statement

MEDS-008 (master prompt 10.2) asks for stock, 28-day ordering, disposal records and fridge and
room temperature logs. Slice 22 records doses; slice 34 keeps the controlled drugs register with
its own balance. Where does stock live, how do doses move it, and how do we avoid counting a
controlled drug twice or advising on medicines kept out of range?

## Decision drivers

- In care homes, most medicines are dispensed for one person, labelled with their name.
- A controlled drug already has a legal register with a running balance (section 14).
- A dose must never be refused because stock is wrong (HZ-003).
- Whether a medicine kept out of range can be used is the pharmacist's call, never Harbour's
  (medical-device boundary; HZ-132).
- Every figure must come from the rate table.

## Considered options

- Stock per home and product, shared by everyone.
- Stock per person and product, with controlled drugs read from their register.
- Controlled drugs in the same stock tables as everything else.

## Decision outcome

Chosen option: "Stock per person and product, with controlled drugs read from their register",
because it matches how medicines are dispensed and keeps one balance for each controlled drug.

- An item is opened from a person's MAR entry, in its dose unit. The database refuses an item for
  a controlled drug.
- Movements are append-only, each with the balance after it, which the database checks.
- A dose given takes its amount off, through slice 22's hook, in the same transaction, and never
  refuses the dose. A balance below zero asks for a count. A correction moves the difference.
- A disposal is witnessed by a second member who confirms it themselves, or, where the
  organisation sets `medicines.disposal.witness_required` to 0, recorded with why no one could
  witness it.
- A location's 28-day cycle prompts an order before each cycle. Orders go by hand, or through a
  pharmacy port that has only a contract-tested mock (H-517, H-1321).
- Temperature ranges come from the rate table. The database decides whether a reading is out of
  range. An out-of-range reading raises an urgent task whose words send staff to the pharmacist.

### Consequences

- Good: no controlled drug is counted twice, and the register stays the legal record.
- Good: stock never blocks care.
- Bad: household remedies and home stock are not covered (H-1320).
- Bad: a dose in a different unit from the item's moves no stock (H-1323).

### Confirmation

`packages/domain/src/medicines/stock.test.ts`, `packages/db/test/medicine-stock.test.ts` and
`apps/api/test/medicine-stock.test.ts`; HZ-003 and HZ-132 in the hazard log.

## Pros and cons of the options

### Stock per home and product

- Good: simpler for homes that keep shared stock.
- Bad: a person's labelled medicines would be counted with another's.

### Controlled drugs in the same stock tables

- Good: one stock view.
- Bad: two balances for one controlled drug, and one of them outside the legal register.
