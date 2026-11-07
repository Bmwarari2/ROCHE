# The plan for the Thapsus Care rename (ADR-0127)

- ADR-0127 (proposed): the product is called Thapsus Care wherever people read it; "Harbour" stays in
  technical identifiers (packages, environment variables, database roles, the tenant header, the
  deep link scheme, bundle ids, the passkey relying party id, cloud resources and Terraform), code
  comments, migrations and frozen history.
- `docs/plans/rename-thapsus-care.md`: the inventory (2,817 occurrences in 356 files on `main` at
  e02aead7), what stays and why, stored rows that carry the name (audit starter templates, rate
  table and retention sources), the one-pass procedure for after merge batch 4, artefacts to
  refresh (no screenshot baselines are committed; app store listings, Storybook, Lighthouse), human
  actions, and the trial run's results.
- `scripts/rename-product.mjs`: a dry run by default, `--apply` to rename and `--check` for CI. It
  touches only the capitalised whole word, and skips demo names, host names and URLs, comments and
  the lines left for a hand edit.
- No user-facing words change in this branch.
