"use server";

import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import type { DevelopmentValues } from "@/lib/development";
import { t } from "@/lib/i18n";
import { type ActionResult, fieldErrors, problemMessage } from "@/lib/outcome";

/**
 * The training, competence, supervision and revalidation writes (plan slice 57). Each goes to the
 * API as the signed-in person, which checks the permission, the version loaded, that nobody records
 * about themselves, and every rule again; the web holds nothing of its own. The values come from
 * `DevelopmentForm`, already checked for what is required.
 */

type Values = DevelopmentValues;

async function send<T>(
  call: (api: ApiClient) => Promise<{ data?: T; error?: unknown }>,
): Promise<ActionResult<T>> {
  try {
    const api = await tenantApi();
    const { data, error } = await call(api);
    if (data !== undefined) {
      revalidatePath("/training", "layout");
      return { ok: true, data };
    }
    return { ok: false, ...problemMessage(error, t) };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

const str = (v: Values, k: string): string | null => {
  const value = v[k];
  return typeof value === "string" && value !== "" ? value : null;
};
const req = (v: Values, k: string): string => str(v, k) ?? "";
const bool = (v: Values, k: string): boolean => v[k] === true;
const bad = (): ActionResult<never> => ({ ok: false, ...problemMessage(undefined, t) });

/** A whole number in a range, or the words for the field that is not one. */
function whole(
  v: Values,
  k: string,
  min: number,
  max: number,
): { ok: true; value: number | null } | { ok: false; message: string } {
  const raw = str(v, k);
  if (raw === null) return { ok: true, value: null };
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) {
    return { ok: false, message: t("development.form.number", { min, max }) };
  }
  return { ok: true, value: n };
}

const tierOf = (v: Values): 1 | 2 | null => {
  const tier = str(v, "tier");
  return tier === "1" ? 1 : tier === "2" ? 2 : null;
};

export async function setRequirement(values: Values): Promise<ActionResult<unknown>> {
  const topic = req(values, "topic");
  const roleKey = req(values, "roleKey");
  const refresh = whole(values, "refreshYears", 1, 10);
  if (!refresh.ok) return fieldErrors({ refreshYears: refresh.message });
  const tier = topic === "oliver_mcgowan" ? (tierOf(values) ?? 1) : null;
  return send(async (api) => {
    // The version loaded, when the role already has a requirement for the topic.
    const listed = await api.GET("/v1/workforce/training-requirements");
    const existing = listed.data?.items.find((r) => r.roleKey === roleKey && r.topic === topic);
    return api.PUT("/v1/workforce/training-requirements", {
      body: {
        roleKey,
        topic: topic as never,
        refreshYears: refresh.value,
        tier,
        active: bool(values, "active"),
        ...(existing ? { expectedVersion: existing.version } : {}),
      },
    });
  });
}

const trainingBody = (values: Values) => {
  const topic = req(values, "topic");
  return {
    topic: topic as never,
    tier: topic === "oliver_mcgowan" ? (tierOf(values) ?? 1) : null,
    completedOn: req(values, "completedOn"),
    expiresOn: str(values, "expiresOn"),
    provider: str(values, "provider"),
  };
};

export async function recordTraining(
  memberId: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(memberId)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/members/{memberId}/training-records", {
      params: { path: { memberId } },
      body: trainingBody(values),
    }),
  );
}

export async function correctTraining(
  memberId: string,
  recordId: string,
  version: number,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(memberId) || !isUuid(recordId)) return bad();
  return send((api) =>
    api.PATCH("/v1/workforce/members/{memberId}/training-records/{recordId}", {
      params: { path: { memberId, recordId } },
      body: { expectedVersion: version, ...trainingBody(values) },
    }),
  );
}

export async function signOffCompetence(
  memberId: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(memberId)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/members/{memberId}/competences", {
      params: { path: { memberId } },
      body: {
        competence: req(values, "competence") as never,
        observedOn: req(values, "observedOn"),
      },
    }),
  );
}

export async function withdrawCompetence(
  memberId: string,
  signOffId: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(memberId) || !isUuid(signOffId)) return bad();
  const reason = req(values, "reason");
  if (reason.length < 10) return fieldErrors({ reason: t("development.competence.reasonShort") });
  return send((api) =>
    api.POST("/v1/workforce/members/{memberId}/competences/{signOffId}/withdraw", {
      params: { path: { memberId, signOffId } },
      body: { reason },
    }),
  );
}

export async function recordSupervision(
  memberId: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(memberId)) return bad();
  const discussion = str(values, "discussion");
  const actions = str(values, "actions");
  if (discussion !== null && discussion.length < 10) {
    return fieldErrors({ discussion: t("development.supervision.discussionShort") });
  }
  if (discussion === null && actions !== null) {
    return fieldErrors({ discussion: t("development.supervision.discussionNeeded") });
  }
  return send((api) =>
    api.POST("/v1/workforce/members/{memberId}/supervisions", {
      params: { path: { memberId } },
      body: {
        kind: req(values, "kind") as never,
        heldOn: req(values, "heldOn"),
        note: discussion === null ? null : { discussion, actions },
      },
    }),
  );
}

const REVALIDATION_NUMBERS = [
  ["practiceHours", 10000],
  ["cpdHours", 1000],
  ["participatoryCpdHours", 1000],
  ["feedbackPieces", 100],
  ["reflectiveAccounts", 100],
] as const;

export async function saveRevalidation(
  memberId: string,
  version: number | null,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(memberId)) return bad();
  const numbers: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const [name, max] of REVALIDATION_NUMBERS) {
    const read = whole(values, name, 0, max);
    if (!read.ok) errors[name] = read.message;
    else numbers[name] = read.value ?? 0;
  }
  if (Object.keys(errors).length > 0) return fieldErrors(errors);
  return send((api) =>
    api.PUT("/v1/workforce/members/{memberId}/revalidation", {
      params: { path: { memberId } },
      body: {
        ...(version === null ? {} : { expectedVersion: version }),
        cycleDueOn: req(values, "cycleDueOn"),
        practiceHours: numbers.practiceHours ?? 0,
        cpdHours: numbers.cpdHours ?? 0,
        participatoryCpdHours: numbers.participatoryCpdHours ?? 0,
        feedbackPieces: numbers.feedbackPieces ?? 0,
        reflectiveAccounts: numbers.reflectiveAccounts ?? 0,
        reflectiveDiscussion: bool(values, "reflectiveDiscussion"),
        healthAndCharacter: bool(values, "healthAndCharacter"),
        professionalIndemnity: bool(values, "professionalIndemnity"),
        confirmation: bool(values, "confirmation"),
      },
    }),
  );
}

export async function saveSupervisionNote(
  memberId: string,
  supervisionId: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(memberId) || !isUuid(supervisionId)) return bad();
  const discussion = req(values, "discussion");
  if (discussion.length < 10) {
    return fieldErrors({ discussion: t("development.supervision.discussionShort") });
  }
  return send((api) =>
    api.POST("/v1/workforce/members/{memberId}/supervisions/{supervisionId}/notes", {
      params: { path: { memberId, supervisionId } },
      body: { discussion, actions: str(values, "actions") },
    }),
  );
}
