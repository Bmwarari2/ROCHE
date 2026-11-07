# Phase 2 merge batch 3c (migrations 0141 to 0144)

Branch `integration/phase-2-batch-3c`, from batch 3b's head (4c2decb1). Main is merged in once
batch 3b (#172) is on `main`, and the PR opens then.

## What changed

- Merged in number order: `feat/integrations-hr-link-rota` (slices 87 and 88, migrations 0141 and
  0142), `feat/meds-prn-protocols` (slice 28, 0143) and `feat/meds-phase1-outputs` (slice 49,
  built as 0145, renumbered to 0144: file, journal, tag, snapshot and every reference).
- `feat/platform-member-lifecycle` (built as 0144) is left out (lead decision). It is a second
  design of H-566 beside 3b's migration 0129 (`app.change_membership`, the membership guard trigger
  and policy): merging both would put two status triggers and two change paths on `tenant_user`.
  Its new parts are deferred, to be reworked onto 0129's `change_membership` design in a later
  slice with a security re-review: sign-in erasure scheduling, `status_changed_at`, giving back a
  member who has left (0129 reinstates only a suspended member), and H-1395 (closing a lost or
  wiped device's hold).
- 0144, the highest migration, restates `app.sample_removal_tables()` as the union of every list:
  0140's 92 tables with 0143's `prn_outcome` and `prn_protocol` first, as children of the medicines
  they reference. Snapshots 0141 to 0144 chained; the latest equals the schema.
- Code conflicts merged three-way after formatting both sides alike; the branches' own files are
  formatted with the repository's Biome settings.
- The HR link's routes are registered before the generic `/v1/integrations/{port}` routes, which
  had taken `/v1/integrations/hr-link` as a port and refused disconnecting (422).
- HZ-133 is the HR branch's entry (it supersedes slice 86's rows that 3b carried), with the batch
  3c rule 8 change; the clinical review caught an earlier merge that kept both sets of rows.
- Hazard log merged section by section: HZ-117 (slice 28) joins the one list of hazards at target
  residual risk 3 (now twenty-seven); the branches' older copies of that list and of the HZ-119
  and HZ-133 index rows are dropped for 3b's.
- Slice 28 checked against 3b's when-required rule (a new or changed entry needs its 24-hour
  maximum): a PRN protocol shows the entry's own limits and never copies or relaxes them, so a
  missing maximum can only be an entry recorded before 0123, shown as such.
- New CSO items from slice 28 (H-1380 to H-1384, H-1386, H-1388, H-1389) read "Owner-accepted
  recommendation, pending CSO review at the testing phase". None is a CSO signature, and no
  safety case or gate is marked signed (H-20).

## Decision: withdrawing an HR leaving after access has ended

The HR link's rule 8 set a member who had left back to active from the application role. 3b's
0129 refuses that and makes leaving final, so (lead decision) the withdrawal is now refused once
access has ended, with a 409 `hr_link_access_ended` that says to ask someone who manages members
across the organisation to reinstate the member once reinstatement exists, and until then to invite
them again. Before access ends it works as before. Giving access back is the member lifecycle
rework's, on `app.change_membership`.

Until that lands, Thapsus-HR can show a person active while Harbour shows them left. That is the
fail-safe direction (no access is given back); HZ-133 records it, with a test.

Since nothing reinstates a leaver now, 0142's relink path (`app.end_relinked_leaver_access`, which
took neither 0129's membership lock nor the link condition) has no caller: 0144 revokes it from the
app role and the leaver sweep no longer calls it; 0144 also pins `pg_temp` last on 0142's two
definer functions (security review). The member lifecycle rework brings back whatever it needs.

## Tests

- Lint and typecheck clean; database tests 1520 of 1520 on a private Postgres; the HR link, PRN
  protocol and outputs API tests pass. Full suites and Playwright: see the PR.

## Follow-ups

Tracked as H-1471 to H-1480 in `docs/plans/human-actions.md` (the CSO items H-1476 and H-1477 carry
the owner-accepted recommendation wording). `MEDICINES_OUTPUT_HISTORY_DAYS` in `.env.example` is
the lead's.

- `MEDICINES_OUTPUT_HISTORY_DAYS` (optional, default 35) still needs a line in `.env.example`: this
  session's permissions do not reach that file.
- Security review (non-blocking, open): the HR webhook's per-tenant throttle is charged before the
  signature is checked, and `clientIp` trusts the leftmost `X-Forwarded-For`, so an unsigned flood
  could use up a tenant's bucket (the 5-minute reconciliation bounds the harm). Charge the tenant
  bucket only for signed requests and take the address from the trusted proxy hop.
- Deploy 0143 and 0144 together: 0143's sample removal list is short (72 tables) until 0144 restates
  the union.
- `medicines.md` still has two sections 14, four sections 15 and two sections 16; renumber in one
  docs pass with their references.
- Accessibility review (non-blocking): no Playwright journey or page-level axe scan yet for the HR
  link's staleness note (jsdom axe and Storybook only); the note's title is a paragraph, not a
  heading or region, so heading and landmark navigation skip it; the transfer pack still prints
  `TIME-CRITICAL:` in capitals where the downtime pack says "(time-critical)"; the PDF medicine
  lines are English literals, not ICU strings.
- Clinical review (non-blocking, for the CSO): a PRN protocol on an entry recorded before 0123 with
  no 24-hour maximum shows none without words (H-1381: say "No most in 24 hours recorded on the
  entry", or refuse until the entry is corrected); a refused dose reaches handover as "Refused: a
  medicine", naming the person but not the medicine (check under HZ-003).
- `docs/specs/retention.md` has several overlapping `medication…` rows from batch 3b's merges;
  fold them into one.
