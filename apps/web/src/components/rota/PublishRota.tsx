"use client";

import type { RotaCheck } from "@harbour/contracts";
import { Button, Checkbox } from "@harbour/ui";
import { Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { publishRota } from "@/app/actions/rota";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { t } from "@/lib/i18n";
import { type ActionResult, fieldErrors } from "@/lib/outcome";
import { publishReadiness, rotaPage } from "@/lib/rota";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * Publishing (HZ-123): each period short of the organisation's own scale, incomplete or with no
 * scale is ticked by name, the warnings are confirmed as read, and the check the publisher saw
 * (its digest) is sent back, so a check that changed since is shown again first. An assignment
 * the rostering rule blocks with no override keeps publishing closed.
 */
export function PublishRota({
  check,
  periods,
}: {
  readonly check: RotaCheck;
  /** Each period to acknowledge with its words: date, period and the comparison's word. */
  readonly periods: readonly { readonly key: string; readonly label: string }[];
}) {
  const ids = useFieldIds(["periods", "warnings", "blocked"]);
  const router = useRouter();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [warningsRead, setWarningsRead] = useState(false);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const firstUnticked = periods.findIndex((p) => !ticked.has(p.key));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ready = publishReadiness(check, ticked, warningsRead);
    if (!ready.ready) {
      return setResult(
        fieldErrors(
          Object.fromEntries(
            ready.reasons.map((r) => [
              r === "periods" ? "periods" : r === "warnings" ? "warnings" : "blocked",
              t("rota.publish.blocked", { reason: r }),
            ]),
          ),
        ),
      );
    }
    startTransition(async () => {
      const out = await publishRota(check.rotaId, {
        version: check.rotaVersion,
        digest: check.digest,
        acknowledgeWarnings: check.hasWarnings && warningsRead,
        acknowledgedPeriods: ready.acknowledgedPeriods,
      });
      setResult(out);
      if (out.ok) {
        router.replace(`${rotaPage(check.rotaId)}?done=published&at=${Date.now()}`);
        router.refresh();
      }
    });
  };

  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {periods.length > 0 ? (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 text-body font-semibold">
            {t("rota.publish.periods", { count: periods.length })}
          </legend>
          <p className="m-0 max-w-prose text-body-dense">{t("rota.publish.periodsAbout")}</p>
          {periods.map((p, index) => (
            <Checkbox
              key={p.key}
              id={index === Math.max(0, firstUnticked) ? ids.periods : undefined}
              label={t("rota.publish.period", { period: p.label })}
              checked={ticked.has(p.key)}
              onChange={(e) => {
                const next = new Set(ticked);
                if (e.currentTarget.checked) next.add(p.key);
                else next.delete(p.key);
                setTicked(next);
              }}
            />
          ))}
        </fieldset>
      ) : null}
      {check.hasWarnings ? (
        <Checkbox
          id={ids.warnings}
          label={t("rota.publish.warningsRead")}
          checked={warningsRead}
          onChange={(e) => setWarningsRead(e.currentTarget.checked)}
        />
      ) : null}
      {check.blockedAssignmentIds.length > 0 ? (
        <p id={ids.blocked} tabIndex={-1} className="m-0">
          {t("rota.publish.blockedAssignments", { count: check.blockedAssignmentIds.length })}
        </p>
      ) : null}
      <div>
        <Button type="submit" icon={<Send {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("rota.publish.submit")}
        </Button>
      </div>
      <FormFeedback result={result && !result.ok ? result : null} success="" fieldIds={ids} />
    </form>
  );
}
