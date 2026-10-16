"use server";

import type { TaskItem } from "@harbour/contracts";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * Moves a task from the round (care.md rule 8): started, done, or not done with the reason. The
 * API checks the permission the task names and that the viewer may reach its person, its version
 * and its rules (a task that needs a record is done by recording it), and refuses in words.
 */
export async function moveRoundTask(
  locationId: string,
  taskId: string,
  input: {
    readonly to: "in_progress" | "done" | "skipped";
    readonly reason?: string;
    readonly version: number;
  },
): Promise<ActionResult<TaskItem>> {
  if (!isUuid(locationId) || !isUuid(taskId)) return refused(t("errors.notFound"), "not_found");
  const reason = input.reason?.trim();
  if (input.to === "skipped" && (reason?.length ?? 0) < 3) {
    return refused(t("care.round.reasonRequired"), "invalid", ["reason"]);
  }
  try {
    const api = await tenantApi();
    const { data, error } = await api.POST("/v1/tasks/{id}/transition", {
      params: { path: { id: taskId } },
      body: {
        to: input.to,
        version: input.version,
        ...(input.to === "skipped" && reason ? { reason: reason.slice(0, 500) } : {}),
      },
    });
    if (data) {
      revalidatePath(`/round/${locationId}`);
      return { ok: true, data };
    }
    return { ok: false, ...problemMessage(error, t) };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}
