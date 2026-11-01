import { incident, incidentPerson, type Transaction } from "@harbour/db";
import { INCIDENT_WORKFLOW } from "@harbour/domain";
import { publish } from "../outbox";
import { classifyAndStore } from "./safety";
import { startWorkflow } from "./workflow";

/**
 * The safety module's side of a controlled drugs stock check that did not balance (medicines.md
 * 14.3; HZ-115): a medication incident, raised through the outbox so the medicines module never
 * writes safety's tables. The incident takes the stock check's id, so the event applied twice
 * raises one incident. Its words name no drug or count: the register page holds them.
 */
export async function raiseCdDiscrepancyIncident(
  tx: Transaction,
  tenantId: string,
  payload: {
    readonly stockCheckId: string;
    readonly personId: string;
    readonly locationId: string;
    readonly checkedBy: string;
    readonly checkedAt: string;
  },
  now: Date,
): Promise<boolean> {
  const [row] = await tx
    .insert(incident)
    .values({
      id: payload.stockCheckId,
      locationId: payload.locationId,
      type: "medication",
      occurredAt: new Date(payload.checkedAt),
      description:
        "A controlled drugs stock check did not match the register. The count, the balance and what was found are on the register page.",
      raisedBy: payload.checkedBy,
      personIds: [payload.personId],
    })
    .onConflictDoNothing()
    .returning({ id: incident.id, type: incident.type, locationId: incident.locationId });
  if (!row) return false;
  await tx.insert(incidentPerson).values({
    incidentId: row.id,
    kind: "service_user",
    role: "affected",
    personId: payload.personId,
    died: false,
    bodyMapMarkIds: [],
  });
  await startWorkflow(
    tx,
    tenantId,
    INCIDENT_WORKFLOW,
    { subjectType: "incident", subjectId: row.id, personId: null },
    now,
  );
  const outcome = await classifyAndStore(tx, {
    tenantId,
    incidentId: row.id,
    actorTenantUserId: null,
    now,
  });
  await publish(tx, {
    context: "safety",
    aggregateType: "incident",
    aggregateId: row.id,
    type: "safety.incident.recorded",
    payload: {
      incidentId: row.id,
      type: row.type,
      locationId: row.locationId,
      occurredAt: payload.checkedAt,
      lateEntry: false,
      notificationsDrafted: outcome.notificationsCreated,
    },
  });
  return true;
}
