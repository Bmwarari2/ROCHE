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
export function raiseCdDiscrepancyIncident(
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
  return raiseMedicationIncident(
    tx,
    tenantId,
    {
      id: payload.stockCheckId,
      personId: payload.personId,
      locationId: payload.locationId,
      raisedBy: payload.checkedBy,
      occurredAt: payload.checkedAt,
      description:
        "A controlled drugs stock check did not match the register. The count, the balance and what was found are on the register page.",
    },
    now,
  );
}

/**
 * The double-dose side of conflict review (medicines.md 15.5; HZ-004; slice 48): the nurse in
 * charge found a dose was given twice on two devices. The incident takes the conflict's id, so the
 * event applied twice raises one incident. Its words name no medicine: the conflict holds both
 * records.
 */
export function raiseDoubleDoseIncident(
  tx: Transaction,
  tenantId: string,
  payload: {
    readonly conflictId: string;
    readonly personId: string;
    readonly locationId: string;
    readonly resolvedBy: string;
    readonly dueAt: string;
  },
  now: Date,
): Promise<boolean> {
  return raiseMedicationIncident(
    tx,
    tenantId,
    {
      id: payload.conflictId,
      personId: payload.personId,
      locationId: payload.locationId,
      raisedBy: payload.resolvedBy,
      occurredAt: payload.dueAt,
      description:
        "A dose was recorded as given on two devices and the nurse in charge found it was given twice. Both records are on the conflict review page.",
    },
    now,
  );
}

/** A medication incident for one person, raised once per id, with its workflow and notifications. */
async function raiseMedicationIncident(
  tx: Transaction,
  tenantId: string,
  e: {
    readonly id: string;
    readonly personId: string;
    readonly locationId: string;
    readonly raisedBy: string;
    readonly occurredAt: string;
    readonly description: string;
  },
  now: Date,
): Promise<boolean> {
  const [row] = await tx
    .insert(incident)
    .values({
      id: e.id,
      locationId: e.locationId,
      type: "medication",
      occurredAt: new Date(e.occurredAt),
      description: e.description,
      raisedBy: e.raisedBy,
      personIds: [e.personId],
    })
    .onConflictDoNothing()
    .returning({ id: incident.id, type: incident.type, locationId: incident.locationId });
  if (!row) return false;
  await tx.insert(incidentPerson).values({
    incidentId: row.id,
    kind: "service_user",
    role: "affected",
    personId: e.personId,
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
      occurredAt: e.occurredAt,
      lateEntry: false,
      notificationsDrafted: outcome.notificationsCreated,
    },
  });
  return true;
}
