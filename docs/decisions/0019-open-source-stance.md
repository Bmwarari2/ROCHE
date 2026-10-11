---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# Open source stance: the repository stays private

## Context and problem statement

Thapsus owns the codebase and licenses it per client. Open-sourcing parts (design tokens, regulatory
rule tables) could add credibility. Should any part be public?

## Considered options

- Keep the whole repository private.
- Open-source the design tokens and the regulatory rule tables.

## Decision outcome

Chosen option: "Keep the whole repository private", because it is the Appendix default.

### Consequences

- Good, because the commercial position and any security-sensitive configuration stay private.
- Neutral: code is structured so the tokens (`packages/ui` tokens) and rule tables (`docs/specs/rates.md`,
  `docs/specs/retention.md`) could be published later without exposing anything else; they never contain
  personal data or secrets.
- Bad, because external contributors and auditors need granted access to review code.

## More information

- Takes effect: any time.
- How to change: supersede this ADR naming what is published and under which licence.
