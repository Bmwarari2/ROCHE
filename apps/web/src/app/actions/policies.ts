"use server";

import {
  CreatePolicy,
  NewPolicyVersion,
  PublishPolicyVersion,
  RetirePolicy,
  UpdatePolicyVersion,
} from "@harbour/contracts";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { sendQuality } from "@/lib/quality-actions";

/**
 * Writes for the policy library (quality.md section 22; QUAL-008; HZ-128). Server actions are
 * public endpoints: every input is checked against the API's contract here and anything malformed
 * is refused, never passed on. The API checks permissions, the second reviewer and every rule.
 */

const LIBRARY = "/policies";
const invalid = () => refused(t("care.errors.invalid"));
const notFound = () => refused(t("errors.notFound"), "not_found");
type Done = ActionResult<{ readonly id: string }>;
const paths = (id: string) => [LIBRARY, `${LIBRARY}/${id}`];
const done =
  (id: string) =>
  (r: ActionResult<unknown>): Done =>
    r.ok ? { ok: true, data: { id } } : r;

export async function createPolicy(body: unknown): Promise<Done> {
  const parsed = CreatePolicy.safeParse(body);
  if (!parsed.success) return invalid();
  // The only conflict a new policy meets is a short name already in use.
  const result = await sendQuality(
    "policy",
    [LIBRARY],
    (api) => api.POST("/v1/policies", { body: parsed.data }),
    { invalid_state: { field: "policyKey", message: t("quality.policies.form.keyTaken") } },
  );
  return result.ok ? { ok: true, data: { id: result.data.id } } : result;
}

export async function startPolicyDraft(id: string, body: unknown): Promise<Done> {
  if (!isUuid(id)) return notFound();
  const parsed = NewPolicyVersion.safeParse(body);
  if (!parsed.success) return invalid();
  return done(id)(
    await sendQuality("policy", paths(id), (api) =>
      api.POST("/v1/policies/{id}/versions", { params: { path: { id } }, body: parsed.data }),
    ),
  );
}

export async function savePolicyDraft(id: string, versionId: string, body: unknown): Promise<Done> {
  if (!isUuid(id) || !isUuid(versionId)) return notFound();
  const parsed = UpdatePolicyVersion.safeParse(body);
  if (!parsed.success) return invalid();
  return done(id)(
    await sendQuality("policy", paths(id), (api) =>
      api.PATCH("/v1/policies/{id}/versions/{versionId}", {
        params: { path: { id, versionId } },
        body: parsed.data,
      }),
    ),
  );
}

export async function publishPolicy(id: string, versionId: string, body: unknown): Promise<Done> {
  if (!isUuid(id) || !isUuid(versionId)) return notFound();
  const parsed = PublishPolicyVersion.safeParse(body);
  if (!parsed.success) return invalid();
  return done(id)(
    await sendQuality("policy", paths(id), (api) =>
      api.POST("/v1/policies/{id}/versions/{versionId}/publish", {
        params: { path: { id, versionId } },
        body: parsed.data,
      }),
    ),
  );
}

export async function retirePolicy(id: string, body: unknown): Promise<Done> {
  if (!isUuid(id)) return notFound();
  const parsed = RetirePolicy.safeParse(body);
  if (!parsed.success) return invalid();
  return done(id)(
    await sendQuality("policy", paths(id), (api) =>
      api.POST("/v1/policies/{id}/retire", { params: { path: { id } }, body: parsed.data }),
    ),
  );
}

export async function signPolicy(id: string, versionId: string): Promise<Done> {
  if (!isUuid(id) || !isUuid(versionId)) return notFound();
  return done(id)(
    await sendQuality("policy", paths(id), (api) =>
      api.POST("/v1/policies/{id}/versions/{versionId}/signatures", {
        params: { path: { id, versionId } },
      }),
    ),
  );
}
