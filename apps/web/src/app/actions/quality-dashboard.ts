"use server";

import { ClearQualityIndicatorTarget, SetQualityIndicatorTarget } from "@harbour/contracts";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { sendQuality } from "@/lib/quality-actions";

/**
 * Writes for the quality dashboard's targets (quality.md section 22, rule 41; QUAL-005). Server
 * actions are public endpoints: every input is checked against the API's contract here and
 * anything malformed is refused, never passed on. The API checks the permission at the place, the
 * direction, the percentage range and that a location's target is no looser than the
 * organisation's.
 */

const PATHS = ["/quality/dashboard", "/quality/dashboard/targets"];
const invalid = () => refused(t("care.errors.invalid"));
type Done = ActionResult<{ readonly id: string }>;

export async function setIndicatorTarget(body: unknown): Promise<Done> {
  const parsed = SetQualityIndicatorTarget.safeParse(body);
  if (!parsed.success) return invalid();
  const result = await sendQuality(
    "target",
    PATHS,
    (api) => api.PUT("/v1/quality/indicator-targets", { body: parsed.data }),
    {
      wrong_order: { field: "green" },
      percent_range: { field: "green" },
      looser_than_organisation: { field: "green" },
      already_set: { field: "green" },
    },
  );
  return result.ok ? { ok: true, data: { id: result.data.id } } : result;
}

export async function clearIndicatorTarget(id: string, body: unknown): Promise<Done> {
  if (!isUuid(id)) return refused(t("errors.notFound"), "not_found");
  const parsed = ClearQualityIndicatorTarget.safeParse(body);
  if (!parsed.success) return invalid();
  const result = await sendQuality("target", PATHS, (api) =>
    api.POST("/v1/quality/indicator-targets/{id}/clear", {
      params: { path: { id } },
      body: parsed.data,
    }),
  );
  return result.ok ? { ok: true, data: { id } } : result;
}
