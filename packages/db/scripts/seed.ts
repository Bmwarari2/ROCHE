import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { seedDemoEscalationPolicies, seedDemoTenant, seedReferenceData } from "../src/seed/demo";
import {
  findOverlaps,
  parseBankHolidays,
  parseRates,
  parseRetention,
} from "../src/seed/reference-data";
import { ownerUrl } from "./env";

const specs = fileURLToPath(new URL("../../../docs/specs/", import.meta.url));
const rates = parseRates(readFileSync(`${specs}rates.md`, "utf8"));
const overlaps = findOverlaps(rates);
if (overlaps.length > 0)
  throw new Error(`rates.md has overlapping periods:\n${overlaps.join("\n")}`);
const retention = parseRetention(readFileSync(`${specs}retention.md`, "utf8"));
const bankHolidays = parseBankHolidays(readFileSync(`${specs}calendar.md`, "utf8"));

const pool = new pg.Pool({ connectionString: ownerUrl(), max: 2 });
try {
  const reference = await seedReferenceData(pool, rates, retention, bankHolidays);
  console.log(
    `Reference data: ${reference.rates} rates, ${reference.retention} retention classes, ${reference.bankHolidays} bank holidays`,
  );
  if (process.env.HARBOUR_SEED_DEMO !== "0") {
    const demo = await seedDemoTenant(pool);
    console.log(demo.created ? "Demo tenant created" : "Demo tenant already present");
    await seedDemoEscalationPolicies(pool);
  }
} finally {
  await pool.end();
}
