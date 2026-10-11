---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# Design partner: none yet, build against a demo tenant only

## Context and problem statement

A real care home or agency using staging weekly would keep the product grounded in a Tuesday night
shift rather than only in the regulations. No design partner has signed a pilot agreement yet.

## Decision drivers

- The build must not wait for a partner to be recruited.
- Without real users, usability risk rises; scripted, realistic demo data reduces it.
- No real personal data may enter fixtures or demo data.

## Considered options

- Recruit a design-partner provider before Phase 1 and pause until one signs.
- Build against a seeded demo tenant only, and onboard a partner whenever one signs.

## Decision outcome

Chosen option: "Build against a demo tenant only", because it is the Appendix default and the build
never waits for people.

### Consequences

- Good, because the build proceeds and the demo tenant doubles as the sales demo.
- Bad, because workflows are validated against regulations and guidance rather than observed shifts;
  usability findings arrive later.
- Mitigation: the seeded demo data follows the definition of complete (a 60-bed nursing home, a
  300-hour-a-week home-care agency, supported living, a day service, a Welsh tenant and a children's
  home) with fictitious people only, and each phase ends with a scripted walkthrough in `docs/demo/`.
- The Phase 1 human follow-up "design-partner home runs a day on two phones and a tablet" stays open in
  `docs/plans/human-actions.md`.

## More information

- Takes effect: Phase 1.
- Human action: recruit a design partner and sign a pilot agreement (with a data processing agreement)
  before any real data enters staging.
- How to change: when a partner signs, supersede this ADR with the partner's onboarding plan (staging
  tenant, weekly feedback cadence, which features they pilot).
