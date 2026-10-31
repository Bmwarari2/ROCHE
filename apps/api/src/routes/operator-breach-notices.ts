import { ProcessorBreachNoticeSent, SendProcessorBreachNotice } from "@harbour/contracts";
import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import type pg from "pg";
import type { AppEnv } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";

/**
 * Thapsus's breach notice to an organisation as processor (platform.md rule 24; Art 33(2); DPA
 * clause 8.2; breach-response.md section 2 step 4). An admin operator with a fresh step-up sends
 * it through `app.send_processor_breach_notice` (migration 0082), which identifies the admin from
 * the transaction's `app.operator_id`, stores the notice, opens the organisation's breach register
 * entry (or links a follow-up to the first notice's entry) and writes the organisation's audit
 * event and an outbox event, so its data protection lead and owners are told. Ids only.
 */

function refusalOf(error: unknown): unknown {
  switch ((error as { message?: string }).message) {
    case "operator_not_admin":
      return problems.forbidden();
    case "tenant_not_found":
    case "notice_not_found":
      return problems.notFound();
    default:
      return error;
  }
}

/** Runs `fn` in one operator transaction with `app.operator_id` set, as the function requires. */
async function asOperator<T>(
  c: Context<AppEnv>,
  operatorId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await c.get("services").operatorPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.operator_id', $1, true)", [operatorId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw refusalOf(error);
  } finally {
    client.release();
  }
}

export const operatorBreachNoticesRouter = createRouter().openapi(
  createRoute({
    method: "post",
    path: "/operator/breach-notices",
    tags: ["operator"],
    summary:
      "Tell an organisation about a personal data breach affecting its data (admins, fresh sign-in)",
    description:
      "Sends the processor-to-controller notice (nature, data categories, approximate numbers, likely consequences, measures, what the organisation needs to do, contact). A first notice opens the organisation's breach register entry with the time of the notice as its awareness, which the organisation may correct to its own; a follow-up (followsId) joins the same entry. Do not wait for complete information. Audited in the organisation's log (platform.breach.processor_notice_sent); its data protection lead and owners are told.",
    security,
    request: {
      body: { content: { "application/json": { schema: SendProcessorBreachNotice } } },
    },
    responses: {
      201: jsonBody(ProcessorBreachNoticeSent, "Sent"),
      ...errorResponses,
      ...notFoundResponse,
    },
  }),
  async (c) => {
    const operator = c.get("operator");
    if (operator.role !== "admin") throw problems.forbidden();
    if (!operator.stepUpFresh) throw problems.stepUp();
    const body = c.req.valid("json");
    const sent = await asOperator(c, operator.id, async (client) => {
      const { rows } = await client.query<{ r: { noticeId: string; breachId: string } }>(
        "SELECT app.send_processor_breach_notice($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS r",
        [
          body.tenantId,
          body.followsId ?? null,
          body.nature,
          body.dataCategories,
          body.approxPeople ?? null,
          body.approxRecords ?? null,
          body.likelyConsequences,
          body.measures,
          body.tenantActions,
          body.contact,
          c.get("requestId") ?? null,
        ],
      );
      const r = rows[0]?.r;
      if (!r) throw new HttpProblem(500, "internal", "The notice was not sent.");
      return r;
    });
    return c.json(sent, 201);
  },
);
