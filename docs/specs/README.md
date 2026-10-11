# Specifications

One spec per bounded context, kept current with the code, plus the cross-cutting registers that scripts
and every session read (master prompt sections 7, 9 and 18). Write a module's spec before building it
(section 9) and update it in the same PR as any change to its behaviour.

## Cross-cutting registers

| File | What it holds | Read by |
| --- | --- | --- |
| [feature-register.md](feature-register.md) | One row per Part A feature with phase, status and links to spec, code, tests and user docs; the measure of the definition of complete | Every session (section 20, item 9); `docs/plans/STATUS.md` |
| [rates.md](rates.md) | Statutory figures, thresholds, time limits and tenant defaults with validity dates, nation and source | Seed script for `rate_table` (parses the `## Rate table` section) |
| [retention.md](retention.md) | Retention periods and triggers per record class | Seed script for the retention engine (parses the `## Retention schedule` section) |
| [calendar.md](calendar.md) | UK bank holidays by nation (GOV.UK) for working-day clocks | Seed script for `bank_holiday` (parses the `## Bank holidays` section) |
| [data-standards.md](data-standards.md) | Mapping of Harbour fields to MODS, NHS Data Dictionary, SNOMED CT, ODS and PRSB About Me; the import and export contract | Import wizard, export, NHS integrations |

The three parsed tables (`## Rate table`, `## Retention schedule`, `## Bank holidays`) must keep their exact column order, one
header row and one separator row. Change the parser and the file in the same PR if the format ever has to
change.

## Module specs

| File | Bounded context | Master prompt sections | First phase | Status |
| --- | --- | --- | --- | --- |
| platform.md | `platform` | 4, 5, 9.1 | 0 | Written by the lead engineer in Phase 0 |
| people.md | `people` | 9.2, 18 | 0 (schema), 1 | Written by the lead engineer in Phase 0 |
| [care.md](care.md) | `care` | 10.1, 10.4 | 1 | Written for Phase 1 |
| [safety.md](safety.md) | `safety` | 11.1 | 1 | Written for Phase 1 |
| medicines.md | `medicines` | 10.2, 10.3 | 2 | Planned |
| quality.md | `quality` | 11.2 | 1 (inspector packs), 2 | Planned |
| workforce.md | `workforce` | 12.1, 12.2, 12.4 | 2 | Planned |
| scheduling.md | `scheduling` | 12.3 | 2 | Planned |
| operations.md | `operations` | 13 | 1 (downtime pack), 3 | Planned |
| finance.md | `finance` | 14 | 3 | Planned |
| [comms.md](comms.md) | `comms` | 15.1, 15.3 (communications) | 1 | Written for Phase 1 (slice 12: family feed, notifications, visit booking) |
| insights.md | `insights` | 15.2 | 1 | Planned |
| integrations.md | `integrations` | 15.3 | 0 (framework) | Planned |
| ai.md | `ai` | 16 | 6 | Planned |

Mobile behaviour (section 17) is specified inside each module's spec under "Offline behaviour", with
shared device rules in `docs/compliance/kiosk.md`.

## What every module spec contains

1. Purpose and the feature register IDs it covers.
2. Schema: tables, columns, enums, retention class per table (`retention.md`) and the data-standards
   mapping for any new personal data field (`data-standards.md`).
3. Permission matrix: `module.resource.action` permissions, default roles and scope rules (section 4).
4. Rules that are easy to get wrong, each with the table-driven test that proves it; statutory figures
   referenced by `rate_table` key, never as numbers.
5. API surface (OpenAPI operations) and domain events published on the outbox.
6. Offline behaviour and conflict handling where section 17 requires it.
7. Clinical safety: hazard IDs touched in `docs/clinical-safety/hazard-log.md` and the medical-device
   boundary check.
8. Data protection: records-of-processing entries, lawful basis, and any new sub-processor.
9. Acceptance criteria and test list, written before the code.
10. Open questions, each with the default taken and the ADR that records it.

## Related folders

- `docs/decisions/`: ADRs (MADR 4), including the Appendix defaults (ADR-0003 to ADR-0023).
- `docs/compliance/`: GDPR, security, accessibility and kiosk checklists, DPIA template, records of
  processing, medical-device boundary.
- `docs/clinical-safety/`: clinical risk management plan, hazard log, safety case per release.
- `docs/plans/`: phase plans, `STATUS.md` and human actions.
