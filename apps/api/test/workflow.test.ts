import {
  createDatabase,
  createPool,
  type Database,
  withRequestContext,
  workflowTransition,
} from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { defineWorkflow } from "@harbour/domain";
import { asc, eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { moveWorkflow, startWorkflow, WorkflowMoveRefused } from "../src/services/workflow";
import { createHarness, type Harness } from "./support/harness";

let h: Harness;
let appPool: pg.Pool;
let db: Database;

const review = defineWorkflow<"open" | "review" | "closed">({
  key: "test.review",
  version: 1,
  states: ["open", "review", "closed"],
  initial: "open",
  terminal: ["closed"],
  transitions: [
    { from: "open", to: "review", permission: "safety.incident.manage" },
    {
      from: "review",
      to: "closed",
      permission: "safety.incident.manage",
      requiresReason: true,
      distinctFromCreator: true,
    },
  ],
  // Hours for the first state; a rate-table figure (in days) for the review.
  sla: { open: { hours: 24 }, review: { rateKey: "care_plan.initial_working_days", unit: "days" } },
});

const resident = "0194d000-0000-7000-8600-000000000001";
const permissions = new Set(["safety.incident.manage"]);
const as = (userId: string) => ({
  tenantId: DEMO.tenantId,
  userId,
  scope: "tenant" as const,
  locationIds: [],
});

beforeAll(async () => {
  h = await createHarness();
  appPool = createPool(h.db.url("harbour_app"));
  db = createDatabase(appPool);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await h?.close();
});

describe("workflow service", () => {
  it("starts, moves and records history with SLAs from code and from the rate table", async () => {
    const subject = {
      subjectType: "test_subject",
      subjectId: crypto.randomUUID(),
      personId: resident,
    };
    const started = await withRequestContext(db, as(DEMO.users.nurse.id), (tx) =>
      startWorkflow(tx, DEMO.tenantId, review, subject, new Date("2026-11-02T09:00:00Z")),
    );
    expect(started.state).toBe("open");
    expect(started.slaDueAt?.toISOString()).toBe("2026-11-03T09:00:00.000Z");

    const reviewed = await withRequestContext(db, as(DEMO.users.nurse.id), (tx) =>
      moveWorkflow(
        tx,
        DEMO.tenantId,
        review,
        subject,
        { to: "review", actorTenantUserId: DEMO.users.nurse.id, permissions, stepUpFresh: false },
        new Date("2026-11-02T10:00:00Z"),
      ),
    );
    expect(reviewed.state).toBe("review");
    // 7 days from the rate table, same UK local time.
    expect(reviewed.slaDueAt?.toISOString()).toBe("2026-11-09T10:00:00.000Z");

    // The creator may not close their own record.
    await expect(
      withRequestContext(db, as(DEMO.users.nurse.id), (tx) =>
        moveWorkflow(tx, DEMO.tenantId, review, subject, {
          to: "closed",
          actorTenantUserId: DEMO.users.nurse.id,
          permissions,
          reason: "Learning shared",
          stepUpFresh: false,
        }),
      ),
    ).rejects.toMatchObject({ problem: "separation_of_duties" });

    const closed = await withRequestContext(db, as(DEMO.users.manager.id), (tx) =>
      moveWorkflow(
        tx,
        DEMO.tenantId,
        review,
        subject,
        {
          to: "closed",
          actorTenantUserId: DEMO.users.manager.id,
          permissions,
          reason: "Learning shared at team meeting",
          stepUpFresh: false,
        },
        new Date("2026-11-03T15:00:00Z"),
      ),
    );
    expect(closed.state).toBe("closed");
    expect(closed.slaDueAt).toBeNull();

    const history = await withRequestContext(db, as(DEMO.users.manager.id), (tx) =>
      tx
        .select({ from: workflowTransition.fromState, to: workflowTransition.toState })
        .from(workflowTransition)
        .where(eq(workflowTransition.instanceId, started.id))
        .orderBy(asc(workflowTransition.occurredAt)),
    );
    expect(history).toEqual([
      { from: "open", to: "review" },
      { from: "review", to: "closed" },
    ]);
  });

  it("refuses to move a record that has no workflow", async () => {
    await expect(
      withRequestContext(db, as(DEMO.users.manager.id), (tx) =>
        moveWorkflow(
          tx,
          DEMO.tenantId,
          review,
          { subjectType: "test_subject", subjectId: crypto.randomUUID() },
          {
            to: "review",
            actorTenantUserId: DEMO.users.manager.id,
            permissions,
            stepUpFresh: false,
          },
        ),
      ),
    ).rejects.toBeInstanceOf(WorkflowMoveRefused);
  });
});
