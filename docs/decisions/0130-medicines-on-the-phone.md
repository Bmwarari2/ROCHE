---
status: "accepted"
date: 2026-11-06
decision-makers: engineering (Claude Code sessions), for the lead of Phase 2 batch 3b
consulted: clinical safety officer (HZ-002, HZ-003, HZ-113; H-1421 to H-1424)
informed: Registered Managers in the pilot
---

# Medicines on the phone: what syncs, and how the dm+d subset arrives

## Context and problem statement

Mobile slice 68 sends the medication round to phones (medicines.md section 13.8; master prompt
17.1). Logical replication bypasses row-level security, so the sync streams are the access
control, and stream queries cannot read the clock, compare a row with a token value except for
equality or `IN`, or join more than two tables. Three things the contract asked for do not fit
those limits: "no stopped version after its end", "administrations in the last 48 hours" and "the
dm+d subset and GTINs for those products".

## Decision drivers

- Safety of the person (HZ-002, HZ-003): a stop or an allergy must reach the phone first, and a
  medicine in force must never be missing from the round.
- Least privilege: only the people in the member's `medicines.emar.administer` scope, as the care
  streams do.
- The dm+d subset follows a chain (product, its replacements, AMPs, packs, barcodes, lookups) that
  `selectDmdDeviceSubset` already decides.

## Considered options

1. Streams only, with a sweep marking ended versions (a new column and a job).
2. Streams for the round, stopped versions included, and the dm+d subset from the API.
3. The whole round from the API, cached on the phone.

## Decision outcome

Option 2.
- **MAR entry versions**: every version not withdrawn or removed syncs with its person, a stopped
  or replaced one included, with `stop_at`, `stop_effective_at`, `replaced_by_id` and
  `replaced_from`; the phone judges the times. A change recorded today usually takes effect at
  00:00 tomorrow, so the replaced version still gives today's doses: filtering it out would take
  them off the round (clinical review, B1). A stop must reach the phone anyway, and nothing in
  force is ever filtered out for want of a clock. Their schedule times, dosing records and covert
  records follow the same versions only (a subquery on `medication`; security review, finding 1).
- **Administrations**: those recorded on a day of `meds_recent_days` (today and the 34 UTC days
  before, minted by the API), so the last given of a monthly or weekly medicine, an interval of up
  to 34 days and the 24-hour maximum are always on the phone (clinical review, M3; H-1421). A
  longer interval needs the server, which still checks every record when it arrives.
- **Priority**: the medicines streams and the allergy streams have priority 1, so a stop or an
  allergy change reaches the phone first whenever it syncs (HZ-002).
- **dm+d**: `GET /v1/medicines/device-subset` runs `selectDmdDeviceSubset` on the products named
  by the MAR entries of the people the medicines streams give the member, and the phone replaces
  its local-only copy whole, on connecting, when the products on its MAR entries change and at
  most hourly otherwise; a failed request keeps the last copy and records when it failed. National
  reference data, no personal data.
- **Competence**: the member's own medicines competence sign-offs and withdrawals, by their id.

### Consequences

- Good: no clock in the streams, no new column or job; the subset rule stays in one place.
- Good: a stopped medicine shows as stopped rather than vanishing.
- Bad: stopped and replaced versions accumulate on the phone with the person (dozens a year at
  most); the phone hides them once ended.
- Bad: 35 days of administrations is more on the phone than 48 hours; still only the member's
  people, under SQLCipher.
- Bad: the dm+d subset is as fresh as the last fetch; offline, the last subset stays and the phone
  says when it was fetched (slice 69).

## More information

Migration 0149; `packages/sync/src/streams/sync-config.yaml`; `medicines-streams.test.ts`;
`apps/api/src/services/dmd.ts` (`dmdDeviceRows`); `apps/mobile/src/medicines/dmd-subset.ts`.
Questions for people: H-1421 to H-1424.
