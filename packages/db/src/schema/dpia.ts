import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, mutableColumns, tenantId } from "./_columns";
import { tenant, tenantUser } from "./platform";

/**
 * The organisation's DPIA, one row per version (PLAT-023; platform-completions.md rules 17 to 22):
 * prepared in-app from Harbour's prefill and the organisation's answers, then signed by its named
 * data protection lead, who prepared none of it. A signed version never changes; a later version
 * supersedes it. `audit_event` retention class (accountability evidence).
 */
export const dpia = pgTable(
  "dpia",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    /** The DPIA's own version number, 1 upwards (not the row's change counter). */
    dpiaVersion: integer("dpia_version").notNull(),
    /** `draft`, `prepared`, `signed` or `superseded`. */
    status: text("status").notNull().default("draft"),
    /** Harbour's prefill (`prefillDpia`), refreshed while a draft, frozen once prepared. */
    prefill: jsonb("prefill").notNull(),
    /** The organisation's answers, by section and field. */
    answers: jsonb("answers").notNull().default(sql`'{}'::jsonb`),
    /** The residual risk rated for each risk after its measures. */
    residualRisk: jsonb("residual_risk").notNull().default(sql`'{}'::jsonb`),
    /** ICO prior consultation reference (Article 36), when a risk stays high. */
    icoReference: text("ico_reference"),
    /** Everyone who wrote any part of this version; none of them may sign it. */
    preparedBy: uuid("prepared_by").array().notNull().default(sql`'{}'::uuid[]`),
    /** SHA-256 of the version as prepared (prefill, answers, ratings, reference). */
    versionSha256: text("version_sha256"),
    preparedAt: timestamp("prepared_at", { withTimezone: true }),
    signedBy: uuid("signed_by"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    typedName: text("typed_name"),
    statement: text("statement"),
    /** What the signed version covered (`DpiaBasis`), for re-review. */
    basis: jsonb("basis"),
    ...mutableColumns(),
  },
  (t) => [
    unique("dpia_tenant_id_id_key").on(t.tenantId, t.id),
    unique("dpia_tenant_version_key").on(t.tenantId, t.dpiaVersion),
    // One version being prepared at a time.
    uniqueIndex("dpia_one_open_key").on(t.tenantId).where(sql`status IN ('draft', 'prepared')`),
    foreignKey({
      name: "dpia_signed_by_fk",
      columns: [t.tenantId, t.signedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("dpia_status", sql`status IN ('draft', 'prepared', 'signed', 'superseded')`),
    check("dpia_version", sql`dpia_version >= 1`),
    check(
      "dpia_prepared",
      sql`status = 'draft' OR (version_sha256 ~ '^[0-9a-f]{64}$' AND prepared_at IS NOT NULL)`,
    ),
    check(
      "dpia_signed",
      sql`(status IN ('signed', 'superseded')) = (signed_by IS NOT NULL AND signed_at IS NOT NULL
        AND typed_name IS NOT NULL AND statement IS NOT NULL AND basis IS NOT NULL)`,
    ),
    check(
      "dpia_signer_not_preparer",
      sql`signed_by IS NULL OR NOT (signed_by = ANY (prepared_by))`,
    ),
  ],
);
