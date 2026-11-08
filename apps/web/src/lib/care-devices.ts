import type { DeviceBindingItem, DeviceRevocationReason } from "@harbour/contracts";
import { DEVICE_REVOCATION_REASONS } from "@harbour/contracts";

/**
 * Care mode devices on the web (care.md section 6, Device integrity part 2; HZ-040, HZ-006): the
 * phones staff have used, grouped by phone, and a manager's withdrawal of a lost one. The API
 * decides what each person may see and withdraw; these only choose what to show.
 */
export const DEVICE_READ_PERMISSION = "platform.device.read";
export const DEVICE_REVOKE_PERMISSION = "platform.device.revoke";

export function devicesShown(permissions: readonly string[]): boolean {
  return permissions.includes(DEVICE_READ_PERMISSION);
}

export function mayWithdrawDevices(permissions: readonly string[]): boolean {
  return permissions.includes(DEVICE_REVOKE_PERMISSION);
}

export const WITHDRAW_REASONS: readonly DeviceRevocationReason[] = DEVICE_REVOCATION_REASONS;

export function isWithdrawReason(value: unknown): value is DeviceRevocationReason {
  return WITHDRAW_REASONS.some((r) => r === value);
}

/** One phone, with everyone who used it. */
export interface DeviceSummary {
  readonly deviceId: string;
  /** The last four characters of its opaque id, so two phones can be told apart on screen. */
  readonly shortId: string;
  readonly members: readonly { readonly tenantUserId: string; readonly name: string }[];
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** When it was withdrawn, and why; null while it is in use. */
  readonly revokedAt: string | null;
  readonly revocationReason: DeviceRevocationReason | null;
  /** Entries it last reported waiting (the same for every binding), and when it reported. */
  readonly entriesWaiting: number;
  readonly lastReportedAt: string | null;
}

const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);
const earlier = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);

/**
 * The bindings grouped by phone, most recently seen first. A phone counts as withdrawn only when
 * every binding is, as the API judges it (clinical review of #217, L1); one left in use keeps the
 * form offered.
 */
export function groupDevices(items: readonly DeviceBindingItem[]): DeviceSummary[] {
  const byDevice = new Map<string, DeviceSummary>();
  for (const item of items) {
    const id = item.deviceId.toLowerCase();
    const was = byDevice.get(id);
    const member = { tenantUserId: item.tenantUserId, name: item.memberName };
    if (!was) {
      byDevice.set(id, {
        deviceId: id,
        shortId: id.replace(/-/g, "").slice(-4).toUpperCase(),
        members: [member],
        firstSeenAt: item.firstSeenAt,
        lastSeenAt: item.lastSeenAt,
        revokedAt: item.revokedAt,
        revocationReason: item.revocationReason,
        entriesWaiting: item.entriesWaiting,
        lastReportedAt: item.lastReportedAt,
      });
      continue;
    }
    byDevice.set(id, {
      ...was,
      members: was.members.some((m) => m.tenantUserId === member.tenantUserId)
        ? was.members
        : [...was.members, member],
      firstSeenAt: earlier(was.firstSeenAt, item.firstSeenAt),
      lastSeenAt: later(was.lastSeenAt, item.lastSeenAt),
      revokedAt: was.revokedAt && item.revokedAt ? later(was.revokedAt, item.revokedAt) : null,
      revocationReason:
        was.revokedAt && item.revokedAt ? (was.revocationReason ?? item.revocationReason) : null,
      entriesWaiting: Math.max(was.entriesWaiting, item.entriesWaiting),
      lastReportedAt:
        was.lastReportedAt && item.lastReportedAt
          ? later(was.lastReportedAt, item.lastReportedAt)
          : (was.lastReportedAt ?? item.lastReportedAt),
    });
  }
  const devices = [...byDevice.values()]
    .map((d) => ({ ...d, members: [...d.members].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  // Two phones never share a name on screen: the short id grows until each is told apart
  // (accessibility review, 2.4.4).
  let length = 4;
  const short = (id: string) => id.replace(/-/g, "").slice(-length).toUpperCase();
  while (length < 32 && new Set(devices.map((d) => short(d.deviceId))).size < devices.length) {
    length += 2;
  }
  return devices.map((d) => ({ ...d, shortId: short(d.deviceId) }));
}

/** The names as a list in words ("Ada Example and Ben Example"), never joined fragments. */
export function namesInWords(names: readonly string[], locale = "en-GB"): string {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
}
