"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import {
  actionsMessage,
  actionsProblem,
  BREAK_GLASS_REPORT_PAGE,
  reviewProblem,
} from "@/lib/break-glass-report";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * Records the review of a weekly break-glass report with the actions taken (PLAT-006, HZ-011), as
 * the signed-in person. The API checks the permission, the report's location, that the reviewer
 * is not flagged in it and that it is reviewed once; the web app keeps nothing.
 */
export async function reviewBreakGlassReport(
  reportId: string,
  actionsTaken: string,
): Promise<ActionResult<null>> {
  if (!isUuid(reportId)) return refused(t("errors.notFound"), "not_found");
  const problem = actionsProblem(actionsTaken);
  if (problem) {
    return refused(actionsMessage(problem, t), "invalid", ["actionsTaken"]);
  }
  try {
    const api = await tenantApi();
    const { response, error } = await api.POST("/v1/break-glass/weekly-report/{reportId}/review", {
      params: { path: { reportId } },
      body: { actionsTaken: actionsTaken.trim() },
    });
    if (!response.ok) return { ok: false, ...reviewProblem(problemMessage(error, t), t) };
    revalidatePath(BREAK_GLASS_REPORT_PAGE, "layout");
    return { ok: true, data: null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}
