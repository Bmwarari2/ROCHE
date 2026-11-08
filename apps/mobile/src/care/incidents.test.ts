import { CreateIncident, IncidentType } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { toIncidentUpload } from "../sync/incident-upload";
import type { EntryContext } from "./entries";
import {
  checkIncident,
  INCIDENT_TEXT_LIMITS,
  INCIDENT_TYPES,
  type IncidentDraft,
  queuedIncidentsFor,
} from "./incidents";

const NOW = new Date("2026-11-08T10:00:00Z");
const ID = "0199d000-0000-7000-8000-000000000e01";
const context: EntryContext = {
  tenantId: "00000000-0000-4000-8000-0000000000a1",
  personId: "00000000-0000-4000-8000-0000000000b1",
  locationId: "00000000-0000-4000-8000-0000000000c1",
  userId: "00000000-0000-4000-8000-0000000000d1",
  windowDays: 7,
  clockToleranceMinutes: 5,
  newId: () => ID,
};

const draft = (overrides: Partial<IncidentDraft> = {}): IncidentDraft => ({
  type: "fall",
  when: { kind: "now" },
  description: "  Found Ada Example on the floor by her bed.  ",
  immediateActions: "",
  emergencyServices: "no",
  gp: "not_known",
  ...overrides,
});

function body(d: IncidentDraft = draft()) {
  const result = checkIncident(d, context, NOW);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return { row: result.row, body: JSON.parse(result.row.body) as Record<string, unknown> };
}

describe("reporting an incident on the phone", () => {
  it("offers every incident type the API takes, in its order", () => {
    expect(INCIDENT_TYPES).toEqual(IncidentType.options);
  });

  it("keeps the API's text limits", () => {
    const shape = CreateIncident.shape;
    expect(shape.description.safeParse("a".repeat(INCIDENT_TEXT_LIMITS.max)).success).toBe(true);
    expect(shape.description.safeParse("a".repeat(INCIDENT_TEXT_LIMITS.max + 1)).success).toBe(
      false,
    );
    expect(shape.description.safeParse("ab").success).toBe(false);
  });

  it("queues the API's own body under the device id, with the person as affected", () => {
    const { row, body: sent } = body();
    expect(row).toMatchObject({
      id: ID,
      tenant_id: context.tenantId,
      person_id: context.personId,
      queued_at: NOW.toISOString(),
    });
    expect(CreateIncident.parse(sent)).toMatchObject({
      id: ID,
      locationId: context.locationId,
      type: "fall",
      occurredAt: NOW.toISOString(),
      deviceTime: NOW.toISOString(),
      description: "Found Ada Example on the floor by her bed.",
      people: [{ kind: "service_user", role: "affected", personId: context.personId }],
      answers: [],
    });
    expect(sent).not.toHaveProperty("immediateActions");
  });

  // HZ-090: "Not known yet" is sent as null, never as a guessed yes or no.
  it.each([
    ["yes", true],
    ["no", false],
    ["not_known", null],
  ] as const)("sends the answer %s as %s", (answer, expected) => {
    const { body: sent } = body(draft({ emergencyServices: answer, gp: answer }));
    expect(sent.emergencyServicesCalled).toBe(expected);
    expect(sent.gpContacted).toBe(expected);
  });

  it.each([
    ["no type", { type: null }, "type", "mobile.form.choose"],
    [
      "too short a description",
      { description: " ab " },
      "description",
      "mobile.incident.descriptionTooShort",
    ],
    [
      "too long a description",
      { description: "a".repeat(INCIDENT_TEXT_LIMITS.max + 1) },
      "description",
      "mobile.incident.tooLong",
    ],
    [
      "too long an immediate action",
      { immediateActions: "a".repeat(INCIDENT_TEXT_LIMITS.max + 1) },
      "immediateActions",
      "mobile.incident.tooLong",
    ],
    [
      "no emergency services answer",
      { emergencyServices: null },
      "emergencyServices",
      "mobile.form.choose",
    ],
    ["no GP answer", { gp: null }, "gp", "mobile.form.choose"],
  ] as const)("refuses %s", (_, overrides, field, key) => {
    const result = checkIncident(draft(overrides as Partial<IncidentDraft>), context, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field]?.key).toBe(key);
  });

  it("refuses a time later than now beyond the tolerance (HZ-017)", () => {
    const result = checkIncident(
      draft({ when: { kind: "earlier", daysAgo: 0, time: "11:30" } }),
      context,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.when).toBeDefined();
  });

  it("cannot be saved for a person whose home is not on the phone", () => {
    const result = checkIncident(draft(), { ...context, locationId: null }, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.location?.key).toBe("mobile.incident.noLocation");
  });

  it("uploads as the queued body, which the API's schema accepts", () => {
    const { row } = body();
    const request = toIncidentUpload({
      op: "PUT",
      table: "incident_outbox",
      id: row.id,
      opData: { ...row },
    });
    expect(request.kind).toBe("request");
    if (request.kind === "request") {
      expect(request.path).toBe("/v1/incidents");
      expect(request.personId).toBe(context.personId);
      expect(CreateIncident.safeParse(request.body).success).toBe(true);
    }
  });

  it.each([
    ["a body for another id", { body: JSON.stringify({ ...body().body, id: context.tenantId }) }],
    ["an unreadable body", { body: "{" }],
    ["no tenant", { tenant_id: null }],
    ["no location", { body: JSON.stringify({ ...body().body, locationId: undefined }) }],
  ])("refuses to send %s, in words", (_, change) => {
    const { row } = body();
    const request = toIncidentUpload({
      op: "PUT",
      table: "incident_outbox",
      id: row.id,
      opData: { ...row, ...change } as Record<string, unknown>,
    });
    expect(request).toMatchObject({ kind: "refused", code: "incident_unreadable" });
  });

  it("lists the reports waiting to send about this person in this tenant only", () => {
    const { row } = body();
    const queued = (data: Record<string, unknown>, id = ID) =>
      ({ data: JSON.stringify({ op: "PUT", type: "incident_outbox", id, data }) }) as const;
    const rows = [
      queued({ ...row }),
      queued({ ...row, person_id: "00000000-0000-4000-8000-0000000000b2" }, "other-person"),
      queued({ ...row, tenant_id: "00000000-0000-4000-8000-0000000000a2" }, "other-tenant"),
      { data: JSON.stringify({ op: "PUT", type: "care_note", id: "note", data: { ...row } }) },
      { data: "{" },
      { data: null },
    ];
    expect(queuedIncidentsFor(rows, context.tenantId, context.personId)).toEqual([
      { id: ID, type: "fall", occurredAt: NOW.toISOString() },
    ]);
  });
});
