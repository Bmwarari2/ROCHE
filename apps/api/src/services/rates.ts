import { rateTable, type Transaction } from "@harbour/db";
import { type RateNation, resolveRate } from "@harbour/domain";
import { eq } from "drizzle-orm";

/**
 * A figure from the rate table in force today (tenant override first), as a number. Statutory
 * figures and tenant defaults are never literals in code (section 18).
 */
export async function rateNumber(
  tx: Transaction,
  tenantId: string,
  key: string,
  nation: Exclude<RateNation, "uk" | "all"> = "england",
  on: string = new Date().toISOString().slice(0, 10),
): Promise<number> {
  const rows = await tx.select().from(rateTable).where(eq(rateTable.key, key));
  const rate = resolveRate(
    rows.map((r) => ({
      key: r.key,
      value: r.value,
      unit: r.unit,
      nation: r.nation,
      validFrom: r.validFrom,
      validTo: r.validTo,
      tenantId: r.tenantId,
      verificationStatus: r.verificationStatus,
      source: r.source,
    })),
    key,
    nation,
    on,
    tenantId,
  );
  return Number(rate.value);
}
