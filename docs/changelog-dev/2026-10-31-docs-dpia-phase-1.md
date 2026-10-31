# Phase 1 gate: DPIA Phase 1 risks and data-standards rows (PLAT-023)

Branch `docs/dpia-phase-1`, PR not yet opened.

## What changed

- DPIA template: risks R13 to R19 for the Phase 1 residential processing (evidence packs, bulk
  copies, search and break-glass, letters, statutory notifications, capacity and DoLS, sample data)
  in sections 6 and 7, and a new section 7A. It sets out the lawful bases (never consent for care
  records) and, for each kind of Phase 1 processing, the risks, the measures built with their code
  and document paths, the expected residual risk and what the controller decides. Provider fields
  are marked "Tenant completes".
- Domain: `PHASE_1_RISKS` in `packages/domain/src/platform/dpia.ts`, so every tenant's in-app
  DPIA carries R13 to R19 after any optional processing's risk; `dpia.test.ts` checks the ids and
  wording against the template.
- Data standards: "Phase 1 tables completed for the gate" covers `admission_condition`,
  `welcome_checklist_item`, `key_issue`, `document_signature`, `legal_hold`, `workflow_instance`,
  `letter_template_version` and `notification_preference`, each with its fields, classification,
  retention class and coding. The DPIA risk ids now read R1 to R19.
- Records of processing: staff notification preferences (`notification_preference`) named under
  notifications and deliveries.
- platform-completions.md rule 17 names R13 to R19. The Phase 1 gate report marks both
  data-protection items done.

## What is next

- Each tenant's DPO rates and signs the new risks in-app (H-382).

## Human actions logged

- H-382.

## Tests

- `packages/domain/src/platform/dpia.test.ts` (updated: the prefill's risk ids, the template's
  ids and wording for all 19 risks, and the optional risks before the Phase 1 ones).

## Review rounds

- None yet.
