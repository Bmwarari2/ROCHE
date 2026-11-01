"use client";

import type {
  ImportBatch,
  ImportCommitResult,
  ImportDryRunReport,
  ImportRecordType,
} from "@harbour/contracts";
import { Button, Card, Checkbox, Sheet, SheetClose } from "@harbour/ui";
import { CircleAlert, ListChecks, Trash2, TriangleAlert, Undo2, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import { commitImport, discardImport, dryRunImport, undoImport } from "@/app/actions/imports";
import { FormFeedback } from "@/components/care/FormFeedback";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { t } from "@/lib/i18n";
import { commitReadiness, findingPlace, importPage, warningLabel } from "@/lib/imports";
import { type ActionResult, fieldErrors } from "@/lib/outcome";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * Sends a step and, once done, opens the page again saying what was done (`done`, with a new
 * `at`), so focus moves to the page heading and the status says it (as the export page does);
 * without `done` the page is only refreshed.
 */
function useSend<T>(path: string) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<T> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = (call: () => Promise<ActionResult<T>>, after?: (data: T) => void, done?: string) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) {
        after?.(outcome.data);
        if (done) router.replace(`${path}?done=${done}&at=${Date.now()}`, { scroll: false });
        router.refresh();
      }
    });
  return { result, pending, send, setResult };
}

/** A confirmation sheet: the button opens it, the footer does the thing. */
function Confirm({
  label,
  title,
  buttonIcon,
  children,
  action,
}: {
  readonly label: string;
  readonly title: string;
  readonly buttonIcon: ReactNode;
  readonly children: ReactNode;
  readonly action: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="secondary" icon={buttonIcon}>
          {label}
        </Button>
      }
      title={title}
      closeLabel={t("common.close")}
    >
      <div className="flex flex-col gap-4">
        {children}
        <div className="flex flex-wrap justify-end gap-2">
          <SheetClose asChild>
            <Button variant="secondary">{t("common.cancel")}</Button>
          </SheetClose>
          {action(() => setOpen(false))}
        </div>
      </div>
    </Sheet>
  );
}

function Rows({ kind, rows }: { readonly kind: string; readonly rows: readonly number[] }) {
  if (rows.length === 0) return null;
  return (
    <li>{t("import.report.allergyRows", { kind, count: rows.length, rows: rows.join(", ") })}</li>
  );
}

/** The dry run's report: counts, what committing does, errors and the warnings to acknowledge. */
function Report({
  report,
  recordType,
  ticked,
  onTick,
  idPrefix,
}: {
  readonly report: ImportDryRunReport;
  readonly recordType: ImportRecordType;
  readonly ticked: ReadonlySet<string>;
  readonly onTick: (key: string, on: boolean) => void;
  readonly idPrefix: string;
}) {
  // A new report takes focus at its summary, so it is read at once (the button that asked for it
  // was disabled while the check ran).
  const summaryRef = useRef<HTMLParagraphElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new report is a new arrival.
  useEffect(() => {
    summaryRef.current?.focus();
  }, [report]);
  return (
    <div className="flex flex-col gap-4">
      <p ref={summaryRef} tabIndex={-1} className="m-0 flex items-center gap-2">
        {report.errorCount > 0 ? (
          <CircleAlert {...icon} className="shrink-0" />
        ) : (
          <ListChecks {...icon} className="shrink-0" />
        )}
        {t("import.report.summary", {
          rows: report.rows,
          valid: report.validRows,
          errors: report.errorCount,
          warnings: report.warningCount,
        })}
      </p>
      <section aria-labelledby={`${idPrefix}-what`} className="flex flex-col gap-2">
        <h3 id={`${idPrefix}-what`} className="m-0 text-body font-semibold">
          {t("import.report.whatHappens")}
        </h3>
        <ul className="m-0 flex max-w-prose flex-col gap-2 pl-5">
          {report.whatHappens.map((words) => (
            <li key={words}>{words}</li>
          ))}
        </ul>
      </section>
      {report.errors.length > 0 ? (
        <section aria-labelledby={`${idPrefix}-errors`} className="flex flex-col gap-2">
          <h3 id={`${idPrefix}-errors`} className="m-0 text-body font-semibold">
            {t("import.report.errors", { count: report.errorCount })}
          </h3>
          <ul className="m-0 flex flex-col gap-2 pl-5">
            {report.errors.map((e) => (
              <li key={`${e.row}-${e.column}-${e.code}`}>
                <span className="font-semibold">{findingPlace(e, recordType, t)}</span>: {e.message}
                {e.personId ? (
                  <>
                    {" "}
                    <Link href={`/people/${e.personId}`}>{t("import.report.openRecord")}</Link>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          {report.truncated ? <p className="m-0">{t("import.report.truncated")}</p> : null}
        </section>
      ) : null}
      {report.warnings.length > 0 ? (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 text-body font-semibold">
            {t("import.report.warnings", { count: report.warningCount })}
          </legend>
          <p className="m-0 max-w-prose text-body-dense">{t("import.report.warningsAbout")}</p>
          {report.warnings.map((w, index) => {
            const key = w.key ?? `${w.row}-${w.column}`;
            return (
              <div key={key} className="flex flex-col gap-1">
                {w.key ? (
                  <Checkbox
                    id={`${idPrefix}-warning-${index}`}
                    label={warningLabel(w, recordType, t)}
                    hint={w.message}
                    checked={ticked.has(w.key)}
                    onChange={(e) => w.key && onTick(w.key, e.currentTarget.checked)}
                  />
                ) : (
                  <p className="m-0 flex gap-2">
                    <CircleAlert {...icon} className="mt-0.5 shrink-0" />
                    {w.message}
                  </p>
                )}
                {w.personId && !w.otherRow ? (
                  <p className="m-0 text-body-dense">
                    <Link href={`/people/${w.personId}`}>{t("import.report.openExisting")}</Link>
                  </p>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      ) : null}
      {report.recordMatchesCapped ? <p className="m-0">{t("import.report.capped")}</p> : null}
      <section aria-labelledby={`${idPrefix}-allergy`} className="flex flex-col gap-2">
        <h3 id={`${idPrefix}-allergy`} className="m-0 text-body font-semibold">
          {t("import.report.allergyTitle")}
        </h3>
        <p className="m-0 max-w-prose">{t("import.report.allergyAbout")}</p>
        <ul className="m-0 flex flex-col gap-1 pl-5">
          <Rows kind="nka" rows={report.noKnownAllergiesStatedRows} />
          <Rows kind="has" rows={report.hasAllergiesStatedRows} />
          <Rows kind="blank" rows={report.allergyStatusNotStatedRows} />
        </ul>
      </section>
    </div>
  );
}

/** After the commit: the allergy status checks it raised, each person and task linked (HZ-007). */
export function CommitDone({ result }: { readonly result: ImportCommitResult }) {
  return (
    <Card as="section" title={t("import.commit.doneTitle")} headingLevel={2}>
      <div className="flex flex-col gap-3">
        <p className="m-0 flex items-center gap-2">
          <ListChecks {...icon} className="shrink-0" />
          {t("import.commit.done", { records: result.records })}
        </p>
        {result.allergyStatusToConfirm.length > 0 ? (
          <section aria-labelledby="import-allergy-tasks" className="flex flex-col gap-2">
            <h3 id="import-allergy-tasks" className="m-0 text-body font-semibold">
              {t("import.commit.allergyTasks", { count: result.allergyStatusToConfirm.length })}
            </h3>
            <p className="m-0 max-w-prose">{t("import.commit.allergyAbout")}</p>
            <ul className="m-0 flex flex-col gap-2 pl-5">
              {result.allergyStatusToConfirm.map((a, n) => (
                <li key={a.taskId}>
                  <Link href={`/people/${a.personId}`}>
                    {t("import.commit.allergyPerson", { n: n + 1, stated: a.stated })}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="m-0">
              <Link href="/tasks">{t("import.commit.openTasks")}</Link>
            </p>
          </section>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Steps 3 and 4 (rules 21 to 23): check the staged file (a dry run, nothing committed), read what
 * committing does, tick each possible duplicate shown, accept that it cannot be undone when phones
 * are in use, then commit with a fresh step-up. Or discard the file.
 */
export function ImportSteps({ batch }: { readonly batch: ImportBatch }) {
  const path = importPage(batch.id);
  const check = useSend<ImportDryRunReport>(path);
  const commit = useSend<ImportCommitResult>(path);
  const discard = useSend<ImportBatch>(path);
  const [report, setReport] = useState<ImportDryRunReport | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [acceptNoUndo, setAcceptNoUndo] = useState(false);
  const [committed, setCommitted] = useState<ImportCommitResult | null>(null);
  const [blocked, setBlocked] = useState<ActionResult<never> | null>(null);
  const idPrefix = `import-${batch.id}`;
  const noUndoId = `${idPrefix}-no-undo`;

  // Kept across the refresh after committing (the page renders this component in every state), so
  // the allergy status checks stay listed once the batch reads as committed.
  if (committed) return <CommitDone result={committed} />;
  if (batch.status !== "staged") return null;

  const runCheck = () =>
    check.send(
      () => dryRunImport(batch.id),
      (data) => {
        setReport(data);
        setTicked(new Set());
        setAcceptNoUndo(false);
        setBlocked(null);
      },
    );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!report) return;
    const ready = commitReadiness(report, ticked, acceptNoUndo);
    if (!ready.ready) {
      // A summary that takes focus and links to the first box still to tick, and the acceptance.
      setBlocked(
        fieldErrors(
          Object.fromEntries(
            ready.reasons.map((r) => [r, t("import.commit.blocked", { reason: r })]),
          ),
        ),
      );
      return;
    }
    setBlocked(null);
    commit.send(
      () => commitImport(batch.id, ready.acknowledged, acceptNoUndo),
      (data) => setCommitted(data),
      "committed",
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <Card as="section" title={t("import.check.title")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="m-0 max-w-prose">{t("import.check.about")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={report ? "secondary" : "primary"}
              icon={<ListChecks {...icon} />}
              disabled={check.pending}
              onClick={runCheck}
            >
              {check.pending
                ? t("import.check.running")
                : report
                  ? t("import.check.again")
                  : t("import.check.run")}
            </Button>
            <Confirm
              label={t("import.discard.open")}
              title={t("import.discard.title")}
              buttonIcon={<Trash2 {...icon} />}
              action={(close) => (
                <Button
                  variant="destructive"
                  icon={<Trash2 {...icon} />}
                  disabled={discard.pending}
                  onClick={() => {
                    close();
                    discard.send(() => discardImport(batch.id), undefined, "discarded");
                  }}
                >
                  {t("import.discard.confirm")}
                </Button>
              )}
            >
              <p className="m-0">{t("import.discard.about")}</p>
            </Confirm>
          </div>
          <ManageFeedback result={check.result} path={path} />
          <ManageFeedback result={discard.result} path={path} />
        </div>
      </Card>
      {report ? (
        <Card as="section" title={t("import.report.title")} headingLevel={2}>
          <form method="post" className="flex flex-col gap-5" onSubmit={submit} noValidate>
            <Report
              report={report}
              recordType={batch.recordType}
              ticked={ticked}
              idPrefix={idPrefix}
              onTick={(key, on) => {
                const next = new Set(ticked);
                if (on) next.add(key);
                else next.delete(key);
                setTicked(next);
              }}
            />
            {report.phonesInUse ? (
              <div className="flex flex-col gap-2">
                <div role="note" className="flex gap-3">
                  <TriangleAlert {...icon} className="mt-0.5 shrink-0" />
                  <p className="m-0 max-w-prose font-semibold">{t("import.commit.noUndoNote")}</p>
                </div>
                <Checkbox
                  id={noUndoId}
                  label={t("import.commit.acceptNoUndo")}
                  checked={acceptNoUndo}
                  onChange={(e) => setAcceptNoUndo(e.currentTarget.checked)}
                />
              </div>
            ) : null}
            {report.mayCommit || report.needsAcknowledgement ? (
              <div className="flex flex-col gap-3">
                <p className="m-0 max-w-prose text-body-dense">{t("import.commit.stepUpAbout")}</p>
                <div>
                  <Button type="submit" icon={<Upload {...icon} />} disabled={commit.pending}>
                    {commit.pending
                      ? t("import.commit.sending")
                      : t("import.commit.submit", { rows: report.validRows })}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="m-0 flex items-center gap-2">
                <CircleAlert {...icon} className="shrink-0" />
                {t("import.commit.notYet")}
              </p>
            )}
            {blocked ? (
              <FormFeedback
                result={blocked}
                success=""
                fieldIds={{
                  unchecked: `${idPrefix}-warning-${Math.max(
                    0,
                    report.warnings.findIndex((w) => w.key && !ticked.has(w.key)),
                  )}`,
                  noUndo: noUndoId,
                }}
              />
            ) : null}
            <ManageFeedback result={commit.result} path={path} stepUp={t("import.commit.stepUp")} />
          </form>
        </Card>
      ) : null}
    </div>
  );
}

/** Undo (rule 25), offered only while the API says it is available, after confirming. */
export function UndoImport({ batch }: { readonly batch: ImportBatch }) {
  const undo = useSend<unknown>(importPage(batch.id));
  return (
    <div className="flex flex-col gap-3">
      <Confirm
        label={t("import.undo.open")}
        title={t("import.undo.title")}
        buttonIcon={<Undo2 {...icon} />}
        action={(close) => (
          <Button
            variant="destructive"
            icon={<Undo2 {...icon} />}
            disabled={undo.pending}
            onClick={() => {
              close();
              undo.send(() => undoImport(batch.id), undefined, "undone");
            }}
          >
            {t("import.undo.confirm", { records: batch.records ?? 0 })}
          </Button>
        )}
      >
        <p className="m-0">{t("import.undo.about", { records: batch.records ?? 0 })}</p>
      </Confirm>
      <ManageFeedback
        result={undo.result as ActionResult<unknown> | null}
        path={importPage(batch.id)}
        stepUp={t("import.undo.stepUp")}
      />
    </div>
  );
}
