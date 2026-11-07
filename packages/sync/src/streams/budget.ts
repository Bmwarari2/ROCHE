/**
 * Buckets per connection (ADR-0134; HZ-002, HZ-138). PowerSync refuses a connection whose buckets
 * pass `max_buckets_per_connection` in infra/powersync/powersync.yaml, and the phone then gets no
 * fresh data at all, out of sight. The API estimates a token's buckets before it signs it and,
 * above the limit, refuses it by name (`sync_scope_too_large`), so the phone shows a failed sync.
 *
 * The estimate is an upper bound, from the shape of the streams: each whole home costs a bucket a
 * day for each of the entries, the round and the handover, and the member's own acknowledgements
 * a bucket a ten-day block, and each pair of its homes a bucket a block for the items about
 * someone who moved between them; each person a whole home carries costs one for their allergies and one
 * for their care reference (with a margin); each assigned person one each for their identity,
 * allergies and care reference, and one a block for their entries, tasks and handover items, and
 * for each whole home's handovers they may appear in. packages/sync/test/bucket-budget.test.ts
 * checks it is never below what the real stream engine makes.
 */

/** PowerSync's `max_buckets_per_connection`, as set in infra/powersync/powersync.yaml. */
export const SYNC_BUCKET_LIMIT = 1000;

export interface BucketEstimateInput {
  /** Days of the offline window (`offline_days`). */
  readonly days: number;
  /** Ten-day blocks of the window (`offline_blocks`). */
  readonly blocks: number;
  /** Shift days (`shift_days`), for the member's own shifts and clock events. */
  readonly shiftDays: number;
  /** Homes each whole-home family reaches. */
  readonly entriesHomes: number;
  readonly careHomes: number;
  readonly handoverHomes: number;
  /** People receiving care at the homes the people or care family reaches whole. */
  readonly wholePeople: number;
  /** People the member is assigned to, when any family's assigned streams are on. */
  readonly assignedPeople: number;
  /** Homes where those people live (the handovers a limited reader opens). */
  readonly assignedHomes: number;
  /** Homes the medicines family reaches whole (`meds_location_ids`), and its days and blocks. */
  readonly medsHomes?: number;
  readonly medsDays?: number;
  readonly medsBlocks?: number;
  /** People the medicines family reaches as assigned (`meds_assigned`). */
  readonly medsAssignedPeople?: number;
  /** People receiving care at the homes the medicines family reaches whole. */
  readonly medsPeople?: number;
}

export function estimateBuckets(input: BucketEstimateInput): number {
  const { days, blocks } = input;
  const fixed = 4 + input.shiftDays;
  const wholeHomes =
    days * (input.entriesHomes + input.careHomes + input.handoverHomes) +
    blocks * (input.handoverHomes + 1) +
    // Items about someone who moved between two of the member's homes: a bucket per pair a block.
    blocks * input.handoverHomes * input.handoverHomes;
  const medsHomes = input.medsHomes ?? 0;
  // Allergies and care reference, and a margin.
  const wholePeople = 3 * input.wholePeople;
  // Administrations a bucket a home and block; the member's own competence one.
  const meds =
    medsHomes * (input.medsBlocks ?? 0) +
    // A person's MAR entries at the homes the medicines family reaches whole: a bucket each.
    (input.medsPeople ?? 0) +
    (input.medsAssignedPeople ?? 0) * (1 + (input.medsBlocks ?? 0)) +
    1;
  const assigned =
    input.assignedPeople > 0
      ? input.assignedPeople * (4 + blocks * (3 + input.handoverHomes)) +
        blocks * (3 + input.assignedHomes)
      : blocks;
  return fixed + wholeHomes + wholePeople + assigned + meds;
}
