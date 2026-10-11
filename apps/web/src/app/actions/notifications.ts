"use server";

import { revalidatePath } from "next/cache";
import { failWith, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";

async function act(formData: FormData, action: "read" | "acknowledge"): Promise<void> {
  const id = formData.get("id");
  if (!isUuid(id)) return;
  const api = await tenantApi();
  const path =
    action === "read" ? "/v1/notifications/{id}/read" : "/v1/notifications/{id}/acknowledge";
  const { error, response } = await api.POST(path, { params: { path: { id } } });
  // A notification that has gone (or was never this person's) needs no further action.
  if (!response.ok && response.status !== 404) failWith(error, response, "/notifications");
  revalidatePath("/", "layout");
}

export async function markNotificationRead(formData: FormData): Promise<void> {
  await act(formData, "read");
}

export async function acknowledgeNotification(formData: FormData): Promise<void> {
  await act(formData, "acknowledge");
}
