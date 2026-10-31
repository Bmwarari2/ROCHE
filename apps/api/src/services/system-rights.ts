import type { Transaction } from "@harbour/db";
import { sql } from "drizzle-orm";

/**
 * Runs `fn` in the caller's transaction with the system's rights (no member, the organisation's
 * view), then puts back exactly the member and scope the transaction had, also when `fn` fails.
 * For a narrow question the caller may ask but whose rows its own row-level security hides: the
 * competence port (ADR-0085) and ending an item's reminder tasks (workforce.md section 5). Never
 * for anything the caller then shows beyond what that question answers.
 */
export async function withSystemRights<T>(tx: Transaction, fn: () => Promise<T>): Promise<T> {
  const saved = await tx.execute<{ user_id: string | null; scope: string | null }>(
    sql`SELECT current_setting('app.user_id', true) AS user_id,
               current_setting('app.scope', true) AS scope`,
  );
  const before = saved.rows[0];
  await tx.execute(
    sql`SELECT set_config('app.user_id', '', true), set_config('app.scope', 'tenant', true)`,
  );
  const restore = () =>
    tx.execute(
      sql`SELECT set_config('app.user_id', ${before?.user_id ?? ""}, true),
                 set_config('app.scope', ${before?.scope || "none"}, true)`,
    );
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    await restore().catch(() => undefined);
    throw error;
  }
  await restore();
  return result;
}
