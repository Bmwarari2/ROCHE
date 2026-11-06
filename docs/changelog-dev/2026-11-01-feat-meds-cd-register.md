# Controlled drugs register: tables and API (Phase 2 slice 34)

Branch `feat/meds-cd-register`, from `feat/meds-administration-schema` (slice 22), with #162's
latest head (bd49dc9c) merged in. MEDS-005, ADR-0083.

## What changed

- **#162 merged in**:
  - Every correction is reviewable (`dose_removed`, `dose_moved` and the other new flags).
  - The slice 22 API passes the corrected record's outcome, amount and giver.
  - Escalation tasks are named for the new reasons.
  - 0128 widens 0123's flag check.
- **Migration 0128**:
  - `controlled_drug_page`: one per person and dm+d product.
  - `controlled_drug_entry`: append-only. The database checks each entry's place, its order and
    the balance after it against the entry before.
  - `controlled_drug_witness_assertion`: what a witness signed for. It covers the movement, the
    quantity, the administration and the recorder they watched, and is used once before it
    expires.
  - `controlled_drug_stock_check`.
  - Corrections name an entry on their own page. Destruction is always witnessed. The witness is
    never the recorder or the giver.
  - Forced RLS and person scope, no UPDATE or DELETE for the application, sample removal and the
    export catalogue.
  - New rate: `medicines.cd.witness_assertion_minutes`.
- **API** (`apps/api/src/routes/controlled-drugs.ts`):
  - Pages, entries checked by `checkCdEntry`, witness signatures and stock checks. Recording and
    signing each need a fresh step-up.
  - A count that does not balance needs a reason and publishes `medicines.cd.stock_discrepancy`.
    The safety module raises a medication incident, once.
- **Slice 22's hook**:
  - A controlled drug given writes its register entry with the record. It needs
    `medicines.cd.administer`, a step-up and a witness.
  - A correction of it writes a margin correction from the chain's entry.
  - Doses taken by the person themselves or given by family are refused until H-1202.
  - A late-recorded dose older than the page's last entry is entered when recorded.
- **Review fixes**:
  - **Security**: the `medicines.cd.administer` check; the witness kept apart from the giver;
    signatures bound to the recorder; corrections carry the chain's entry forward; lone counts
    flagged; self-administered controlled drugs refused.
  - **Clinical**: late-recorded doses; a dose newly given by correction entered at the time
    given; never-checked pages due from opening; outbox and audit from the hook; stock checks
    open to `medicines.stock.manage`; test ids relabelled HZ-115.
- **Docs**:
  - medicines.md section 14;
  - the hazard log: a new HZ-115 entry, and rows for HZ-004, HZ-009, HZ-011, HZ-116 and HZ-119;
  - records of processing B1, data standards, retention;
  - the feature register, STATUS, and human actions H-1200 to H-1209.

## Human actions logged

- H-1200: the switch from the paper register.
- H-1201: how long a witness's signature lasts.
- H-1202: self-administered and family-given controlled drugs.
- H-1203: whether a dose corrected to not given is returned to stock or disposed of.
- H-1204: late-recorded doses.
- H-1205: the register unit.
- H-1206: overdue counts.
- H-1207: rating HZ-115 and HZ-116.
- H-1208: register read permission and the signature grant.
- H-1209: patch site rotation.

## Tests

- `packages/db/test/controlled-drugs.test.ts`: isolation, the running balance, corrections, no
  edits, witness rules including the recorder binding, stock checks, and the link between an
  administration and its entry.
- `apps/api/test/controlled-drugs.test.ts`:
  - pages; witnessed receipts and refusals; witness competence; step-up;
  - the permission check and the self-administered refusal;
  - a dose given with its entry; a margin correction through a correction that moved no stock;
  - destruction; the stock check raising an incident;
  - audit by id.
