import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdColumns, id, tenantId } from "./_columns";
import { operatorUser } from "./operator";
import { tenant, tenantUser } from "./platform";

/**
 * Invitations to join an organisation (PLAT-004; platform.md, Invitations and MFA enrolment). The
 * link's 256-bit token travels only in its URL fragment and request bodies; only its SHA-256 is
 * stored, and the application role cannot read it back. Looked up and accepted through
 * security-definer functions owned by `harbour_invitation_owner`. Single use: accepted or revoked
 * is final, and at most one invitation per member is open. Sent by a member (`created_by`) or, for
 * the first owner, by a Thapsus operator (`created_by_operator`). Retention class `invitation`.
 */
export const invitation = pgTable(
  "invitation",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    tenantUserId: uuid("tenant_user_id").notNull(),
    /**
     * The address the invitation was sent to, copied from the member by a trigger; cleared when
     * the invitation is accepted, revoked or lapses (#43 review M4).
     */
    email: text("email"),
    /** SHA-256 (hex) of the link's token; the token itself is never stored. */
    tokenHash: text("token_hash").notNull(),
    ...createdColumns(),
    createdByOperator: uuid("created_by_operator").references(() => operatorUser.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /** The sign-in the member was linked to (Better Auth user id). */
    acceptedAuthUserId: text("accepted_auth_user_id"),
    /**
     * The sign-in the acceptance created, recorded before it is linked, so the nightly sweep can
     * delete one left unlinked by a stopped acceptance, and no other sign-in (#43 review round 2).
     */
    claimedAuthUserId: text("claimed_auth_user_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    /** `INVITATION_REVOCATION_REASONS` in packages/domain. */
    revocationReason: text("revocation_reason"),
  },
  (t) => [
    unique("invitation_tenant_id_id_key").on(t.tenantId, t.id),
    unique("invitation_token_hash_key").on(t.tokenHash),
    index("invitation_member_idx").on(t.tenantId, t.tenantUserId),
    // One open invitation per member: a new one revokes the old in the same transaction.
    uniqueIndex("invitation_one_open_key")
      .on(t.tenantId, t.tenantUserId)
      .where(sql`accepted_at IS NULL AND revoked_at IS NULL`),
    foreignKey({
      name: "invitation_member_fk",
      columns: [t.tenantId, t.tenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "invitation_created_by_fk",
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "invitation_revoked_by_fk",
      columns: [t.tenantId, t.revokedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("invitation_token_hash", sql`token_hash ~ '^[0-9a-f]{64}$'`),
    check("invitation_one_sender", sql`num_nonnulls(created_by, created_by_operator) = 1`),
    check("invitation_expiry", sql`expires_at > created_at`),
    check("invitation_accepted", sql`(accepted_at IS NULL) = (accepted_auth_user_id IS NULL)`),
    check(
      "invitation_revoked",
      sql`(revoked_at IS NULL) = (revocation_reason IS NULL)
        AND (revocation_reason IS NULL OR revocation_reason IN
          ('superseded', 'revoked', 'member_removed', 'member_changed', 'expired'))
        AND (revoked_by IS NULL OR revoked_at IS NOT NULL)`,
    ),
    // The address is held only while the invitation is open (#43 review M4).
    check(
      "invitation_email_open_only",
      sql`(email IS NOT NULL) = (accepted_at IS NULL AND revoked_at IS NULL)`,
    ),
    check("invitation_final", sql`accepted_at IS NULL OR revoked_at IS NULL`),
    check("invitation_claimed", sql`(claimed_at IS NULL) = (claimed_auth_user_id IS NULL)`),
  ],
);
