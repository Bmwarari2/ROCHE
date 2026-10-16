"use client";

import type { BreakGlassSearchResults } from "@harbour/contracts";
import { Button, SelectField, Sheet, StatusChip, TextArea, TextField } from "@harbour/ui";
import { CircleAlert, LockOpen } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import { runBreakGlassSearch } from "@/app/actions/search";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { formatDate, formatNhsNumber } from "@/lib/format";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor } from "@/lib/outcome";
import {
  BREAK_GLASS_REASON_CODES,
  BREAK_GLASS_REASON_MAX,
  BREAK_GLASS_REASON_MIN,
  SEARCH_MAX_LENGTH,
} from "@/lib/search";

/**
 * "Search outside your access" (platform-completions.md rule 9; master prompt section 4; HZ-001,
 * HZ-011): a full name or an NHS number, a reason code and a typed reason, confirmed with a fresh
 * second factor. The Registered Manager and the data protection lead are told. Results are
 * read-only identity (name, date of birth, NHS number, status), never where the person lives;
 * opening a record is the separate break-glass step on the record itself.
 */
export function BreakGlassSearch() {
  const ids = useFieldIds(["query", "reasonCode", "reason"]);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [found, setFound] = useState<BreakGlassSearchResults | null>(null);
  const [pending, startTransition] = useTransition();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (found) heading.current?.focus();
  }, [found]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      const outcome = await runBreakGlassSearch({
        query: String(form.get("query") ?? ""),
        reasonCode: String(form.get("reasonCode") ?? ""),
        reason: String(form.get("reason") ?? ""),
      });
      setResult(outcome.ok ? null : outcome);
      setFound(outcome.ok ? outcome.data : null);
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setResult(null);
          setFound(null);
        }
      }}
      trigger={
        <Button variant="secondary" icon={<LockOpen size={18} strokeWidth={1.5} />}>
          {t("platform.breakGlassSearch.title")}
        </Button>
      }
      title={t("platform.breakGlassSearch.title")}
      description={t("platform.breakGlassSearch.body")}
      closeLabel={t("common.close")}
    >
      <form method="post" className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <TextField
          id={ids.query}
          name="query"
          label={t("platform.breakGlassSearch.query")}
          hint={t("platform.breakGlassSearch.queryHint")}
          maxLength={SEARCH_MAX_LENGTH}
          autoComplete="off"
          error={errorFor(result, "query")}
        />
        <SelectField
          id={ids.reasonCode}
          name="reasonCode"
          label={t("platform.breakGlassSearch.reasonCode")}
          emptyOption={t("platform.breakGlassSearch.chooseReason")}
          required
          error={errorFor(result, "reasonCode")}
          options={BREAK_GLASS_REASON_CODES.map((code) => ({
            value: code,
            label: t("platform.breakGlassSearch.reasonOption", { code }),
          }))}
        />
        <TextArea
          id={ids.reason}
          name="reason"
          label={t("people.breakGlass.justification")}
          hint={t("people.breakGlass.hint", { min: BREAK_GLASS_REASON_MIN })}
          rows={3}
          required
          maxLength={BREAK_GLASS_REASON_MAX}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "reason")}
        />
        <p role="status" className="m-0 min-h-6 text-body-dense">
          {pending ? t("platform.search.searching") : ""}
        </p>
        <div>
          <Button type="submit" variant="destructive" disabled={pending}>
            {t("platform.breakGlassSearch.submit")}
          </Button>
        </div>
        <ManageFeedback
          result={result}
          path="/search"
          fieldIds={ids}
          stepUp={t("platform.breakGlassSearch.stepUp")}
        />
      </form>
      {found ? (
        <section aria-labelledby="break-glass-results" className="mt-6 flex flex-col gap-3">
          <h3
            id="break-glass-results"
            ref={heading}
            tabIndex={-1}
            className="m-0 text-body font-semibold"
          >
            {t("platform.search.resultsTitle", { count: found.total })}
          </h3>
          <p className="m-0 text-body-dense text-text-secondary">
            {t("platform.breakGlassSearch.readOnly")}
          </p>
          {found.more ? (
            <p className="m-0 font-semibold">
              {t("platform.breakGlassSearch.more", { count: found.total })}
            </p>
          ) : null}
          {found.items.length === 0 ? (
            <p className="m-0">{t("platform.breakGlassSearch.none")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {found.items.map((p) => (
                <li key={p.id} className="flex flex-col gap-1 border-b border-border pb-3">
                  <Link
                    href={`/people/${p.id}`}
                    className="inline-flex min-h-target items-center font-semibold underline"
                  >
                    {p.preferredName
                      ? t("platform.search.nameKnownAs", {
                          name: p.name,
                          preferred: p.preferredName,
                        })
                      : p.name}
                  </Link>
                  <p className="m-0 text-body-dense">
                    {[
                      p.dateOfBirth
                        ? t("platform.search.born", { date: formatDate(p.dateOfBirth) ?? "" })
                        : null,
                      p.nhsNumber
                        ? t("platform.search.nhs", { nhs: formatNhsNumber(p.nhsNumber) ?? "" })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <div>
                    <StatusChip
                      status="neutral"
                      label={t("platform.search.status", { status: p.status })}
                    />
                  </div>
                  {p.sameName ? (
                    <p className="m-0 flex items-start gap-2 rounded-input border-s-4 border-warning bg-bg-secondary p-2 font-semibold">
                      <CircleAlert
                        size={20}
                        strokeWidth={1.5}
                        aria-hidden="true"
                        className="mt-0.5 shrink-0"
                      />
                      {t("platform.search.sameName", { check: "dob" })}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </Sheet>
  );
}
