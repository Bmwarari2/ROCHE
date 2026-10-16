# 2026-10-17: Slice 13 web, the DPIA page (PLAT-023)

- Web: `/settings/data-protection` shows where the DPIA stands (icon and word), what Harbour still
  needs and why a review is due; the owner sets the governance and names the lead; the Registered
  Manager answers, rates the risks and marks it ready to sign; the named lead signs with a typed
  name bound to the version's SHA-256. Step-up notices for naming a different lead and for
  signing. All strings through i18n (Welsh pending).
- Seed: the demo organisation has a CQC provider ID, so its DPIA can be signed.
- Docs: platform-completions.md section 10f, feature register, STATUS.

**Tests**: `apps/web/src/lib/dpia.test.ts` (9), `components/dpia/DpiaFeedback.test.tsx` (2),
`apps/web/e2e/dpia.spec.ts` (3, with axe on each state).

# 2026-10-17: The DPIA page, review of #89

- The signing form is offered only to the named lead who prepared none of the version; the draft
  form says each refusal at its field (a risk that stays high needs the ICO reference); the
  status card is its own component, checked with axe when not started with details missing and
  when a review is due; axe on the Registered Manager's view in the journey.
- `db:seed` refuses to seed the demo tenant in production unless `HARBOUR_SEED_DEMO=0`.
- Logged: the typed name is not checked against the signer's account.

**Tests**: `lib/dpia.test.ts` (7 more), `components/dpia/DpiaStatus.test.tsx` (2).
