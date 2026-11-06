"use server";

import type {
  CheckInItem,
  PulseSurveyItem,
  RecognitionItem,
  SurveyQuestion,
} from "@harbour/contracts";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";
import { isIsoDate } from "@/lib/uk-time";

/**
 * Staff wellbeing writes (scheduling.md section 16), sent to the API as the signed-in person. The
 * API checks every rule again and refuses in its own words. A survey answer goes with nothing
 * about the person: no id, no time, nothing kept by the web app.
 */

async function send<T>(
  paths: readonly string[],
  call: (
    api: Awaited<ReturnType<typeof tenantApi>>,
  ) => Promise<{ data?: T; error?: unknown; response?: Response }>,
  empty?: T,
): Promise<ActionResult<T>> {
  try {
    const api = await tenantApi();
    const { data, error, response } = await call(api);
    const ok = data !== undefined || (empty !== undefined && response?.status === 204);
    if (ok) {
      for (const path of paths) revalidatePath(path);
      return { ok: true, data: (data ?? empty) as T };
    }
    return { ok: false, ...problemMessage(error, t) };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

export async function createSurvey(input: {
  readonly locationId: string | null;
  readonly title: string;
  readonly questions: readonly SurveyQuestion[];
  readonly opensOn: string;
  readonly closesOn: string;
}): Promise<ActionResult<PulseSurveyItem>> {
  if (input.locationId !== null && !isUuid(input.locationId)) {
    return refused(t("scheduling.wellbeing.form.whereRequired"), "invalid", ["locationId"]);
  }
  if (!isIsoDate(input.opensOn) || !isIsoDate(input.closesOn)) {
    return refused(t("care.errors.invalid"));
  }
  return send(["/wellbeing/surveys"], (api) =>
    api.POST("/v1/pulse-surveys", {
      body: {
        locationId: input.locationId,
        title: input.title,
        questions: input.questions.map((q) => ({ ...q })),
        opensOn: input.opensOn,
        closesOn: input.closesOn,
      },
    }),
  );
}

export async function moveSurvey(input: {
  readonly surveyId: string;
  readonly move: "open" | "close";
  readonly version: number;
}): Promise<ActionResult<PulseSurveyItem>> {
  if (!isUuid(input.surveyId)) return refused(t("errors.notFound"), "not_found");
  const params = { path: { id: input.surveyId } };
  const body = { version: input.version };
  return send(["/wellbeing/surveys", `/wellbeing/surveys/${input.surveyId}`], (api) =>
    input.move === "open"
      ? api.POST("/v1/pulse-surveys/{id}/open", { params, body })
      : api.POST("/v1/pulse-surveys/{id}/close", { params, body }),
  );
}

/** One anonymous answer. Nothing comes back but that it was received. */
export async function answerSurvey(input: {
  readonly surveyId: string;
  readonly answers: Readonly<Record<string, number | string>>;
}): Promise<ActionResult<{ readonly received: true }>> {
  if (!isUuid(input.surveyId)) return refused(t("errors.notFound"), "not_found");
  if (Object.keys(input.answers).length === 0) {
    return refused(t("scheduling.wellbeing.answer.atLeastOne"));
  }
  return send(
    ["/wellbeing"],
    (api) =>
      api.POST("/v1/pulse-surveys/{id}/responses", {
        params: { path: { id: input.surveyId } },
        body: { answers: { ...input.answers } },
      }) as Promise<{ data?: { readonly received: true }; error?: unknown; response?: Response }>,
    { received: true },
  );
}

export async function thankColleague(input: {
  readonly toMemberId: string;
  readonly locationId: string;
  readonly message: string;
}): Promise<ActionResult<RecognitionItem>> {
  if (!isUuid(input.toMemberId)) {
    return refused(t("scheduling.wellbeing.thanks.colleagueRequired"), "invalid", ["toMemberId"]);
  }
  if (!isUuid(input.locationId)) {
    return refused(t("scheduling.wellbeing.thanks.whereRequired"), "invalid", ["locationId"]);
  }
  const message = input.message.trim();
  if (message.length === 0 || message.length > 500) {
    return refused(t("scheduling.wellbeing.thanks.messageRequired"), "invalid", ["message"]);
  }
  return send(["/wellbeing"], (api) =>
    api.POST("/v1/recognition", {
      body: { toMemberId: input.toMemberId, locationId: input.locationId, message },
    }),
  );
}

export async function recordCheckIn(input: {
  readonly locationId: string;
  readonly mood: number;
  readonly note: string;
  readonly share: boolean;
}): Promise<ActionResult<CheckInItem>> {
  if (!isUuid(input.locationId)) {
    return refused(t("scheduling.wellbeing.checkIn.whereRequired"), "invalid", ["locationId"]);
  }
  if (!Number.isInteger(input.mood) || input.mood < 1 || input.mood > 5) {
    return refused(t("scheduling.wellbeing.checkIn.moodRequired"), "invalid", ["mood"]);
  }
  const note = input.note.trim();
  if (note.length > 1000) {
    return refused(t("scheduling.wellbeing.checkIn.noteTooLong"), "invalid", ["note"]);
  }
  return send(["/wellbeing"], (api) =>
    api.POST("/v1/wellbeing-check-ins", {
      body: {
        locationId: input.locationId,
        mood: input.mood,
        note: note.length > 0 ? note : null,
        share: input.share === true,
      },
    }),
  );
}

export async function shareCheckIn(input: {
  readonly checkInId: string;
  readonly shared: boolean;
}): Promise<ActionResult<CheckInItem>> {
  if (!isUuid(input.checkInId)) return refused(t("errors.notFound"), "not_found");
  return send(["/wellbeing"], (api) =>
    api.POST("/v1/wellbeing-check-ins/{id}/sharing", {
      params: { path: { id: input.checkInId } },
      body: { shared: input.shared === true },
    }),
  );
}
