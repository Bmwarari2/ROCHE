/**
 * Turns what a course taken offline queued (`elearning_outbox`; mobile slice 72) into a request to
 * the API's own route for it: the attempt started on the phone to
 * `PUT /v1/workforce/elearning/offline-attempts/{id}`, a SCORM commit to
 * `PATCH /v1/workforce/elearning/attempts/{id}` and xAPI statements to
 * `POST /v1/workforce/elearning/attempts/{id}/statements`. Each row's id is its idempotency key,
 * the attempt is started by the phone's id and each statement carries its own, so a resend
 * records once. `POST /v1/sync/upload` writes none of them.
 *
 * Pure, so the mapping is tested without a device. A row that cannot become a valid request is
 * refused here, in words, and kept as "needs attention" by the connector.
 */
import { TRAINING_WRITABLE_TABLES, type TrainingWritableTable } from "@harbour/sync/client";
import { t } from "../i18n/t";
import type { CrudEntryLike } from "./connector";

export function isTrainingWritableTable(table: string): table is TrainingWritableTable {
  return (TRAINING_WRITABLE_TABLES as readonly string[]).includes(table);
}

export interface TrainingUploadRequest {
  readonly kind: "request";
  readonly table: TrainingWritableTable;
  readonly recordId: string;
  readonly tenantId: string;
  readonly method: "PUT" | "PATCH" | "POST";
  readonly path: string;
  readonly body: unknown;
}

export interface TrainingUploadRefusal {
  readonly kind: "refused";
  readonly table: TrainingWritableTable;
  readonly recordId: string;
  readonly tenantId: string | null;
  readonly code: "training_change_unreadable";
  readonly message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function json(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function toTrainingUpload(
  entry: CrudEntryLike & { readonly table: TrainingWritableTable },
): TrainingUploadRequest | TrainingUploadRefusal {
  const data = entry.opData ?? {};
  const tenantId = text(data.tenant_id);
  const attemptId = text(data.attempt_id);
  const refused = (): TrainingUploadRefusal => ({
    kind: "refused",
    table: entry.table,
    recordId: entry.id,
    tenantId,
    code: "training_change_unreadable",
    message: t("mobile.training.unreadable"),
  });
  if (entry.op !== "PUT" || !tenantId || !UUID.test(entry.id)) return refused();
  if (!attemptId || !UUID.test(attemptId)) return refused();
  const body = json(data.body);
  const request = (method: TrainingUploadRequest["method"], path: string, sent: unknown) =>
    ({
      kind: "request",
      table: entry.table,
      recordId: entry.id,
      tenantId,
      method,
      path,
      body: sent,
    }) satisfies TrainingUploadRequest;
  const attempt = encodeURIComponent(attemptId);
  switch (data.action) {
    case "start": {
      // The row's id is the attempt's own: the idempotency key and the client id agree.
      if (entry.id !== attemptId || !isObject(body)) return refused();
      const { courseId, packageSha256 } = body;
      if (typeof courseId !== "string" || !UUID.test(courseId)) return refused();
      if (typeof packageSha256 !== "string" || !/^[0-9a-f]{64}$/.test(packageSha256)) {
        return refused();
      }
      return request("PUT", `/v1/workforce/elearning/offline-attempts/${attempt}`, {
        courseId,
        packageSha256,
      });
    }
    case "commit": {
      if (!isObject(body) || !isObject(body.cmi) || typeof body.finished !== "boolean") {
        return refused();
      }
      if (Object.values(body.cmi).some((v) => typeof v !== "string")) return refused();
      return request("PATCH", `/v1/workforce/elearning/attempts/${attempt}`, {
        cmi: body.cmi,
        finished: body.finished,
      });
    }
    case "statements": {
      if (!Array.isArray(body) || body.length === 0 || body.length > 50) return refused();
      // Each statement keeps the id the phone gave it, so a resend is kept once.
      if (!body.every((s) => isObject(s) && typeof s.id === "string" && UUID.test(s.id))) {
        return refused();
      }
      return request("POST", `/v1/workforce/elearning/attempts/${attempt}/statements`, body);
    }
    default:
      return refused();
  }
}
