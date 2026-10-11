import type { Transaction } from "@harbour/db";
import { integrationInbound } from "@harbour/db";
import { classifyInbound, type InboundProblem } from "@harbour/domain";
import type { z } from "zod";

/**
 * Receives data from a partner (council remittance, pharmacy feed, directory enquiry): validates it
 * against the port's Zod schema and records it, accepted or quarantined with the problems found.
 * Quarantined items appear in the integrations queue for a person to release or discard.
 */
export async function receiveInbound<S extends z.ZodType>(
  tx: Transaction,
  input: { port: string; provider: string; externalId?: string; payload: unknown },
  schema: S,
): Promise<
  | { status: "accepted"; data: z.infer<S>; id: string }
  | { status: "quarantined"; id: string; problems: InboundProblem[] }
> {
  const parsed = schema.safeParse(input.payload);
  const problems: InboundProblem[] = parsed.success
    ? []
    : parsed.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }));
  const decision = classifyInbound(problems);
  const [row] = await tx
    .insert(integrationInbound)
    .values({
      port: input.port,
      provider: input.provider,
      externalId: input.externalId ?? null,
      status: decision.status,
      payload: input.payload as Record<string, unknown>,
      problems,
    })
    .returning({ id: integrationInbound.id });
  const id = row?.id ?? "";
  return decision.status === "accepted" && parsed.success
    ? { status: "accepted", data: parsed.data, id }
    : { status: "quarantined", id, problems };
}
