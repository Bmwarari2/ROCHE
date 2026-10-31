"use server";

import type {
  ImportBatch,
  ImportCommitResult,
  ImportDryRunReport,
  ImportUndoResult,
} from "@harbour/contracts";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { IMPORT_PAGE, importPage } from "@/lib/imports";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * The import wizard's steps after upload (PLAT-014; platform.md rules 21 to 26): the dry run,
 * the commit (with the acknowledgements and the no-undo acceptance, and a fresh step-up), undo and
 * discard, as the signed-in member. The API checks every rule again; the web app keeps nothing.
 */

async function send<T>(
  id: string,
  call: (
    api: Awaited<ReturnType<typeof tenantApi>>,
  ) => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<ActionResult<T>> {
  if (!isUuid(id)) return refused(t("errors.notFound"), "not_found");
  try {
    const { data, error, response } = await call(await tenantApi());
    if (!response.ok || data === undefined) return { ok: false, ...problemMessage(error, t) };
    revalidatePath(IMPORT_PAGE);
    revalidatePath(importPage(id));
    return { ok: true, data };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

/** Checks the staged file as committing would, now; nothing is committed. */
export async function dryRunImport(id: string): Promise<ActionResult<ImportDryRunReport>> {
  return send(id, (api) => api.POST("/v1/imports/{id}/dry-run", { params: { path: { id } } }));
}

/** Commits the whole file, listing exactly the warnings shown and ticked. */
export async function commitImport(
  id: string,
  acknowledgedWarnings: readonly string[],
  acceptNoUndo: boolean,
): Promise<ActionResult<ImportCommitResult>> {
  if (!Array.isArray(acknowledgedWarnings) || acknowledgedWarnings.length > 500) {
    return refused(t("import.commit.unchecked"), "invalid");
  }
  const keys = acknowledgedWarnings.filter((k): k is string => typeof k === "string");
  return send(id, (api) =>
    api.POST("/v1/imports/{id}/commit", {
      params: { path: { id } },
      body: { acknowledgedWarnings: keys, acceptNoUndo: acceptNoUndo === true },
    }),
  );
}

/** Removes the people a commit created, once, while undo is available. */
export async function undoImport(id: string): Promise<ActionResult<ImportUndoResult>> {
  return send(id, (api) => api.POST("/v1/imports/{id}/undo", { params: { path: { id } } }));
}

/** Discards a staged file: its staged rows are deleted. */
export async function discardImport(id: string): Promise<ActionResult<ImportBatch>> {
  return send(id, (api) => api.DELETE("/v1/imports/{id}", { params: { path: { id } } }));
}
