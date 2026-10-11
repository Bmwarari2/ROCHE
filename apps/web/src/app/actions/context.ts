"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getShellContext, isSecureRequest, serverApi } from "@/lib/api";
import {
  contextCookieOptions,
  isUuid,
  LOCATION_COOKIE,
  TENANT_COOKIE,
} from "@/lib/context-cookies";
import { safeNextPath } from "@/lib/problems";

/** Only an organisation the API confirms the person belongs to is ever stored. */
async function isMember(tenantId: string): Promise<boolean> {
  const api = await serverApi();
  const { data } = await api.GET("/v1/memberships");
  return data?.items.some((m) => m.tenantId === tenantId) ?? false;
}

async function storeTenant(tenantId: string): Promise<void> {
  const jar = await cookies();
  jar.set(TENANT_COOKIE, tenantId, contextCookieOptions("tenant", await isSecureRequest()));
  // A location belongs to one organisation; start the new one with every location in scope.
  jar.delete(LOCATION_COOKIE);
}

/** The choose-organisation form. */
export async function chooseOrganisation(formData: FormData): Promise<void> {
  const tenantId = formData.get("tenantId");
  const next = safeNextPath(formData.get("next")) ?? "/";
  if (!isUuid(tenantId) || !(await isMember(tenantId))) redirect("/choose-organisation");
  await storeTenant(tenantId);
  redirect(next);
}

/** The organisation switcher in the app bar. */
export async function switchOrganisation(tenantId: string): Promise<{ ok: boolean }> {
  if (!isUuid(tenantId) || !(await isMember(tenantId))) return { ok: false };
  await storeTenant(tenantId);
  return { ok: true };
}

/** The location switcher in the app bar; null means every location in scope. */
export async function switchLocation(locationId: string | null): Promise<{ ok: boolean }> {
  const jar = await cookies();
  if (locationId === null) {
    jar.delete(LOCATION_COOKIE);
    return { ok: true };
  }
  if (!isUuid(locationId)) return { ok: false };
  const { me } = await getShellContext();
  if (!me.locations.some((l) => l.id === locationId)) return { ok: false };
  jar.set(LOCATION_COOKIE, locationId, contextCookieOptions("location", await isSecureRequest()));
  return { ok: true };
}

/** Forgets the organisation and location, for example when signing out on a shared computer. */
export async function clearContext(): Promise<void> {
  const jar = await cookies();
  jar.delete(TENANT_COOKIE);
  jar.delete(LOCATION_COOKIE);
}
