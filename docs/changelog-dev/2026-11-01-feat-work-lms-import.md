# 1 November 2026: imports of external training records (slice 78; WORK-006; ADR-0102)

Branch `feat/work-lms-import`, from `feat/work-training-competence` (already in `main`). Migration
0132. Human actions H-1250 to H-1255.

- **Spec:** [workforce.md](../specs/workforce.md) section 13. **ADR:** ADR-0102 (a staged import,
  dry run first, learners matched by stable id; the learning platform is the organisation's own
  processor, per H-520's recommended answer).
- **Domain:** `packages/domain/src/workforce/lms-import.ts`, table-driven. It covers:
  - dates, record ids and row checks that keep no failed value;
  - CSV by heading (names and emails ignored) and JSON;
  - each row's class: ready, unmatched learner, unmapped course, already recorded, own record or
    invalid;
  - the dry run's fingerprint.
- **Database (0132):**
  - `lms_source`: an API source's secret is named by the database.
  - `lms_course_map` and `lms_learner_link`: one live link each way, made by a person for someone
    else.
  - `lms_import` and `lms_import_row`: dry runs count up one at a time; rows are resolved once.
  - `training_record.source`: an imported record is made only from a ready row, exactly as it
    says, is unique per platform record and is fixed afterwards. A Harbour record is never changed.
  - A `training_certificate` document category, read as its record is.
  - Forced RLS for holders of `workforce.training.manage`.
- **API:**
  - The `/v1/workforce/lms-sources` and `/v1/workforce/lms-imports` routes, for staging, dry runs,
    commits naming their dry run, skips and discards.
  - The certificate upload route, with the malware scan.
  - Audit with ids and counts only.
- **Learning platform port:** `LearningPlatformAdapter`, with a contract-tested mock
  (`LMS_API=mock`). It is off by default, and production must be `off` until a live client exists
  (H-1250).
- **Docs:** HZ-124 gains a cause, a control and tests. Records of processing (B3), the
  sub-processor notes (the organisation's own processors), data standards and the feature register
  are updated.

## Not built

- The live learning platform client (H-1250).
- xAPI statement imports (H-1251).
- Screens (H-1252).
- Verified file headings (H-1253).
