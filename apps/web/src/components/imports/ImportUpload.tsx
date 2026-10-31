"use client";

import { Button, SelectField, TextField } from "@harbour/ui";
import { FileUp, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ChangeEvent, type FormEvent, useState, useTransition } from "react";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { t } from "@/lib/i18n";
import {
  checkMapping,
  IMPORT_UPLOAD_MAX_BYTES,
  IMPORT_UPLOAD_PATH,
  importFieldOptions,
  importPage,
  LEAVE_OUT,
  previewWords,
  readImportHeader,
  suggestMapping,
} from "@/lib/imports";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const RECORD_TYPE = "people" as const;

interface ReadFile {
  readonly csv: string;
  readonly header: readonly string[];
  readonly rows: number;
  readonly preview: readonly (readonly string[])[];
}

type UploadAnswer =
  | { readonly ok: true; readonly data: { readonly id: string } }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly fields?: Readonly<Record<string, string>>;
    };

/** Sends the file, the home and the mapping to this site's upload route (never a server action). */
async function sendUpload(body: {
  locationId: string;
  csv: string;
  mapping: Record<string, string | null>;
}): Promise<UploadAnswer> {
  try {
    const response = await fetch(IMPORT_UPLOAD_PATH, {
      method: "POST",
      body: JSON.stringify({ recordType: RECORD_TYPE, ...body }),
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
    });
    return (await response.json()) as UploadAnswer;
  } catch {
    return { ok: false, code: "unavailable", message: t("care.errors.unavailable") };
  }
}

/**
 * Step 1 and 2 of the import wizard (rules 18 and 19): choose the home and the CSV file, then
 * match each column to a Harbour field or leave it out. The file is read here only to show its
 * headings; nothing is staged until "Upload for checking", and nothing is created until a dry run
 * and a commit.
 */
export function ImportUpload({
  locations,
}: {
  readonly locations: readonly { readonly id: string; readonly name: string }[];
}) {
  const ids = useFieldIds(["locationId", "file", "mapping"]);
  const router = useRouter();
  const [file, setFile] = useState<ReadFile | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  // Said beside the file field as it is chosen, without moving focus (WCAG 3.2.2); the summary
  // takes focus only when the form is sent.
  const [fileError, setFileError] = useState<string | null>(null);
  const [columnErrors, setColumnErrors] = useState<Readonly<Record<number, string>>>({});
  const [pending, startTransition] = useTransition();
  const fields = importFieldOptions(RECORD_TYPE);
  const options = [
    { value: LEAVE_OUT, label: t("import.mapping.leaveOut") },
    ...fields.map((f) => ({
      value: f.key,
      label: f.required ? t("import.mapping.required", { field: f.label }) : f.label,
    })),
  ];

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    setResult(null);
    setFileError(null);
    setColumnErrors({});
    setFile(null);
    const picked = event.currentTarget.files?.[0];
    if (!picked) return;
    if (picked.size > IMPORT_UPLOAD_MAX_BYTES) {
      setFileError(t("import.upload.tooLarge"));
      return;
    }
    const csv = await picked.text();
    const read = readImportHeader(csv);
    if (!read.ok) {
      setFileError(read.message);
      return;
    }
    setFile({ csv, header: read.header, rows: read.rows, preview: read.preview });
    setChosen(suggestMapping(read.header, RECORD_TYPE));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const locationId = String(form.get("locationId") ?? "");
    const errors: Record<string, string> = {};
    if (!locationId) errors.locationId = t("import.upload.chooseHome");
    if (!file) errors.file = fileError ?? t("import.upload.fileRequired");
    const check = file ? checkMapping(file.header, chosen, RECORD_TYPE, t) : null;
    setColumnErrors(Object.fromEntries((check?.problems ?? []).map((p) => [p.column, p.message])));
    if (check && (check.problems.length > 0 || check.missing.length > 0)) {
      errors.mapping = [
        ...check.problems.map((p) => p.message),
        ...(check.missing.length > 0
          ? [t("import.mapping.missing", { fields: check.missing.join(", ") })]
          : []),
      ].join(" ");
    }
    if (Object.keys(errors).length > 0 || !file || !check) return setResult(fieldErrors(errors));
    startTransition(async () => {
      const answer = await sendUpload({ locationId, csv: file.csv, mapping: check.mapping });
      setResult(answer.ok ? { ok: true, data: null } : answer);
      if (answer.ok) {
        router.push(`${importPage(answer.data.id)}?done=uploaded&at=${Date.now()}`);
      }
    });
  };

  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.locationId}
        name="locationId"
        label={t("import.upload.home")}
        hint={t("import.upload.homeHint")}
        emptyOption={t("import.upload.chooseHome")}
        options={locations.map((l) => ({ value: l.id, label: l.name }))}
        required
        error={errorFor(result, "locationId")}
      />
      <TextField
        id={ids.file}
        name="file"
        type="file"
        accept=".csv,text/csv"
        label={t("import.upload.file")}
        hint={t("import.upload.fileHint")}
        required
        onChange={choose}
        error={fileError ?? errorFor(result, "file")}
      />
      {file ? (
        <fieldset
          id={ids.mapping}
          className="m-0 flex flex-col gap-3 border-0 p-0"
          tabIndex={-1}
          aria-describedby={errorFor(result, "mapping") ? `${ids.mapping}-error` : undefined}
        >
          <legend className="mb-2 text-body font-semibold">
            {t("import.mapping.title", { columns: file.header.length, rows: file.rows })}
          </legend>
          <p className="m-0 max-w-prose text-body-dense">{t("import.mapping.about")}</p>
          {errorFor(result, "mapping") ? (
            <div id={`${ids.mapping}-error`} className="flex gap-2">
              <TriangleAlert {...icon} className="mt-0.5 shrink-0" />
              <p className="m-0">{errorFor(result, "mapping")}</p>
            </div>
          ) : null}
          {file.header.map((heading, index) => (
            <SelectField
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional and fixed per file.
              key={index}
              label={t("import.mapping.column", { column: index + 1, heading })}
              hint={previewWords(file.preview[index] ?? [], t)}
              error={columnErrors[index + 1]}
              options={options}
              value={chosen[index] ?? LEAVE_OUT}
              onChange={(e) => {
                const next = [...chosen];
                next[index] = e.currentTarget.value;
                setChosen(next);
              }}
            />
          ))}
        </fieldset>
      ) : null}
      <div>
        <Button type="submit" icon={<FileUp {...icon} />} disabled={pending}>
          {pending ? t("import.upload.sending") : t("import.upload.submit")}
        </Button>
      </div>
      {result && !result.ok ? <FormFeedback result={result} success="" fieldIds={ids} /> : null}
    </form>
  );
}
