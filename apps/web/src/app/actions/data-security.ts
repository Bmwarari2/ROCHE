"use server";

import {
  ChangeDsptAssertion,
  CorrectDsptSubmission,
  LinkDsptEvidence,
  RecordDsptAssertion,
  RecordDsptSubmission,
  RecordSecurityCertificate,
} from "@harbour/contracts";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { sendQuality } from "@/lib/quality-actions";

/**
 * Writes for the data security evidence screens (quality.md section 22; QUAL-012). Every input is
 * checked against the API's contract here; the API checks permissions and rules and audits.
 */

const BASE = "/quality/data-security";
const invalid = () => refused(t("care.errors.invalid"));
const notFound = () => refused(t("errors.notFound"), "not_found");
type Done = ActionResult<{ readonly id: string }>;
const idOnly = <T extends { id: string } | null>(r: ActionResult<T>): Done =>
  r.ok ? { ok: true, data: { id: r.data?.id ?? "" } } : r;
const ASSERTIONS = [BASE, `${BASE}/assertions`];

export async function recordAssertion(body: unknown): Promise<Done> {
  const parsed = RecordDsptAssertion.safeParse(body);
  if (!parsed.success) return invalid();
  return idOnly(
    await sendQuality("dataSecurity", ASSERTIONS, (api) =>
      api.POST("/v1/data-security/dspt/assertions", { body: parsed.data }),
    ),
  );
}

export async function changeAssertion(id: string, body: unknown): Promise<Done> {
  if (!isUuid(id)) return notFound();
  const parsed = ChangeDsptAssertion.safeParse(body);
  if (!parsed.success) return invalid();
  return idOnly(
    await sendQuality("dataSecurity", ASSERTIONS, (api) =>
      api.POST("/v1/data-security/dspt/assertions/{id}/status", {
        params: { path: { id } },
        body: parsed.data,
      }),
    ),
  );
}

export async function linkEvidence(id: string, body: unknown): Promise<Done> {
  if (!isUuid(id)) return notFound();
  const parsed = LinkDsptEvidence.safeParse(body);
  if (!parsed.success) return invalid();
  return idOnly(
    await sendQuality("dataSecurity", ASSERTIONS, (api) =>
      api.POST("/v1/data-security/dspt/assertions/{id}/evidence", {
        params: { path: { id } },
        body: parsed.data,
      }),
    ),
  );
}

export async function unlinkEvidence(id: string, documentId: string): Promise<Done> {
  if (!isUuid(id) || !isUuid(documentId)) return notFound();
  return idOnly(
    await sendQuality("dataSecurity", ASSERTIONS, (api) =>
      api.POST("/v1/data-security/dspt/assertions/{id}/evidence/{documentId}/unlink", {
        params: { path: { id, documentId } },
      }),
    ),
  );
}

export async function recordSubmission(body: unknown): Promise<Done> {
  const parsed = RecordDsptSubmission.safeParse(body);
  if (!parsed.success) return invalid();
  return idOnly(
    await sendQuality("dataSecurity", [BASE, `${BASE}/submissions`], (api) =>
      api.POST("/v1/data-security/dspt/submissions", { body: parsed.data }),
    ),
  );
}

export async function correctSubmission(id: string, body: unknown): Promise<Done> {
  if (!isUuid(id)) return notFound();
  const parsed = CorrectDsptSubmission.safeParse(body);
  if (!parsed.success) return invalid();
  return idOnly(
    await sendQuality("dataSecurity", [BASE, `${BASE}/submissions`], (api) =>
      api.POST("/v1/data-security/dspt/submissions/{id}/correct", {
        params: { path: { id } },
        body: parsed.data,
      }),
    ),
  );
}

export async function recordCertificate(body: unknown): Promise<Done> {
  const parsed = RecordSecurityCertificate.safeParse(body);
  if (!parsed.success) return invalid();
  return idOnly(
    await sendQuality("dataSecurity", [BASE, `${BASE}/certificates`], (api) =>
      api.POST("/v1/data-security/certificates", { body: parsed.data }),
    ),
  );
}
