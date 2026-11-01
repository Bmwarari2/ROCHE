"use server";

import type {
  AcknowledgedLoneWorkerAlarm,
  LoneWorkerEventResult,
  LoneWorkerOutcome,
  LoneWorkerOwnSession,
  LoneWorkerRoute,
  LoneWorkerRouteStep,
  LoneWorkerWorkKind,
} from "@harbour/contracts";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { MAX_ROUTE_STEPS, OUTCOMES, WORK_KINDS } from "@/lib/lone-worker";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * Lone-worker writes (scheduling.md section 14; HZ-125), sent to the API as the signed-in person.
 * The API checks every rule again and refuses in its own words. Sessions and events carry the
 * client's id, so a retry after a lost connection records once. The web app never offers duress
 * (H-1140), so no action here sends one.
 */

/**
 * The API's refusal. A state it refuses (a session already open, an alarm already closed) is said
 * in its own words, which are written for people; everything else through the shared catalogue.
 */
function refusal(error: unknown): ActionResult<never> {
  const problem = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    detail?: unknown;
  };
  if (problem.code === "invalid_state" && typeof problem.detail === "string" && problem.detail) {
    return refused(problem.detail, "invalid_state");
  }
  return { ok: false, ...problemMessage(error, t) };
}

async function send<T>(
  paths: readonly string[],
  call: (api: Awaited<ReturnType<typeof tenantApi>>) => Promise<{ data?: T; error?: unknown }>,
): Promise<ActionResult<T>> {
  try {
    const api = await tenantApi();
    const { data, error } = await call(api);
    if (data !== undefined) {
      for (const path of paths) revalidatePath(path);
      return { ok: true, data };
    }
    return refusal(error);
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

export async function startLoneWorkerSession(input: {
  readonly id: string;
  readonly locationId: string;
  readonly workKind: LoneWorkerWorkKind;
  readonly lengthMinutes: number;
  readonly intervalMinutes: number;
}): Promise<ActionResult<LoneWorkerOwnSession>> {
  if (!isUuid(input.id)) return refused(t("care.errors.invalid"));
  if (!isUuid(input.locationId)) {
    return refused(t("scheduling.loneWorker.start.locationRequired"), "invalid", ["locationId"]);
  }
  if (!WORK_KINDS.includes(input.workKind)) {
    return refused(t("scheduling.loneWorker.start.kindRequired"), "invalid", ["workKind"]);
  }
  if (!Number.isInteger(input.lengthMinutes) || input.lengthMinutes < 1) {
    return refused(t("scheduling.loneWorker.start.lengthRequired"), "invalid", ["hours"]);
  }
  if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1) {
    return refused(t("scheduling.loneWorker.start.intervalRequired"), "invalid", [
      "intervalMinutes",
    ]);
  }
  // The start is the moment the worker sends the form, by the server's clock.
  const startedAt = new Date();
  const plannedEndAt = new Date(startedAt.getTime() + input.lengthMinutes * 60_000);
  return send(["/lone-working"], async (api) => {
    const created = await api.POST("/v1/lone-worker/sessions", {
      body: {
        id: input.id,
        locationId: input.locationId,
        workKind: input.workKind,
        startedAt: startedAt.toISOString(),
        plannedEndAt: plannedEndAt.toISOString(),
        intervalMinutes: input.intervalMinutes,
      },
    });
    if (created.error !== undefined) return { error: created.error };
    // The worker's screen reads the session back as the worker sees it.
    const mine = await api.GET("/v1/lone-worker/sessions/mine");
    if (mine.data?.session) return { data: mine.data.session };
    return { error: mine.error };
  });
}

/**
 * Check in, ask for help or finish: never duress from the web (H-1140). The time is the web
 * tier's clock when the press arrives: the page is online, so a shared computer's wrong clock
 * neither refuses a check-in nor flags it as late from a device without signal (slice 61 clinical
 * review, finding 8).
 */
export async function recordLoneWorkerEvent(input: {
  readonly sessionId: string;
  readonly id: string;
  readonly kind: "check_in" | "help" | "finish";
}): Promise<ActionResult<LoneWorkerEventResult>> {
  if (!isUuid(input.sessionId) || !isUuid(input.id)) {
    return refused(t("errors.notFound"), "not_found");
  }
  if (!["check_in", "help", "finish"].includes(input.kind))
    return refused(t("care.errors.invalid"));
  const deviceAt = new Date().toISOString();
  return send(["/lone-working"], (api) =>
    api.POST("/v1/lone-worker/sessions/{id}/events", {
      params: { path: { id: input.sessionId } },
      body: { id: input.id, kind: input.kind, deviceAt },
    }),
  );
}

export async function acknowledgeLoneWorkerAlarm(input: {
  readonly alarmId: string;
  readonly outcome: LoneWorkerOutcome;
  readonly note: string;
  readonly version: number;
}): Promise<ActionResult<AcknowledgedLoneWorkerAlarm>> {
  if (!isUuid(input.alarmId)) return refused(t("errors.notFound"), "not_found");
  if (!OUTCOMES.includes(input.outcome)) {
    return refused(t("scheduling.loneWorker.ack.outcomeRequired"), "invalid", ["outcome"]);
  }
  const note = input.note.trim();
  if (note.length === 0 || note.length > 2000) {
    return refused(t("scheduling.loneWorker.ack.noteRequired"), "invalid", ["note"]);
  }
  return send(["/lone-working/board"], async (api) => {
    const post = (version: number) =>
      api.POST("/v1/lone-worker/alarms/{id}/acknowledge", {
        params: { path: { id: input.alarmId } },
        body: { outcome: input.outcome, note, version },
      });
    const first = await post(input.version);
    const code = (first.error as { code?: unknown } | undefined)?.code;
    if (code !== "version_conflict") return first;
    // Each re-alert changes the alarm's version. While it is still open the monitor's answer
    // still holds, so it is sent once more against the version now held (slice 61 clinical
    // review, finding 7); an alarm closed meanwhile is refused as before.
    const open = await api.GET("/v1/lone-worker/alarms");
    const now = open.data?.items.find((a) => a.id === input.alarmId);
    return now && now.state === "open" ? post(now.version) : first;
  });
}

export async function setLoneWorkerRoute(input: {
  readonly steps: readonly LoneWorkerRouteStep[];
  readonly version: number | null;
}): Promise<ActionResult<LoneWorkerRoute>> {
  if (input.steps.length < 1 || input.steps.length > MAX_ROUTE_STEPS) {
    return refused(t("scheduling.loneWorker.route.tooFew"));
  }
  for (const step of input.steps) {
    if (step.targetTenantUserId !== undefined && !isUuid(step.targetTenantUserId)) {
      return refused(t("care.errors.invalid"));
    }
  }
  return send(["/lone-working/route", "/lone-working"], (api) =>
    api.PUT("/v1/lone-worker/route", {
      body: {
        steps: input.steps.map((s) => ({ ...s, channels: [...s.channels] })),
        version: input.version,
      },
    }),
  );
}
