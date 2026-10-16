import { SampleDataBatch } from "@harbour/contracts";
import { location, person, sampleBatch, type Transaction } from "@harbour/db";
import {
  checkSampleDataLoad,
  SAMPLE_PEOPLE,
  type SampleDataCheck,
  type SampleDataProblem,
  sampleDataRefusal,
} from "@harbour/domain";
import { createRoute } from "@hono/zod-openapi";
import { asc, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx, writeAudit } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem } from "../http/problem";
import { createRouter, errorResponses, jsonBody, security } from "./openapi";

/**
 * Sample data mode (PLAT-018; platform-completions.md rules 29 to 32; HZ-072). A holder of
 * platform.onboarding.manage loads one batch of invented people before any real person exists,
 * and removes it in one step. The database holds the rules whichever path writes a person
 * (migration 0069): a real person waits until the batch has gone, a person never changes between
 * real and sample, and only `app.remove_sample_batch` deletes, whole batch or nothing. Loading and
 * removal are audited (batch id and counts only), refusals too.
 */

const LOADED = "platform.onboarding.sample_loaded";
const REMOVED = "platform.onboarding.sample_removed";

const DB_PROBLEMS: readonly SampleDataProblem[] = [
  "missing_permission",
  "real_people_exist",
  "remove_sample_data_first",
  "nothing_to_remove",
  "held",
  "referenced_by_real_records",
];

/** The database's refusal in the domain's words, or null for any other error. */
function databaseProblem(error: unknown): SampleDataProblem | null {
  const e = error as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  const pg = e.code ? e : (e.cause ?? {});
  if (pg.code === "23505") return "already_loaded";
  return DB_PROBLEMS.find((p) => pg.message === p) ?? null;
}

/** A refusal: audited, then 409 with the plain-English reason. */
async function refuse(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: string,
  check: Extract<SampleDataCheck, { ok: false }>,
): Promise<never> {
  await writeAudit(c.get("services").appPool, access, {
    action,
    outcome: "denied",
    reason: check.problem,
    requestId: c.get("requestId"),
  });
  throw new HttpProblem(409, check.problem, "Sample data was not changed.", check.message);
}

/** How many sample and real people the whole organisation has (app.sample_people). */
async function samplePeople(tx: Transaction): Promise<{ sample: number; real: number }> {
  const { rows } = await tx.execute<{ sample_count: string; real_count: string }>(
    sql`SELECT sample_count, real_count FROM app.sample_people()`,
  );
  return { sample: Number(rows[0]?.sample_count ?? 0), real: Number(rows[0]?.real_count ?? 0) };
}

/** Runs `work`, turning the database's sample refusals into audited 409s. */
async function guarded<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    const problem = databaseProblem(error);
    if (!problem) throw error;
    return refuse(c, access, action, sampleDataRefusal(problem));
  }
}

const sampleResponses = {
  200: jsonBody(SampleDataBatch, "Done"),
  ...errorResponses,
};

export const sampleDataRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/onboarding/sample-data",
      tags: ["platform"],
      summary: "Load sample data",
      description:
        "platform.onboarding.manage. Loads one batch of plainly invented people (family name Example, 999-range NHS numbers) at the organisation's first location, only while no real person exists and no batch is loaded (409 real_people_exist, already_loaded). Every real person then waits until the batch is removed. Audited (platform.onboarding.sample_loaded, batch id and count), refusals too.",
      security,
      responses: sampleResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.onboarding.manage");
      const body = await guarded(c, access, LOADED, () =>
        withTenant(c, async (tx) => {
          const counts = await samplePeople(tx);
          const check = checkSampleDataLoad({
            access: access.effective,
            realPeople: counts.real,
            samplePresent: counts.sample > 0,
          });
          if (!check.ok) return refuse(c, access, LOADED, check);
          const [home] = await tx
            .select({ id: location.id })
            .from(location)
            .where(isNull(location.deletedAt))
            .orderBy(asc(location.name), asc(location.id))
            .limit(1);
          if (!home) {
            throw new HttpProblem(
              409,
              "no_location",
              "Sample data was not changed.",
              "Add a location before loading sample data.",
            );
          }
          const [batch] = await tx
            .insert(sampleBatch)
            .values({ people: SAMPLE_PEOPLE.length })
            .returning({ id: sampleBatch.id });
          if (!batch) throw new Error("sample batch not created");
          await tx.insert(person).values(
            SAMPLE_PEOPLE.map((p) => ({
              locationId: home.id,
              status: "active" as const,
              nhsNumber: p.nhsNumber,
              givenName: p.givenName,
              familyName: p.familyName,
              preferredName: p.preferredName,
              dateOfBirth: p.dateOfBirth,
              roomLabel: p.roomLabel,
              allergyStatus: p.allergyStatus,
              isSample: true,
              sampleBatchId: batch.id,
            })),
          );
          await auditInTx(tx, access, {
            action: LOADED,
            resourceType: "sample_batch",
            resourceId: batch.id,
            scope: { people: SAMPLE_PEOPLE.length },
            requestId: c.get("requestId"),
          });
          return { batchId: batch.id, people: SAMPLE_PEOPLE.length };
        }),
      );
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/v1/onboarding/sample-data",
      tags: ["platform"],
      summary: "Remove the sample data",
      description:
        "platform.onboarding.manage. Removes the loaded batch in one step through app.remove_sample_batch: every person in it or none (409 nothing_to_remove, held, referenced_by_real_records). Audit events about the sample people stay. Audited by the database (platform.onboarding.sample_removed, batch id and count), refusals here.",
      security,
      responses: sampleResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.onboarding.manage");
      const body = await guarded(c, access, REMOVED, () =>
        withTenant(c, async (tx) => {
          const [open] = await tx
            .select({ id: sampleBatch.id })
            .from(sampleBatch)
            .where(isNull(sampleBatch.removedAt));
          if (!open) {
            return refuse(c, access, REMOVED, sampleDataRefusal("nothing_to_remove"));
          }
          const { rows } = await tx.execute<{ removed: number }>(
            sql`SELECT app.remove_sample_batch(${open.id}::uuid, ${c.get("requestId")}) AS removed`,
          );
          return { batchId: open.id, people: Number(rows[0]?.removed ?? 0) };
        }),
      );
      return c.json(body, 200);
    },
  );
