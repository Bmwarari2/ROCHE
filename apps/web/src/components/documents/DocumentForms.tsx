"use client";

import { Button, Checkbox, TextField } from "@harbour/ui";
import { FilePlus, FileUp, PenLine } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { signDocument } from "@/app/actions/documents";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import {
  FILE_NAME_HEADER,
  TITLE_HEADER,
  UPLOAD_PATH,
  type UploadAnswer,
} from "@/lib/document-upload";
import {
  DEFAULT_SIGNATURE_STATEMENT,
  DOCUMENTS_PAGE,
  documentPage,
  ORGANISATION_LIMIT_MB,
  readSignature,
  readUpload,
  SIGNER_NAME_MAX,
  TITLE_MAX,
} from "@/lib/documents";
import { t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const MB = ORGANISATION_LIMIT_MB;

/**
 * Sends the file to this site's upload route as the request body (not a server action, so no
 * other form accepts a large body); the route checks the origin, type and size and streams it to
 * the API. Answers as a server action would, so the form says a refusal the same way.
 */
async function sendUpload(
  target: { readonly versionOf: string } | { readonly title: string; readonly fileName: string },
  file: File,
): Promise<UploadAnswer> {
  // The title and file name travel in headers, percent-encoded, never in the address.
  const metadata: Record<string, string> =
    "versionOf" in target
      ? {}
      : {
          [TITLE_HEADER]: encodeURIComponent(target.title),
          [FILE_NAME_HEADER]: encodeURIComponent(target.fileName),
        };
  const query = "versionOf" in target ? `?${new URLSearchParams(target).toString()}` : "";
  try {
    const response = await fetch(`${UPLOAD_PATH}${query}`, {
      method: "POST",
      body: file,
      headers: { "content-type": file.type || "application/pdf", ...metadata },
      credentials: "same-origin",
    });
    return (await response.json()) as UploadAnswer;
  } catch {
    return { ok: false, code: "unavailable", message: t("care.errors.unavailable") };
  }
}

/** Opens `path` saying what was done; `at` makes each a new arrival. */
function arrive(path: string, done: string) {
  return `${path}?done=${done}&at=${Date.now()}`;
}

function useDocumentSend() {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = (
    call: () => Promise<ActionResult<{ id: string } | null>>,
    then: (data: { id: string } | null) => string,
    form: HTMLFormElement,
  ) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) {
        form.reset();
        router.replace(then(outcome.data), { scroll: false });
        router.refresh();
      }
    });
  return { result, pending, send, setResult };
}

/** Uploads an organisation document (PDF, up to 25 MB) with its title. */
export function UploadDocumentForm() {
  const ids = useFieldIds(["title", "file"]);
  const { result, pending, send, setResult } = useDocumentSend();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const read = readUpload(form, t, { needsTitle: true });
    if (!read.ok) return setResult(fieldErrors(read.errors));
    send(
      () => sendUpload({ title: read.title, fileName: read.file.name }, form.get("file") as File),
      (data) =>
        data ? arrive(documentPage(data.id), "uploaded") : arrive(DOCUMENTS_PAGE, "uploaded"),
      formElement,
    );
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.title}
        name="title"
        label={t("documents.upload.title")}
        hint={t("documents.upload.titleHint")}
        maxLength={TITLE_MAX}
        autoComplete="off"
        required
        error={errorFor(result, "title")}
      />
      <TextField
        id={ids.file}
        name="file"
        type="file"
        accept="application/pdf,.pdf"
        label={t("documents.upload.file")}
        hint={t("documents.upload.fileHint", { mb: MB })}
        required
        error={errorFor(result, "file")}
      />
      <div>
        <Button type="submit" icon={<FileUp {...icon} />} disabled={pending}>
          {pending ? t("documents.upload.sending") : t("documents.upload.submit")}
        </Button>
      </div>
      {result && !result.ok ? <FormFeedback result={result} success="" fieldIds={ids} /> : null}
    </form>
  );
}

/** Adds a new version of a document; the earlier one is kept and its signatures stay with it. */
export function NewVersionForm({ id }: { readonly id: string }) {
  const ids = useFieldIds(["file"]);
  const { result, pending, send, setResult } = useDocumentSend();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const read = readUpload(form, t, { needsTitle: false });
    if (!read.ok) return setResult(fieldErrors(read.errors));
    send(
      () => sendUpload({ versionOf: id }, form.get("file") as File),
      (data) => arrive(documentPage(data?.id ?? id), "version"),
      formElement,
    );
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose text-body-dense">{t("documents.version.about")}</p>
      <TextField
        id={ids.file}
        name="file"
        type="file"
        accept="application/pdf,.pdf"
        label={t("documents.version.file")}
        hint={t("documents.upload.fileHint", { mb: MB })}
        required
        error={errorFor(result, "file")}
      />
      <div>
        <Button type="submit" variant="secondary" icon={<FilePlus {...icon} />} disabled={pending}>
          {pending ? t("documents.upload.sending") : t("documents.version.submit")}
        </Button>
      </div>
      {result && !result.ok ? <FormFeedback result={result} success="" fieldIds={ids} /> : null}
    </form>
  );
}

/**
 * Signs the version shown with a typed full name and the statement, bound to its SHA-256: if the
 * document changed since the page was opened the API refuses, and the page says to read it again.
 */
export function SignDocumentForm({ id, sha256 }: { readonly id: string; readonly sha256: string }) {
  const ids = useFieldIds(["typedName", "confirm"]);
  const { result, pending, send, setResult } = useDocumentSend();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const read = readSignature(form, t);
    if (!read.ok) return setResult(fieldErrors(read.errors));
    send(
      () => signDocument(id, sha256, form),
      () => arrive(documentPage(id), "signed"),
      formElement,
    );
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">
        {t("documents.sign.statement", { statement: DEFAULT_SIGNATURE_STATEMENT })}
      </p>
      <TextField
        id={ids.typedName}
        name="typedName"
        label={t("documents.sign.name")}
        hint={t("documents.sign.nameHint")}
        maxLength={SIGNER_NAME_MAX}
        autoComplete="name"
        required
        error={errorFor(result, "typedName")}
      />
      <Checkbox
        id={ids.confirm}
        name="confirm"
        value="yes"
        label={t("documents.sign.confirm")}
        required
        error={errorFor(result, "confirm")}
      />
      <div>
        <Button type="submit" icon={<PenLine {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("documents.sign.submit")}
        </Button>
      </div>
      {result && !result.ok ? <FormFeedback result={result} success="" fieldIds={ids} /> : null}
    </form>
  );
}
