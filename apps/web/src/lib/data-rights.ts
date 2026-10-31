import type { Me } from "@harbour/contracts";

/**
 * The data rights screens (PLAT-022, Phase 2 slice 66): the DSAR workbench, the breach register and
 * data protection complaints. Pure, unit tested; the API checks every permission again.
 */

export const DATA_RIGHTS_PAGE = "/data-rights";
export const REQUESTS_PAGE = "/data-rights/requests";
export const BREACHES_PAGE = "/data-rights/breaches";
export const COMPLAINTS_PAGE = "/data-rights/complaints";

export const DATA_RIGHTS_TABS = ["requests", "breaches", "complaints"] as const;
export type DataRightsTab = (typeof DATA_RIGHTS_TABS)[number];

export const TAB_PAGES: Readonly<Record<DataRightsTab, string>> = {
  requests: REQUESTS_PAGE,
  breaches: BREACHES_PAGE,
  complaints: COMPLAINTS_PAGE,
};

/**
 * Whether to offer the data rights screens: `quality.dsar.manage` held across the whole
 * organisation (platform.md, the DSAR workbench rule 1 and rule 18). Someone who holds it for one
 * home only (a Registered Manager or deputy) is refused by the API and row-level security, so the
 * menu does not offer it to them.
 */
export function dataRightsShown(me: Pick<Me, "permissions" | "scope">): boolean {
  return me.permissions.includes("quality.dsar.manage") && me.scope === "tenant";
}
