import {
  breakGlassEvent,
  breakGlassWeeklyReport,
  createDatabase,
  createPool,
  withRequestContext,
} from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { breakGlassReportWeek, ukDayBounds } from "@harbour/domain";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config";
import { reportBreakGlass } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { testOnlySwitchRefusal } from "./demo-seed-guard";

/**
 * Runs the weekly break-glass report job once (PLAT-006), for local end-to-end tests that do not
 * start the worker. The job reports the UK week before the time it runs.
 *
 * - `--this-week` runs it as if a week had passed, so the week in progress is reported (the
 *   journey opens a record by break-glass and then reads the report; the report then says it was
 *   built a week from now).
 * - `--e2e-week=yyyy-mm-dd` reports the week holding that date, after giving it, in the demo
 *   organisation, one opening of a Harbour Mews resident's record by the demo manager and one
 *   break-glass search by the demo owner that showed Harbour Mews (invented events; nothing is
 *   added when the week is already reported). The journey picks an unused past week, so it
 *   always finds a report to review and one the owner may not review.
 *
 * A week is reported once per location, so a later run for the same week stores nothing, and the
 * worker leaves a week reported this way as it is: on a shared database that would hide the rest
 * of the week from the real report and send real alerts. So it runs only against a throwaway
 * local or CI database, as the demo seed's test-only switches do (demo-seed-guard.ts; review
 * round 1 of feat/web-break-glass-report).
 */

/** Harbour Mews and one of its invented residents (apps/api/scripts/seed-users.ts). */
const MEWS_LOCATION = "0194d000-0000-7000-8000-000000000150";
const MEWS_TWIN_B = "0194d000-0000-7000-8600-000000000152";
const HOUR = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR;

const config = loadConfig();
const refusal = testOnlySwitchRefusal({
  env: process.env,
  nodeEnv: config.NODE_ENV,
  databaseUrls: [config.DATABASE_WORKER_URL, config.DATABASE_APP_URL],
});
if (refusal) throw new Error(`run-break-glass-report refused: ${refusal}`);

const e2eWeek = process.argv.find((a) => a.startsWith("--e2e-week="))?.slice("--e2e-week=".length);
if (e2eWeek !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(e2eWeek)) {
  throw new Error("--e2e-week takes a date written yyyy-mm-dd");
}
const logger = createLogger("warn");
const workerPool = createPool(config.DATABASE_WORKER_URL, { max: 1 });
const appPool = createPool(config.DATABASE_APP_URL, { max: 2 });
const appDb = createDatabase(appPool);
try {
  let now = process.argv.includes("--this-week") ? new Date(Date.now() + WEEK_MS) : new Date();
  if (e2eWeek) {
    const week = breakGlassReportWeek(ukDayBounds(e2eWeek).startsAt);
    // The job reports the week before `now`: an hour into the next week reports this one.
    now = new Date(week.end.getTime() + HOUR);
    const context = {
      tenantId: DEMO.tenantId,
      userId: null,
      scope: "tenant" as const,
      locationIds: [],
    };
    await withRequestContext(appDb, context, async (tx) => {
      const reported = await tx
        .select({ id: breakGlassWeeklyReport.id })
        .from(breakGlassWeeklyReport)
        .where(eq(breakGlassWeeklyReport.weekStart, week.start))
        .limit(1);
      if (reported.length > 0) return;
      const at = new Date(week.start.getTime() + 2 * 24 * HOUR + 10 * HOUR);
      await tx.insert(breakGlassEvent).values([
        {
          tenantUserId: DEMO.users.manager.id,
          personId: MEWS_TWIN_B,
          justification: "End-to-end fixture: covering the Mews while its manager was away",
          reasonCode: "covering_another_area",
          openedAt: at,
          expiresAt: new Date(at.getTime() + HOUR),
        },
        {
          tenantUserId: DEMO.users.owner.id,
          kind: "search",
          personId: null,
          shownLocationIds: [MEWS_LOCATION],
          justification: "End-to-end fixture: an ambulance crew asking about a resident",
          reasonCode: "emergency_care",
          openedAt: at,
          expiresAt: at,
        },
      ]);
    });
  }
  const stored = await reportBreakGlass({ workerPool, appDb, logger }, now);
  console.log(`Weekly break-glass reports stored: ${stored}`);
} finally {
  await workerPool.end();
  await appPool.end();
}
