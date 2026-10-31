"use server";

import {
  CompleteAudit,
  CreateAuditSchedule,
  CreateAuditTemplate,
  CreateEvidenceLink,
  RemoveEvidenceLink,
  SaveAuditAnswers,
  SaveFrameworkMapping,
  StartAudit,
} from "@harbour/contracts";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { sendQuality } from "@/lib/quality-actions";

/**
 * Writes for the framework, evidence library and audit programme screens (quality.md section 20;
 * QUAL-001, QUAL-002, QUAL-004). Server actions are public endpoints: every input is checked
 * against the API's own contract here and anything malformed is refused, never passed on. The
 * API checks every permission and rule again, and audits.
 */

const FRAMEWORK = "/quality/framework";
const AUDITS = "/quality/audits";
const invalid = () => refused(t("care.errors.invalid"));
const notFound = () => refused(t("errors.notFound"), "not_found");
type Done = ActionResult<{ readonly id: string }>;
const idOnly = <T extends { id: string }>(r: ActionResult<T>): Done =>
  r.ok ? { ok: true, data: { id: r.data.id } } : r;

export async function saveMapping(frameworkId: string, body: unknown): Promise<Done> {
  if (!isUuid(frameworkId)) return notFound();
  const parsed = SaveFrameworkMapping.safeParse(body);
  if (!parsed.success) return invalid();
  const result = await sendQuality("framework", [`${FRAMEWORK}/${frameworkId}`], (api) =>
    api.PUT("/v1/quality/frameworks/{id}/mapping", {
      params: { path: { id: frameworkId } },
      body: parsed.data,
    }),
  );
  return result.ok ? { ok: true, data: { id: frameworkId } } : result;
}

export async function tagEvidence(body: unknown): Promise<Done> {
  const parsed = CreateEvidenceLink.safeParse(body);
  if (!parsed.success) return invalid();
  return idOnly(
    await sendQuality("evidence", [FRAMEWORK, "/quality/evidence/tag"], (api) =>
      api.POST("/v1/evidence-links", { body: parsed.data }),
    ),
  );
}

export async function untagEvidence(linkId: string, body: unknown): Promise<Done> {
  if (!isUuid(linkId)) return notFound();
  const parsed = RemoveEvidenceLink.safeParse(body);
  if (!parsed.success) return invalid();
  return idOnly(
    await sendQuality("evidence", [FRAMEWORK, "/quality/evidence/tag"], (api) =>
      api.POST("/v1/evidence-links/{id}/remove", {
        params: { path: { id: linkId } },
        body: parsed.data,
      }),
    ),
  );
}

export async function addAuditTemplate(body: unknown): Promise<Done> {
  const parsed = CreateAuditTemplate.safeParse(body);
  if (!parsed.success) return invalid();
  return idOnly(
    await sendQuality("audit", [AUDITS, `${AUDITS}/templates`], (api) =>
      api.POST("/v1/quality/audit-templates", { body: parsed.data }),
    ),
  );
}

export async function retireAuditTemplate(id: string, version: number): Promise<Done> {
  if (!isUuid(id)) return notFound();
  if (!Number.isInteger(version) || version < 1) return invalid();
  return idOnly(
    await sendQuality(
      "audit",
      [AUDITS, `${AUDITS}/templates`, `${AUDITS}/templates/${id}`],
      (api) =>
        api.POST("/v1/quality/audit-templates/{id}/retire", {
          params: { path: { id } },
          body: { version },
        }),
    ),
  );
}

export async function scheduleAudit(body: unknown): Promise<Done> {
  const parsed = CreateAuditSchedule.safeParse(body);
  if (!parsed.success) return invalid();
  return idOnly(
    await sendQuality("audit", [AUDITS, `${AUDITS}/templates/${parsed.data.templateId}`], (api) =>
      api.POST("/v1/quality/audit-schedules", { body: parsed.data }),
    ),
  );
}

export async function startAudit(body: unknown): Promise<Done> {
  const parsed = StartAudit.safeParse(body);
  if (!parsed.success) return invalid();
  return idOnly(
    await sendQuality("audit", [AUDITS], (api) =>
      api.POST("/v1/quality/audits", { body: parsed.data }),
    ),
  );
}

export async function saveAuditAnswers(id: string, body: unknown): Promise<Done> {
  if (!isUuid(id)) return notFound();
  const parsed = SaveAuditAnswers.safeParse(body);
  if (!parsed.success) return invalid();
  return idOnly(
    await sendQuality("audit", [AUDITS, `${AUDITS}/${id}`], (api) =>
      api.PUT("/v1/quality/audits/{id}/answers", {
        params: { path: { id } },
        body: parsed.data,
      }),
    ),
  );
}

export async function completeAudit(id: string, body: unknown): Promise<Done> {
  if (!isUuid(id)) return notFound();
  const parsed = CompleteAudit.safeParse(body);
  if (!parsed.success) return invalid();
  return idOnly(
    await sendQuality("audit", [AUDITS, `${AUDITS}/${id}`], (api) =>
      api.POST("/v1/quality/audits/{id}/complete", {
        params: { path: { id } },
        body: parsed.data,
      }),
    ),
  );
}
