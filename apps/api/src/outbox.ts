import { outboxEvent, type Transaction } from "@harbour/db";
import type { BoundedContext } from "@harbour/domain";

/**
 * Transactional outbox (section 6): modules publish domain events in the same transaction as the
 * change, and talk to each other only through these events, never through cross-module joins.
 * Payloads carry identifiers, not personal data.
 */
export interface DomainEvent {
  readonly context: BoundedContext;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Past tense, e.g. `people.break_glass_opened`. */
  readonly type: `${BoundedContext}.${string}`;
  readonly payload: Record<string, string | number | boolean | null>;
}

export async function publish(tx: Transaction, event: DomainEvent): Promise<void> {
  await tx.insert(outboxEvent).values({
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.type,
    payload: event.payload,
  });
}
