import { sql } from "drizzle-orm";

/**
 * An SQL list of code values for CHECK constraints, from the domain's constants. The tests keep
 * each list in step with packages/domain. No imports from other schema modules, so it is safe to
 * use at the top level of modules that reference each other.
 */
export const sqlList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v}'`).join(", "));
