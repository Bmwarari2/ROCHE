---
status: accepted; partly superseded by ADR-0098
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# Company set-up items: start in Phase 0 as human actions

> **Partly superseded by [ADR-0098](0098-production-on-google-cloud.md) (production on Google
> Cloud), 31/10/2026**: the AWS dev account with an OIDC deployment role, which becomes the Google
> Cloud organisation, Harbour folder and per-environment projects with Workload Identity Federation
> for GitHub Actions (H-04), self-hosted in europe-west2. The text below is kept as decided.

## Context and problem statement

Several accounts, certifications and policies take weeks to arrange and only a person at Thapsus can
apply for them. The build must not wait for them, but late starts would delay the first real tenant.

## Decision drivers

- Lead times of days to weeks (D-U-N-S number, store enrolment, certification bookings).
- The build never waits for people; it logs human actions and continues.

## Considered options

- Start the items when each first becomes necessary.
- Start all of them in Phase 0.

## Decision outcome

Chosen option: "Start in Phase 0", because it is the Appendix default and lead times are weeks. Each
item is logged in `docs/plans/human-actions.md` with what the build produced for it:

- Apple Developer Program and Google Play Console in the name of Thapsus Cargo Ltd (Apple needs a
  D-U-N-S number).
- Cyber Essentials, then Cyber Essentials Plus (control evidence in `docs/compliance/`).
- Cyber and professional indemnity insurance.
- NHSmail and the Data Security and Protection Toolkit for Thapsus as an IT supplier.
- Pre-kickoff provisioning from section 20: GitHub organisation and repository with a bot identity for
  Claude Code, AWS dev account with an OIDC deployment role, commit-signing key, Expo (EAS) account,
  product domain, Grafana Cloud (UK), Sentry (EU) and a status-page account; Flagsmith and PowerSync
  hosting decisions (defaults: both self-hosted in eu-west-2, ADR-0001).

### Consequences

- Good, because the items are in progress by the Phase 1 gate.
- Bad, because some costs (insurance, certification, developer programmes) are incurred before revenue.
- Where an account is missing when the build reaches it, the build writes the configuration, builds
  against a mock, opens a blocking issue and continues.

## More information

- Takes effect: Phase 1 gate.
- How to change: supersede this ADR to defer specific items, recording the risk.
