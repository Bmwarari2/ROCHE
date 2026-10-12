# Lane B: web (slice 9, the person record and its views)

Scope over the lane (`docs/plans/phase-1.md` slice 9; STATUS "Next items"):

- the MCA and DoLS tab; incidents and notification screens;
- round and handover views; devices and revocation;
- refused copies on the review task, "Sent by", the escalation policy and coded reason settings;
- deletion flags; role dashboards (INSI-001); branding (PLAT-002).

Every screen gets a Playwright journey with axe (zero serious) in `apps/web/e2e`, plus unit tests
for its view logic in `apps/web/src/lib`. The web tier never opens a database connection; it uses
the typed API client in `@harbour/contracts`. Screens offer no form the API would refuse: follow
`access.reaching` and the person's `access` block exactly as the existing tabs do (ADR-0071).
Read `packages/ui/CONTENT.md` and use only `@harbour/ui` components and tokens.

Use the `accessibility-reviewer` checklist in `.claude/agents/accessibility-reviewer.md` as your
own pre-push check (44 px targets, visible focus, status as icon plus word, labels, headings,
200% text, reduced motion, dd/mm/yyyy and 24-hour times, en-GB and Welsh catalogues).

You are the only lane allowed to run Playwright locally: run only your own spec(s), e.g.
`pnpm --filter @harbour/web test:e2e -- e2e/<your-spec>.spec.ts`, after preparing the database as
`docs/runbooks/local-development.md` and the e2e job in `.github/workflows/ci.yml` do. It resets
the shared `harbour` database and uses ports 3000 and 4000.

## Your first PR now: the MCA and DoLS tab

Branch `feat/web-mca-tab`. A person record tab for consent, mental capacity (two-stage
assessment), best-interests decisions and the DoLS register, on the API already on `main`
(`apps/api/src/routes/mca.ts`; spec `docs/specs/care.md` and the MCA spec sections it links;
CARE-021, CARE-022). Read views with history and status (icon plus word), the create forms the
viewer's permissions allow, DoLS expiry clocks shown in words and dates. Follow the patterns of
the existing tabs (`apps/web/src/app/(shell)/people/[id]/*`). If the API lacks something the
screen needs, do not change the API: show what exists and log the gap as a STATUS follow-up.

Then the incidents and notification screens, as the next PR.
