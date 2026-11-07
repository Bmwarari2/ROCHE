import "server-only";
import type { Me } from "@harbour/contracts";
import { tenantApi } from "@/lib/api";
import { type MemberOption, memberOptions } from "@/lib/homely-remedies";
import { t } from "@/lib/i18n";

/** Who may list the organisation's staff by name and job title (the API's own list). */
const STAFF_LISTERS = [
  "workforce.staff_file.manage",
  "workforce.sponsor.manage",
  "workforce.ldss.manage",
  "comms.feed.publish",
];

/**
 * The staff a homely remedy protocol may name (slice 55): the organisation's current staff where
 * the reader may list them, or the home's members where the reader manages members; always the
 * reader; and anyone the protocol already names. Names and job titles only, never an address.
 */
export async function protocolMembers(
  me: Me,
  locationId: string,
  named: readonly string[],
): Promise<MemberOption[]> {
  const api = await tenantApi();
  const listed: { id: string; displayName: string; jobTitle?: string | null }[] = [];
  if (STAFF_LISTERS.some((p) => me.permissions.includes(p))) {
    const staff = await api.GET("/v1/workforce/staff-members");
    for (const item of staff.data?.items ?? []) if (item) listed.push(item);
  }
  if (me.permissions.includes("platform.user.manage")) {
    const members = await api.GET("/v1/members", { params: { query: { locationId } } });
    listed.push(
      ...(members.data?.items ?? [])
        .filter((m) => m.state === "active")
        .map((m) => ({ id: m.id, displayName: m.displayName })),
    );
  }
  return memberOptions(listed, { tenantUserId: me.tenantUserId, name: me.user.name }, named, t);
}
