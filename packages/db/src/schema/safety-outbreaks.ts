import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { person } from "./people";
import { location, tenantUser } from "./platform";
import { statutoryNotification } from "./safety";

/**
 * Outbreak management and IPC audits (master prompt 11.1; SAFE-013; HZ-013; docs/specs/safety.md
 * section 11). An outbreak is declared at a location, keeps its case line list (append-only: an
 * update is a new row superseding the last for that person or member of staff), completes the
 * UKHSA report from the line list, and is closed once its report is decided. The Code of Practice
 * criteria IPC audits are read against are global reference data. Rules live in
 * packages/domain/src/safety/outbreak-management.ts; row-level security and guards in migration
 * 0093.
 */

/** The `OUTBREAK_*` and `VACCINATION_ANSWERS` lists in packages/domain. */
export const OUTBREAK_SYNDROME_CODES = [
  "acute_respiratory",
  "flu",
  "covid_19",
  "diarrhoea_vomiting",
  "other",
] as const;
export const OUTBREAK_STATE_CODES = ["declared", "closed"] as const;
export const OUTBREAK_CASE_TYPE_CODES = ["resident", "staff"] as const;
export const OUTBREAK_SYMPTOM_CODES = [
  "fever",
  "cough",
  "sore_throat",
  "shortness_of_breath",
  "loss_of_taste_or_smell",
  "diarrhoea",
  "vomiting",
  "new_confusion",
  "other",
] as const;
export const OUTBREAK_TEST_TYPE_CODES = ["lateral_flow", "pcr", "stool_sample", "other"] as const;
export const OUTBREAK_TEST_RESULT_CODES = [
  "not_tested",
  "pending",
  "positive",
  "negative",
] as const;
export const VACCINATION_ANSWER_CODES = ["yes", "no", "unknown"] as const;
export const OUTBREAK_CASE_OUTCOME_CODES = ["unwell", "recovered", "hospitalised", "died"] as const;

/** The Code of Practice criteria (global, seeded by migration 0093). */
export const ipcCodeCriterion = pgTable(
  "ipc_code_criterion",
  {
    id: text("id").primaryKey(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    source: text("source").notNull(),
  },
  (t) => [
    unique("ipc_code_criterion_number_key").on(t.number),
    check(
      "ipc_code_criterion_number",
      sql`number BETWEEN 1 AND 10 AND id = 'criterion_' || number`,
    ),
  ],
);

export const outbreak = pgTable(
  "outbreak",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    syndrome: text("syndrome").notNull(),
    /** The organism when a test named it (norovirus, influenza A), as staff recorded it. */
    organism: text("organism"),
    state: text("state").notNull().default("declared"),
    declaredAt: timestamp("declared_at", { withTimezone: true }).notNull().defaultNow(),
    declaredBy: uuid("declared_by").notNull().default(sql`app.current_user_id()`),
    /** The UKHSA report this outbreak's clock runs on (HZ-013), linked or drafted at declaration. */
    notificationId: uuid("notification_id"),
    /** The health protection team's reference, when they give one. */
    hptReference: text("hpt_reference"),
    closedOn: date("closed_on"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    closureReason: text("closure_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("outbreak_tenant_id_id_key").on(t.tenantId, t.id),
    // One outbreak per report: no two outbreaks share a UKHSA report or its decision (HZ-013).
    uniqueIndex("outbreak_notification_once")
      .on(t.tenantId, t.notificationId)
      .where(sql`notification_id IS NOT NULL`),
    uniqueIndex("outbreak_one_open")
      .on(t.tenantId, t.locationId, t.syndrome)
      .where(sql`state = 'declared'`),
    foreignKey({
      name: "outbreak_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "outbreak_declared_by_fk",
      columns: [t.tenantId, t.declaredBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "outbreak_notification_fk",
      columns: [t.tenantId, t.notificationId],
      foreignColumns: [statutoryNotification.tenantId, statutoryNotification.id],
    }),
    check("outbreak_syndrome", sql`syndrome IN (${sqlList(OUTBREAK_SYNDROME_CODES)})`),
    check("outbreak_state", sql`state IN (${sqlList(OUTBREAK_STATE_CODES)})`),
    check("outbreak_organism", sql`organism IS NULL OR char_length(organism) BETWEEN 2 AND 200`),
    check(
      "outbreak_hpt_reference",
      sql`hpt_reference IS NULL OR char_length(hpt_reference) BETWEEN 1 AND 100`,
    ),
    check(
      "outbreak_closure",
      sql`(state = 'closed') = (closed_on IS NOT NULL AND closed_at IS NOT NULL
        AND closed_by IS NOT NULL AND closure_reason IS NOT NULL)
        AND (closure_reason IS NULL OR char_length(btrim(closure_reason)) BETWEEN 3 AND 1000)`,
    ),
  ],
);

export const outbreakCase = pgTable(
  "outbreak_case",
  {
    id: id(),
    tenantId: tenantId(),
    outbreakId: uuid("outbreak_id").notNull(),
    caseType: text("case_type").notNull(),
    personId: uuid("person_id"),
    tenantUserId: uuid("tenant_user_id"),
    onsetOn: date("onset_on").notNull(),
    symptoms: text("symptoms").array().notNull(),
    testType: text("test_type"),
    testedOn: date("tested_on"),
    testResult: text("test_result").notNull(),
    fluVaccinated: text("flu_vaccinated").notNull(),
    covidVaccinated: text("covid_vaccinated").notNull(),
    outcome: text("outcome").notNull(),
    outcomeOn: date("outcome_on"),
    supersedesId: uuid("supersedes_id"),
    correctionReason: text("correction_reason"),
    ...createdColumns(),
  },
  (t) => [
    unique("outbreak_case_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("outbreak_case_superseded_once")
      .on(t.tenantId, t.supersedesId)
      .where(sql`supersedes_id IS NOT NULL`),
    index("outbreak_case_outbreak_idx").on(t.tenantId, t.outbreakId),
    foreignKey({
      name: "outbreak_case_outbreak_fk",
      columns: [t.tenantId, t.outbreakId],
      foreignColumns: [outbreak.tenantId, outbreak.id],
    }),
    foreignKey({
      name: "outbreak_case_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "outbreak_case_tenant_user_fk",
      columns: [t.tenantId, t.tenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "outbreak_case_supersedes_fk",
      columns: [t.tenantId, t.supersedesId],
      foreignColumns: [t.tenantId, t.id],
    }),
    check("outbreak_case_type", sql`case_type IN (${sqlList(OUTBREAK_CASE_TYPE_CODES)})`),
    check(
      "outbreak_case_subject",
      sql`(case_type = 'resident' AND person_id IS NOT NULL AND tenant_user_id IS NULL)
        OR (case_type = 'staff' AND tenant_user_id IS NOT NULL AND person_id IS NULL)`,
    ),
    check(
      "outbreak_case_symptoms",
      sql`cardinality(symptoms) BETWEEN 1 AND 9
        AND symptoms <@ ARRAY[${sqlList(OUTBREAK_SYMPTOM_CODES)}]::text[]`,
    ),
    check(
      "outbreak_case_test",
      sql`test_result IN (${sqlList(OUTBREAK_TEST_RESULT_CODES)})
        AND (test_type IS NULL OR test_type IN (${sqlList(OUTBREAK_TEST_TYPE_CODES)}))
        AND (test_result = 'not_tested') = (test_type IS NULL AND tested_on IS NULL)
        AND (test_type IS NULL) = (tested_on IS NULL)
        AND (tested_on IS NULL OR tested_on >= onset_on)`,
    ),
    check(
      "outbreak_case_vaccination",
      sql`flu_vaccinated IN (${sqlList(VACCINATION_ANSWER_CODES)})
        AND covid_vaccinated IN (${sqlList(VACCINATION_ANSWER_CODES)})`,
    ),
    check(
      "outbreak_case_outcome",
      sql`outcome IN (${sqlList(OUTBREAK_CASE_OUTCOME_CODES)})
        AND (outcome = 'unwell') = (outcome_on IS NULL)
        AND (outcome_on IS NULL OR outcome_on >= onset_on)`,
    ),
    check(
      "outbreak_case_correction",
      sql`(correction_reason IS NULL OR supersedes_id IS NOT NULL)
        AND (correction_reason IS NULL OR char_length(btrim(correction_reason)) BETWEEN 3 AND 500)`,
    ),
  ],
);
