"use server";

import type { ApiClient } from "@harbour/contracts/client";
import type { HrOwners } from "@harbour/domain";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  HR_LINK_PAGE,
  type HrLinkForm,
  hrLinkProblem,
  type PayRoute,
  type ReleaseReason,
  validConnect,
  validOwners,
  validPayCodes,
  validPayRoute,
  validReleaseReason,
  validStaleness,
  validVersion,
} from "@/lib/hr-link";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";

/**
 * The link to the HR platform's writes (integrations.md sections 11.5 and 11.6; slice 90). The
 * API checks every permission, the fresh step-up, the expected version and each rule again; the
 * web keeps nothing. Each input is checked again here, where the browser's values reach the
 * server, with the API's own limits (lib/hr-link.ts; zod is not a dependency of the web app). A
 * refusal comes back in the catalogue's words, tied to its field.
 */

const HR_ID = /^[A-Za-z0-9_-]{1,64}$/;

async function send<T>(
  form: HrLinkForm,
  call: (api: ApiClient) => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<ActionResult<T | null>> {
  try {
    const { data, error, response } = await call(await tenantApi());
    if (!response.ok) return { ok: false, ...hrLinkProblem(error, form, t) };
    revalidatePath(HR_LINK_PAGE);
    return { ok: true, data: data ?? null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...hrLinkProblem(undefined, form, t) };
  }
}

const notFound = () => refused(t("errors.notFound"), "not_found");
const invalid = () => refused(t("care.errors.invalid"));
const version = validVersion;

export async function connectHrLink(body: {
  readonly workspaceSlug: string;
  readonly secretRef: string | null;
}) {
  if (!validConnect(body)) return invalid();
  const { workspaceSlug, secretRef } = body;
  return send("connect", (api) =>
    api.POST("/v1/integrations/hr-link", { body: { workspaceSlug, secretRef } }),
  );
}

export async function changeHrLinkSettings(input: {
  readonly expectedVersion: number;
  readonly owners: HrOwners;
  readonly stalenessMinutes: number;
}) {
  if (!version(input.expectedVersion)) return notFound();
  if (!validOwners(input.owners) || !validStaleness(input.stalenessMinutes)) return invalid();
  return send("settings", (api) =>
    api.PATCH("/v1/integrations/hr-link", {
      body: {
        expectedVersion: input.expectedVersion,
        owners: { ...input.owners },
        stalenessMinutes: input.stalenessMinutes,
      },
    }),
  );
}

export async function changePayRoute(input: {
  readonly expectedVersion: number;
  readonly route: PayRoute;
  readonly from: string;
}) {
  if (!version(input.expectedVersion)) return notFound();
  if (!validPayRoute(input.route, input.from)) return invalid();
  return send("payRoute", (api) =>
    api.PATCH("/v1/integrations/hr-link", {
      body: {
        expectedVersion: input.expectedVersion,
        payRoute: { route: input.route, from: input.from },
      },
    }),
  );
}

export async function changePayCodes(input: {
  readonly expectedVersion: number;
  readonly codes: Readonly<Record<string, string>>;
}) {
  if (!version(input.expectedVersion)) return notFound();
  if (!validPayCodes(input.codes)) return invalid();
  return send("payCodes", (api) =>
    api.PATCH("/v1/integrations/hr-link", {
      body: { expectedVersion: input.expectedVersion, payCodes: { ...input.codes } },
    }),
  );
}

export async function disconnectHrLink() {
  return send("check", (api) => api.DELETE("/v1/integrations/hr-link"));
}

export async function testHrLink() {
  return send("check", (api) => api.POST("/v1/integrations/hr-link/test"));
}

export async function syncHrLink() {
  return send("check", (api) => api.POST("/v1/integrations/hr-link/sync"));
}

export async function mapHrLocation(input: {
  readonly locationId: string;
  readonly hrLocationId: string | null;
}) {
  if (!isUuid(input.locationId)) return notFound();
  if (input.hrLocationId !== null && !HR_ID.test(input.hrLocationId)) return notFound();
  return send("location", (api) =>
    api.PUT("/v1/integrations/hr-link/locations/{locationId}", {
      params: { path: { locationId: input.locationId } },
      body: { hrLocationId: input.hrLocationId },
    }),
  );
}

export async function confirmHrMatch(input: {
  readonly id: string;
  readonly version: number;
  readonly staffProfileId: string;
}) {
  if (!isUuid(input.id) || !isUuid(input.staffProfileId) || !version(input.version)) {
    return notFound();
  }
  return send("match", (api) =>
    api.POST("/v1/integrations/hr-link/matches/{id}/confirm", {
      params: { path: { id: input.id } },
      body: { staffProfileId: input.staffProfileId, expectedVersion: input.version },
    }),
  );
}

export async function rejectHrMatch(input: { readonly id: string; readonly version: number }) {
  if (!isUuid(input.id) || !version(input.version)) return notFound();
  return send("match", (api) =>
    api.POST("/v1/integrations/hr-link/matches/{id}/reject", {
      params: { path: { id: input.id } },
      body: { expectedVersion: input.version },
    }),
  );
}

export async function releaseHrCopies(input: {
  readonly expectedHrIds: readonly string[];
  readonly reason: ReleaseReason;
}) {
  const ids = [...new Set(input.expectedHrIds)];
  if (ids.length === 0 || ids.length > 10_000 || !ids.every((id) => HR_ID.test(id))) {
    return notFound();
  }
  if (!validReleaseReason(input.reason)) return invalid();
  return send("release", (api) =>
    api.POST("/v1/integrations/hr-link/absences/release", {
      body: { expectedHrIds: ids, reason: input.reason },
    }),
  );
}
