# 31 October 2026: payroll and pension exports (slice 76; SCHED-008; ADR-0097)

Branch `feat/sched-payroll-export`, from `feat/sched-pay-runs`. Migration 0127. Human actions
H-1190 to H-1195.

- **Spec:** [scheduling.md](../specs/scheduling.md) section 19. **ADR:** ADR-0097 (payroll and
  pension exports; the payroll provider is the organisation's own processor, per H-520).
- **Domain:** `packages/domain/src/scheduling/payroll-export`, deterministic and table-driven. It
  covers:
  - pounds and hours text;
  - quoted CSV cells guarded against formula injection;
  - the Staffology, Sage and BrightPay layouts (version 1, to verify) and the Xero batch;
  - order by payroll reference;
  - a missing reference refused.
- **Database (0127):**
  - `payroll_connection`: a secret's name, never a token, with one connected row per provider.
  - `payroll_export`: append-only. The database refuses anything but a locked run's current
    calculation, decides the re-export flag itself, and requires a connection for a Xero export.
  - `pay_profile.payroll_reference`: unique in the organisation.
  - Forced RLS, for holders of `finance.payroll.export` across the organisation who read pay.
- **API:**
  - `GET` and `POST /v1/pay-runs/{id}/exports`, and the `/v1/payroll-connections` routes.
  - `finance.payroll.export` is now step-up.
  - The pay profile takes a payroll reference.
  - Exports are audited with ids only, never a figure or a reference.
- **Xero Payroll UK:** `XeroPayrollAdapter` behind the port, with tokens from the secret store by
  reference. It is reached only through the contract-tested mock (`PAYROLL_XERO=mock`), and
  production must be `off` until the live client exists (H-1190).
- **Docs:** records of processing (B3), sub-processors (providers are the organisation's
  processors), data standards and the feature register are updated.

## Security review fixes

- Two exports at once: a transaction lock on the run in the API and in the guard, so only one is
  first; tested in the database and through the API.
- Xero is recorded and audited as `pending` and committed before the call, which runs outside any
  transaction. The result goes in the new append-only `payroll_export_result`: `sent`, `failed`
  (refused, or no tokens) or `unknown` (no answer), and only `failed` stops it counting.
- The database names a connection's secret (`payroll/{tenant}/{provider}/{connection}`): the caller
  no longer sends one.
- Reproducible re-exports: the first export records the references it used and later exports reuse
  them; ordering is by code unit, not locale.
- A payroll reference needs a digit and is never an NI number's shape.
- Refusals are mapped by the database's message (`run_not_locked`, `integration_not_connected`).
- `PAYROLL_XERO` defaults to `off`.

## Not built

- The live Xero client and OAuth handshake (H-1190).
- Verified file layouts (H-1191).
- Pension provider integration (H-1194).
- Export screens (H-1195).
