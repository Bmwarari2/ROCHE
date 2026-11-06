"use client";

import { TextField } from "@harbour/ui";
import { useId, useState } from "react";
import { type MatrixRow, TrainingMatrixGrid } from "@/components/development/TrainingMatrixGrid";
import { matchesName } from "@/lib/development";
import { t } from "@/lib/i18n";

/**
 * The training matrix with a search by name (accessibility review round 1, finding 1: a large
 * home's member is found without scrolling). The search filters in the browser, so a name never
 * goes into an address or a server log; how many match is said as the list changes.
 */
export function SearchableMatrix({
  columns,
  rows,
}: {
  readonly columns: readonly { readonly topic: string; readonly label: string }[];
  readonly rows: readonly MatrixRow[];
}) {
  const [query, setQuery] = useState("");
  const id = useId();
  const shown = rows.filter((row) => matchesName(row.name, query));
  return (
    <div className="flex flex-col gap-3">
      <TextField
        id={`${id}-name`}
        label={t("development.matrix.name")}
        hint={t("development.matrix.nameHint")}
        value={query}
        maxLength={80}
        autoComplete="off"
        onChange={(event) => setQuery(event.currentTarget.value)}
        className="max-w-md"
      />
      <p role="status" className="m-0 text-body-dense">
        {query.trim() === "" ? "" : t("development.matrix.nameMatches", { count: shown.length })}
      </p>
      {shown.length > 0 ? (
        <TrainingMatrixGrid
          caption={t("development.matrix.caption")}
          captionId={`${id}-caption`}
          columns={columns}
          rows={shown}
        />
      ) : null}
    </div>
  );
}
