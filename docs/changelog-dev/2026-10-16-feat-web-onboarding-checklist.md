# 2026-10-17: Slice 13 web, the onboarding checklist page (PLAT-018)

- Web: `/settings/onboarding` ("Getting started") shows progress, what blocks go-live and each
  item as an icon and words with its reason; people still outstanding link to their records with
  what they lack. The owner accepts settings, decides retention, chooses the staff file option
  and records the DCB0160 assessment on the page; refusals show the API's words (also for a
  refused DPIA signature).
- Docs: platform-completions.md section 10g, feature register, STATUS.

**Tests**: `apps/web/src/lib/onboarding.test.ts` (13), `apps/web/e2e/onboarding.spec.ts` (2, with
axe on each state).

# 2026-10-17: The onboarding checklist page, review of #90

- Each setting shows the figure being accepted (the checklist response gains `settings`).
- A clinical setting is accepted, and DCB0160 recorded, only naming the clinical lead or CSO who
  reviewed or assessed it (`reviewedBy`, `assessedBy`: active members, in the audit event;
  `reviewer_required`, `reviewer_not_member`; HZ-027), with a confirmation step on the page.
- People links meet the 44 px target. Logged: raw keys and English reasons before Welsh or a
  pilot; the reviewer is kept in the audit event, not yet in the decision tables.

**Tests**: domain reviewer tables (6), `onboarding-decisions.test.ts` (clinical reviewer, DCB0160
assessor), the journey (a clinical setting refused without its reviewer, then accepted).
