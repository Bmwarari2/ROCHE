/**
 * Buckets per connection (ADR-0134; HZ-002, HZ-138). PowerSync refuses a connection whose buckets
 * pass `max_buckets_per_connection` in infra/powersync/powersync.yaml, and the phone then gets no
 * fresh data at all. The API estimates a token's buckets before it signs it and narrows the
 * whole-home reach to the homes the member works at when the estimate passes the limit, so a phone
 * at a large group is never refused outright.
 *
 * The estimate is an upper bound, from the shape of the streams: each whole home costs a bucket a
 * day for each of the entries, the round and the handover, and the member's own acknowledgements
 * a bucket a ten-day block; each person a whole home carries costs one for their allergies and one
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
}

export function estimateBuckets(input: BucketEstimateInput): number {
  const { days, blocks } = input;
  const fixed = 4 + input.shiftDays;
  const wholeHomes =
    days * (input.entriesHomes + input.careHomes + input.handoverHomes) +
    blocks * (input.handoverHomes + 1);
  const wholePeople = 3 * input.wholePeople;
  const assigned =
    input.assignedPeople > 0
      ? input.assignedPeople * (4 + blocks * (3 + input.handoverHomes)) +
        blocks * (3 + input.assignedHomes)
      : blocks;
  return fixed + wholeHomes + wholePeople + assigned;
}
