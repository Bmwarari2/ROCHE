# Breach register and data protection complaints (PLAT-022, Phase 2 slice 20)

Branch `feat/platform-breach-register`.

## What changed

- Spec: `platform.md` rules 18 to 26 (tables, rules, permission matrix, retention, test list).
- Database: migration 0082 (lane F; renumbered at merge) adds `dp_breach` and `dp_complaint`
  (versioned aggregates with record history, frozen once closed, awareness fixed once the ICO
  report is recorded), and `processor_breach_notice` and `processor_breach_notice_ack`
  (append-only). All have forced RLS, the tenant policy and `quality.dsar.manage` policies; the
  application cannot delete. Thapsus sends a notice only through the definer function
  `app.send_processor_breach_notice` (an active operator admin), which stores it, opens the
  organisation's register entry or links a follow-up, and writes the organisation's audit and
  outbox events.
- API (`quality.dsar.manage`, every read and change audited with ids and codes only):
  `/v1/data-protection/breaches` (list, record, view, facts, assessment, decision, ICO report,
  subject notice draft, individuals told, close), `/v1/data-protection/breach-notices/{id}/acknowledge`,
  `/v1/data-protection/complaints` (list, record, view, acknowledge, contact, close), and
  `/operator/breach-notices` for Thapsus admins with a fresh sign-in. The ICO clock
  (`ico.breach.report_hours`) and the complaint clocks (`dp_complaint.*`, bank holidays of the
  location's nation) are worked out on every read from the rate table, never stored. The assessment
  stores `assessBreach`'s suggestion as decision support; the decision goes through
  `checkBreachDecision`; a late report needs the reasons for the delay; a notice to the people
  affected comes from Harbour's template and is refused while a prompt remains; closing a complaint
  goes through `checkComplaintClosure`.
- Worker: a Thapsus notice tells the organisation's data protection lead and owners, urgently, once.
- Domain: `subjectNoticeDraft` and `noticeHasPrompts` (`breach-notice.ts`).
- Contracts and the generated client; the client generator now formats files over 1 MB.
- Export catalogue entries for the four tables; a complaint about a sample person stops sample data
  removal rather than being deleted with it.
- No web screens (slice 66).

## Clinical safety and data protection

- No clinical change: the hazard log is untouched (cross-tenant exposure is HZ-011, covered by the
  isolation tests).
- Records of processing: B13 (breaches and complaints). Data standards: a slice 20 section.
  Retention: interim `audit_event` until the DPO sets periods.

## Tests

- `packages/db/test/data-protection-registers.test.ts` (isolation, permission policies, checks,
  guards, append-only, the definer function); `rls-coverage`, `definer-acls` and `sample-data`
  updated.
- `apps/api/test/data-protection-registers.test.ts` (permissions, clocks, suggestion and decision
  refusals, late report, notice draft and prompts, closure, stale versions, audit without personal
  data, the Thapsus notice, the worker telling the lead and owners, complaints).
- `packages/domain/src/platform/breach-notice.test.ts`.

## Human actions logged

- H-670 retention periods; H-671 the Article 9 condition and the B13 rows; H-672 the notice
  template; H-673 who at Thapsus sends notices and the contractual target.
