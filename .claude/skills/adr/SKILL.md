---
name: adr
description: Record an architecture or product decision as a MADR 4.0 ADR in docs/decisions, including Appendix defaults, deviations from the master prompt and regulation-versus-spec conflicts.
---

# New ADR

1. Copy `docs/decisions/template.md` to `docs/decisions/NNNN-short-title.md` with the next free number.
2. Fill every section: context and problem, decision drivers, options considered, outcome,
   consequences (good, bad, neutral), confirmation (how we know it holds), more information.
3. `status`: `proposed` when someone (CSO, DPO, Brian) must accept it, otherwise `accepted`.
4. Never rewrite an accepted outcome: supersede it with a new ADR and mark the old one
   `superseded by ADR-NNNN`.
5. Add the row to the index in `docs/decisions/README.md` in the same PR. If a person must act, add the
   item to `docs/plans/human-actions.md`.
