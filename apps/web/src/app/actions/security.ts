"use server";

import { revalidatePath } from "next/cache";
import { revokeDeviceSession, revokeOtherDeviceSessions } from "@/lib/auth-server";

/** Signs out one of the person's other devices. */
export async function revokeSession(formData: FormData): Promise<void> {
  const id = formData.get("sessionId");
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return;
  await revokeDeviceSession(id);
  revalidatePath("/settings/security");
}

/** Signs out every device except this one. */
export async function revokeOtherSessions(): Promise<void> {
  await revokeOtherDeviceSessions();
  revalidatePath("/settings/security");
}

/** Refreshes the page after the browser has changed authenticator or passkey settings. */
export async function refreshSecurity(): Promise<void> {
  revalidatePath("/settings/security");
}
