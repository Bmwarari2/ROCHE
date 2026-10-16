"use client";

import type { OutageItem } from "@harbour/contracts";
import {
  DateTimeInput,
  type DateTimePart,
  dateTimePartsAt,
  RadioGroup,
  TextArea,
  TextField,
} from "@harbour/ui";
import { useState } from "react";
import { paperClosedOff, paperOutages } from "@/lib/back-entry";
import { outageTitle, outageWindow } from "@/lib/downtime";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor } from "@/lib/outcome";
import { boxesOf, dateTimeLabels, ukRepeatedTime } from "@/lib/uk-time";

type Mode = "now" | "earlier" | "paper";

/** The ids of the paper record's fields, for the error summary's links. */
export interface PaperFieldIds {
  readonly outageId: string;
  readonly paperReference: string;
  readonly outsideOutageReason: string;
  readonly notFromPaperReason: string;
}

/** The outages a paper record can be entered against, and the form's last result. */
export interface PaperOptions {
  readonly outages: readonly OutageItem[];
  readonly ids: PaperFieldIds;
  readonly result: ActionResult<unknown> | null;
  /** Said above the paper fields, for example that a reading is from the paper's time. */
  readonly notice?: string;
}

/**
 * When an entry happened (hazards HZ-009 and HZ-017). It says "Now" until someone changes it, and
 * "now" is the moment the form is sent, so a form left open never records the time the page was
 * drawn. "Earlier" opens the date and time boxes (UK time, 24-hour), filled with the time it was
 * chosen; a late entry is flagged by the API. In the hour the clocks go back, the boxes ask which
 * of the two times was meant.
 *
 * With `paper`, while the location has an outage a paper record can be entered against, a third
 * choice, "From a paper downtime form", asks which outage, the date and time written on the form
 * (nothing filled in), the form's reference and, when the time is outside the outage, why
 * (operations.md rules 11 and 12). When the API asks why an entry for a time in an outage is not
 * from paper, the reason is asked for here (rule 13).
 */
export function WhenField({
  name = "occurredAt",
  legend = t("care.entry.when"),
  id,
  error,
  errorParts,
  explicit,
  paper,
}: {
  readonly name?: string;
  readonly legend?: string;
  /** The id an error summary links to: the first choice, or the day box once it is shown. */
  readonly id?: string;
  readonly error?: string;
  /** The boxes the error is about; all of them when not given. */
  readonly errorParts?: readonly string[];
  /**
   * Nothing chosen until the person chooses, with these words for the two choices (an incident,
   * whose clocks start at this time: HZ-090). "Now" is then taken by the server, not the browser.
   */
  readonly explicit?: {
    readonly hint: string;
    readonly now: { readonly label: string; readonly description: string };
    readonly earlier: { readonly label: string; readonly description: string };
  };
  /** Paper records from an outage (care record entries only). */
  readonly paper?: PaperOptions;
}) {
  const [mode, setMode] = useState<Mode | null>(explicit ? null : "now");
  const [start, setStart] = useState<Record<DateTimePart, string> | null>(null);
  const boxes = boxesOf(errorParts);
  const outages = paperOutages(paper?.outages ?? []);
  const closedOff = paperClosedOff(paper?.outages ?? []);
  const fieldError = (field: string) => (paper ? errorFor(paper.result, field) : undefined);
  const notFromPaper = fieldError("notFromPaperReason");
  const boxesShown = mode === "earlier" || mode === "paper";
  return (
    <div className="flex flex-col gap-4">
      <RadioGroup<Mode>
        legend={legend}
        hint={explicit?.hint ?? t("care.entry.whenHint")}
        name={`${name}-mode`}
        layout={outages.length > 0 ? "stack" : "inline"}
        value={mode}
        onValueChange={(next) => {
          if (next === "earlier" && start === null) setStart(dateTimePartsAt(Date.now()));
          setMode(next);
        }}
        {...(!boxesShown && id ? { id } : {})}
        {...(!boxesShown && error ? { error } : {})}
        {...(explicit ? { required: true } : {})}
        options={[
          {
            value: "now",
            label: explicit?.now.label ?? t("care.when.now"),
            description: explicit?.now.description ?? t("care.when.nowHint"),
          },
          {
            value: "earlier",
            label: explicit?.earlier.label ?? t("care.when.earlier"),
            description: explicit?.earlier.description ?? t("care.when.earlierHint"),
          },
          ...(outages.length > 0
            ? [
                {
                  value: "paper" as const,
                  label: t("care.paper.option"),
                  description: t("care.paper.optionHint"),
                },
              ]
            : []),
        ]}
      />
      {closedOff ? (
        <p className="m-0 text-body-dense text-text-secondary">{t("care.paper.closedOff")}</p>
      ) : null}
      {mode === "earlier" ? (
        <DateTimeInput
          legend={t("care.when.enter")}
          hint={t("care.when.hint")}
          name={name}
          defaultValue={start}
          labels={dateTimeLabels(t)}
          repeated={ukRepeatedTime}
          {...(id ? { id } : {})}
          {...(error ? { error, ...(boxes ? { errorParts: boxes } : {}) } : {})}
        />
      ) : null}
      {mode !== "paper" && notFromPaper && paper ? (
        <TextArea
          id={paper.ids.notFromPaperReason}
          name="notFromPaperReason"
          label={t("care.paper.notFromPaper")}
          hint={t("care.paper.notFromPaperHint")}
          rows={2}
          required
          maxLength={500}
          formatCount={(remaining) => characterCount(remaining)}
          error={notFromPaper}
        />
      ) : null}
      {mode === "paper" && paper ? (
        <div className="flex flex-col gap-4 border-s-4 border-border ps-4">
          {paper.notice ? <p className="m-0 font-semibold">{paper.notice}</p> : null}
          <RadioGroup<string>
            id={paper.ids.outageId}
            legend={t("care.paper.outage")}
            name="outageId"
            required
            error={fieldError("outageId")}
            options={outages.map((outage) => ({
              value: outage.id,
              label: outageTitle(outage, t),
              description: outageWindow(outage, t),
            }))}
          />
          <DateTimeInput
            legend={t("care.paper.time")}
            hint={t("care.paper.timeHint")}
            name={name}
            labels={dateTimeLabels(t)}
            repeated={ukRepeatedTime}
            {...(id ? { id } : {})}
            {...(error ? { error, ...(boxes ? { errorParts: boxes } : {}) } : {})}
          />
          <TextField
            id={paper.ids.paperReference}
            name="paperReference"
            label={t("care.paper.reference")}
            hint={t("care.paper.referenceHint")}
            maxLength={80}
            error={fieldError("paperReference")}
            className="max-w-sm"
          />
          <TextArea
            id={paper.ids.outsideOutageReason}
            name="outsideOutageReason"
            label={t("care.paper.outsideReason")}
            hint={t("care.paper.outsideReasonHint")}
            rows={2}
            maxLength={500}
            formatCount={(remaining) => characterCount(remaining)}
            error={fieldError("outsideOutageReason")}
          />
        </div>
      ) : null}
    </div>
  );
}
