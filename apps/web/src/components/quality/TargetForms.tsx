"use client";

import { Button, TextField } from "@harbour/ui";
import type { FormEvent } from "react";
import { clearIndicatorTarget, setIndicatorTarget } from "@/app/actions/quality-dashboard";
import { useFieldIds } from "@/components/care/form-state";
import { t } from "@/lib/i18n";
import { errorFor } from "@/lib/outcome";
import { readTarget } from "@/lib/quality-dashboard";
import { QualityFeedback, useQualitySend } from "./QualityForms";

/**
 * The quality dashboard's target forms (quality.md section 22, rule 41). Each posts as plain HTML
 * until it hydrates (`method="post"`), then through a server action; problems are said at their
 * fields and in a linked summary. The API decides who may set which target.
 */

type Direction = "lower_is_better" | "higher_is_better";

/** These buttons name their indicator and place, so they wrap at 320 px (WCAG 1.4.10). */
const WRAP = "h-auto max-w-full whitespace-normal py-2";

export interface TargetFormProps {
  readonly indicatorKey: string;
  readonly indicatorTitle: string;
  readonly level: "location" | "organisation";
  readonly locationId: string;
  readonly locationName: string;
  readonly current: {
    readonly id: string;
    readonly version: number;
    readonly green: number;
    readonly amber: number;
  } | null;
  readonly direction: Direction;
  readonly kind: "percent" | "bedDays" | "count";
  readonly multiplier: number;
  readonly path: string;
}

export function TargetForm({
  indicatorKey,
  indicatorTitle,
  level,
  locationId,
  locationName,
  current,
  direction,
  kind,
  multiplier,
  path,
}: TargetFormProps) {
  const ids = useFieldIds(["green", "amber"]);
  const { result, pending, send, fail } = useQualitySend(path);
  const words = direction === "higher_is_better" ? "higher" : "lower";
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readTarget(
      new FormData(event.currentTarget),
      { direction, percent: kind === "percent" },
      t,
    );
    if (!read.ok) return fail(read.errors);
    send("targetSet", () =>
      setIndicatorTarget({
        locationId: level === "location" ? locationId : null,
        indicatorKey,
        green: read.green,
        amber: read.amber,
        expectedVersion: current?.version ?? null,
      }),
    );
  };
  const hint = t("quality.dashboard.targets.hint", { kind, multiplier });
  return (
    <div className="flex flex-col gap-3">
      <form
        method="post"
        className="flex flex-col gap-3"
        onSubmit={onSubmit}
        noValidate
        aria-label={t("quality.dashboard.targets.formTitle", {
          level,
          location: locationName,
          indicator: indicatorTitle,
        })}
      >
        <div className="flex flex-wrap gap-4">
          <TextField
            id={ids.green}
            name="green"
            inputMode="decimal"
            autoComplete="off"
            label={t("quality.dashboard.targets.green", { direction: words })}
            hint={hint}
            defaultValue={current ? String(current.green) : ""}
            className="max-w-xs"
            error={errorFor(result, "green")}
          />
          <TextField
            id={ids.amber}
            name="amber"
            inputMode="decimal"
            autoComplete="off"
            label={t("quality.dashboard.targets.amber", { direction: words })}
            hint={hint}
            defaultValue={current ? String(current.amber) : ""}
            className="max-w-xs"
            error={errorFor(result, "amber")}
          />
        </div>
        <div>
          <Button type="submit" variant="primary" disabled={pending} className={WRAP}>
            {pending
              ? t("common.saving")
              : level === "location"
                ? t("quality.dashboard.targets.saveLocation", {
                    location: locationName,
                    indicator: indicatorTitle,
                  })
                : t("quality.dashboard.targets.saveOrganisation", { indicator: indicatorTitle })}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

export function ClearTargetButton({
  id,
  version,
  level,
  indicatorTitle,
  locationName,
  path,
}: {
  readonly id: string;
  readonly version: number;
  readonly level: "location" | "organisation";
  readonly indicatorTitle: string;
  readonly locationName: string;
  readonly path: string;
}) {
  const ids = useFieldIds(["note"]);
  const { result, pending, send } = useQualitySend(path);
  const label = t("quality.dashboard.targets.clear", {
    level,
    location: locationName,
    indicator: indicatorTitle,
  });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send("targetCleared", () => clearIndicatorTarget(id, { expectedVersion: version }));
  };
  return (
    <div className="flex flex-col gap-2">
      <form method="post" onSubmit={onSubmit} aria-label={label} className="flex flex-col gap-2">
        <p id={ids.note} className="m-0 text-body-dense text-text-secondary">
          {t("quality.dashboard.clearNote", {
            level,
            location: locationName,
            indicator: indicatorTitle,
          })}
        </p>
        <div>
          <Button
            type="submit"
            variant="destructive"
            disabled={pending}
            aria-describedby={ids.note}
            className={WRAP}
          >
            {pending ? t("quality.dashboard.clearing") : label}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} />
    </div>
  );
}
