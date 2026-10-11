---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# Product name: Harbour as the working name

## Context and problem statement

The master prompt calls the product "Harbour" and says it is a working codename to be replaced with the
final product name before the first external release (Part A assumptions; Appendix, "Product name and
domain"). The build cannot wait for a naming decision, but the name must be cheap to change later.

## Decision drivers

- The build starts in Phase 0 and must not pause for a decision only Brian can make.
- A UK trade mark search and app store name availability check are human actions.
- Renaming must not mean touching hundreds of files or breaking package imports.

## Considered options

- Keep "Harbour" as the working name and rename before the first external release.
- Choose a final name now.

## Decision outcome

Chosen option: "Keep Harbour as the working name", because it is the Appendix default and lets the
build proceed while Brian runs the trade mark and store checks.

### Consequences

- Good, because nothing waits on naming.
- Bad, because a later rename touches user-facing copy, store listings, domains and documentation.
- To keep that cheap: the product name shown to users comes from one i18n message (`product.name`)
  and the tenant white-label settings, never from string literals in components; internal package scope
  `@harbour/*` and code identifiers may keep the codename because users never see them.

### Confirmation

A pre-release checklist item in `docs/runbooks/` (release) searches user-facing copy for the codename
before the first external release.

## More information

- Takes effect: Phase 0.
- Human actions (logged in `docs/plans/human-actions.md`): UK IPO trade mark search, App Store and Google
  Play name availability, product domain registration.
- How to change: tell Claude Code the final name or edit this ADR; a superseding ADR records the new
  name and the rename is done as one `chore` PR.
