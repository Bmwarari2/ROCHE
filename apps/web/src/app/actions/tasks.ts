"use server";

import type { CreateTask, CreateTaskSeries, TaskItem } from "@harbour/contracts";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";
import { TASKS_PAGE } from "@/lib/tasks";

/**
 * Task writes (PLAT-011): move a task, take or unassign it, and create a one-off or repeating
 * task. The API checks who may do each again (the task's permission, its assignee,
 * `platform.task.manage`) and every rule; the version the person saw travels with each change, so
 * a task someone else changed is refused (409), never overwritten.
 */

type Api = Awaited<ReturnType<typeof tenantApi>>;

async function send<T>(
  call: (api: Api) => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<ActionResult<T | null>> {
  try {
    const { data, error, response } = await call(await tenantApi());
    if (!response.ok) return { ok: false, ...problemMessage(error, t) };
    revalidatePath(TASKS_PAGE);
    return { ok: true, data: data ?? null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

const VERSION_REFUSED = () => refused(t("errors.notFound"), "not_found");

export async function transitionTask(input: {
  readonly id: string;
  readonly to: "in_progress" | "done" | "skipped" | "cancelled";
  readonly version: number;
  readonly reason?: string;
}): Promise<ActionResult<TaskItem | null>> {
  if (!isUuid(input.id) || !Number.isInteger(input.version) || input.version < 1) {
    return VERSION_REFUSED();
  }
  return send((api) =>
    api.POST("/v1/tasks/{id}/transition", {
      params: { path: { id: input.id } },
      body: {
        to: input.to,
        version: input.version,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    }),
  );
}

export async function assignTask(input: {
  readonly id: string;
  readonly assigneeTenantUserId: string | null;
  readonly version: number;
}): Promise<ActionResult<TaskItem | null>> {
  if (
    !isUuid(input.id) ||
    (input.assigneeTenantUserId !== null && !isUuid(input.assigneeTenantUserId)) ||
    !Number.isInteger(input.version) ||
    input.version < 1
  ) {
    return VERSION_REFUSED();
  }
  return send((api) =>
    api.POST("/v1/tasks/{id}/assign", {
      params: { path: { id: input.id } },
      body: { assigneeTenantUserId: input.assigneeTenantUserId, version: input.version },
    }),
  );
}

export async function createTask(body: CreateTask): Promise<ActionResult<unknown>> {
  return send((api) => api.POST("/v1/tasks", { body }));
}

export async function createTaskSeries(body: CreateTaskSeries): Promise<ActionResult<unknown>> {
  return send((api) => api.POST("/v1/task-series", { body }));
}
