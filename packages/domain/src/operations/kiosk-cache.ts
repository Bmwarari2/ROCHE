import { addPeriod, type RetentionRule } from "../platform/retention";

/**
 * The downtime pack cached on a kiosk (operations.md rule 8; docs/compliance/kiosk.md section 3.5;
 * hazard HZ-021). The cached pack holds every person at the location, which is wider than any
 * shared-device user's assigned scope, so it is an exception with its own controls:
 *
 * - it is stored encrypted under a key the device releases only to a PIN session of a user who
 *   holds `operations.downtime.read`;
 * - every print or open on the device is queued as an audit event and uploaded when online;
 * - it is evicted when the device key is revoked, and once its `downtime_pack` retention ends.
 */

export interface KioskPackSession {
  readonly userId: string;
  /** The user signed in on this device with their PIN in this session (kiosk.md 3.1). */
  readonly pinVerified: boolean;
  readonly permissions: ReadonlySet<string>;
}

export type KioskPackUnlock =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "device_revoked" | "pin_session_required" | "missing_permission";
      readonly message: string;
    };

/** Whether the device may release the cached pack's key to this session. */
export function kioskDowntimePackUnlock(
  session: KioskPackSession | null,
  device: { readonly keyRevoked: boolean },
): KioskPackUnlock {
  if (device.keyRevoked) {
    return {
      ok: false,
      reason: "device_revoked",
      message: "This device has been withdrawn. Use the printed pack.",
    };
  }
  if (!session?.pinVerified) {
    return {
      ok: false,
      reason: "pin_session_required",
      message: "Sign in with your PIN to open the downtime pack.",
    };
  }
  if (!session.permissions.has("operations.downtime.read")) {
    return {
      ok: false,
      reason: "missing_permission",
      message: "Ask the nurse or senior in charge to open the downtime pack.",
    };
  }
  return { ok: true };
}

export type KioskCacheDisposition = "keep" | "evict_device_revoked" | "evict_retention_ended";

/** Keep or evict the cached pack: revocation first, then the `downtime_pack` retention period. */
export function kioskDowntimeCacheDisposition(
  cached: { readonly generatedAt: Date },
  device: { readonly keyRevoked: boolean },
  retention: Pick<RetentionRule, "period" | "unit">,
  now: Date,
): KioskCacheDisposition {
  if (device.keyRevoked) return "evict_device_revoked";
  const ends = addPeriod(cached.generatedAt, retention.period, retention.unit);
  return now.getTime() >= ends.getTime() ? "evict_retention_ended" : "keep";
}

export interface KioskPrintAuditEvent {
  readonly action: "operations.downtime_pack.printed" | "operations.downtime_pack.opened";
  readonly packId: string;
  readonly userId: string;
  readonly deviceId: string;
  /** The device's time; the server adds its received time when the queue uploads. */
  readonly occurredAt: Date;
  /** Opaque: the queue never holds personal data, only ids. */
  readonly idempotencyKey: string;
}

/** The audit event queued on the device for a print or open, uploaded idempotently when online. */
export function kioskPrintAuditEvent(input: {
  readonly kind: "printed" | "opened";
  readonly packId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly occurredAt: Date;
  readonly eventId: string;
}): KioskPrintAuditEvent {
  return {
    action:
      input.kind === "printed"
        ? "operations.downtime_pack.printed"
        : "operations.downtime_pack.opened",
    packId: input.packId,
    userId: input.userId,
    deviceId: input.deviceId,
    occurredAt: input.occurredAt,
    idempotencyKey: input.eventId,
  };
}
