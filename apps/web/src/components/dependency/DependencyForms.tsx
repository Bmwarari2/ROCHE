"use client";

import {
  Button,
  DateInput,
  SelectField,
  Sheet,
  SheetClose,
  TextArea,
  TextField,
} from "@harbour/ui";
import { CircleCheck, FilePlus, Plus, Save, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useState, useTransition } from "react";
import {
  approveDraft,
  archiveScale,
  createScale,
  discardDraft,
  recordDependency,
  saveDraft,
  startDraft,
} from "@/app/actions/dependency";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import {
  type DefinitionProblem,
  type DraftDefinition,
  definitionField,
  dependencyScalePage,
  EMPTY_DRAFT,
  keyFromLabel,
  readDefinition,
  SKILLS,
} from "@/lib/dependency";
import { uuidv7 } from "@/lib/entry-id";
import { t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";
import { readDateField } from "@/lib/uk-time";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

function useSend(path: string) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = (
    done: string,
    call: () => Promise<ActionResult<unknown>>,
    to?: (data: unknown) => string,
    after?: () => void,
  ) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) {
        after?.();
        router.replace(`${to ? to(outcome.data) : path}?done=${done}&at=${Date.now()}`, {
          scroll: false,
        });
        router.refresh();
      }
    });
  return { result, pending, send, setResult };
}

/**
 * The scale's definition, row by row (rule 2): shift periods with their start times, categories
 * with the care minutes per person in each period, the organisation's minimum staff with each
 * skill, and how often a category is reviewed. Every figure is the organisation's own. Each
 * problem is shown at its field; adding a row moves focus to its first field, removing one moves
 * focus to that section's add button.
 */
function DefinitionFields({
  draft,
  onChange,
  errors,
  idPrefix,
}: {
  readonly draft: DraftDefinition;
  readonly onChange: (next: DraftDefinition) => void;
  /** Problems by field key (`definitionField`). */
  readonly errors: Readonly<Record<string, string>>;
  readonly idPrefix: string;
}) {
  const id = (field: string) => `${idPrefix}-${field}`;
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusId) return;
    document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId]);
  const setPeriod = (i: number, patch: Partial<DraftDefinition["periods"][number]>) =>
    onChange({
      ...draft,
      periods: draft.periods.map((p, n) => (n === i ? { ...p, ...patch } : p)),
    });
  const setCategory = (i: number, patch: Partial<DraftDefinition["categories"][number]>) =>
    onChange({
      ...draft,
      categories: draft.categories.map((c, n) => (n === i ? { ...c, ...patch } : c)),
    });
  const setSkill = (i: number, patch: Partial<DraftDefinition["skillMix"][number]>) =>
    onChange({
      ...draft,
      skillMix: draft.skillMix.map((s, n) => (n === i ? { ...s, ...patch } : s)),
    });
  const periodName = (p: DraftDefinition["periods"][number], i: number) =>
    p.label.trim() || t("dependency.edit.periodFallback", { n: i + 1 });
  const periodOptions = draft.periods.map((p, i) => ({ value: p.key, label: periodName(p, i) }));

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-2 text-body font-semibold">{t("dependency.edit.periods")}</legend>
        <p className="m-0 max-w-prose text-body-dense">{t("dependency.edit.periodsAbout")}</p>
        {draft.periods.map((p, i) => (
          <div key={p.key} className="flex flex-wrap items-end gap-4">
            <TextField
              id={id(definitionField.periodLabel(i))}
              label={t("dependency.edit.periodName", { n: i + 1 })}
              value={p.label}
              maxLength={80}
              error={errors[definitionField.periodLabel(i)]}
              onChange={(e) => setPeriod(i, { label: e.currentTarget.value })}
            />
            <TextField
              id={id(definitionField.periodStart(i))}
              label={t("dependency.edit.periodFrom", { n: i + 1 })}
              hint={t("rota.template.timeHint")}
              value={p.start}
              inputMode="numeric"
              maxLength={5}
              error={errors[definitionField.periodStart(i)]}
              onChange={(e) => setPeriod(i, { start: e.currentTarget.value })}
            />
            <Button
              variant="secondary"
              icon={<X {...icon} />}
              onClick={() => {
                onChange({ ...draft, periods: draft.periods.filter((_, n) => n !== i) });
                setFocusId(id("add-period"));
              }}
            >
              {t("dependency.edit.removePeriod", { n: i + 1 })}
            </Button>
          </div>
        ))}
        <div>
          <Button
            id={id("add-period")}
            variant="secondary"
            icon={<Plus {...icon} />}
            disabled={draft.periods.length >= 12}
            onClick={() => {
              const n = draft.periods.length;
              onChange({
                ...draft,
                periods: [
                  ...draft.periods,
                  {
                    key: keyFromLabel(`period ${n + 1}`, new Set(draft.periods.map((p) => p.key))),
                    label: "",
                    start: "",
                  },
                ],
              });
              setFocusId(id(definitionField.periodLabel(n)));
            }}
          >
            {t("dependency.edit.addPeriod")}
          </Button>
        </div>
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-2 text-body font-semibold">{t("dependency.edit.categories")}</legend>
        <p className="m-0 max-w-prose text-body-dense">{t("dependency.edit.categoriesAbout")}</p>
        <ul className="hb-long-list m-0 flex list-none flex-col gap-4 p-0">
          {draft.categories.map((c, i) => (
            <li key={c.key} className="flex flex-col gap-3 border-b border-border pb-3">
              <TextField
                id={id(definitionField.categoryLabel(i))}
                label={t("dependency.edit.categoryName", { n: i + 1 })}
                value={c.label}
                maxLength={80}
                error={errors[definitionField.categoryLabel(i)]}
                onChange={(e) => setCategory(i, { label: e.currentTarget.value })}
              />
              <TextArea
                label={t("dependency.edit.categoryDescription", { n: i + 1 })}
                value={c.description}
                rows={2}
                maxLength={500}
                onChange={(e) => setCategory(i, { description: e.currentTarget.value })}
              />
              <div className="flex flex-wrap gap-4">
                {draft.periods.map((p, pi) => (
                  <TextField
                    key={p.key}
                    id={id(definitionField.categoryMinutes(i, p.key))}
                    label={t("dependency.edit.categoryMinutes", {
                      category:
                        c.label.trim() || t("dependency.edit.categoryFallback", { n: i + 1 }),
                      period: periodName(p, pi),
                    })}
                    hint={t("dependency.edit.minutesHint")}
                    value={c.minutes[p.key] ?? ""}
                    inputMode="numeric"
                    maxLength={4}
                    error={errors[definitionField.categoryMinutes(i, p.key)]}
                    onChange={(e) =>
                      setCategory(i, { minutes: { ...c.minutes, [p.key]: e.currentTarget.value } })
                    }
                  />
                ))}
              </div>
              <div>
                <Button
                  variant="secondary"
                  icon={<X {...icon} />}
                  onClick={() => {
                    onChange({ ...draft, categories: draft.categories.filter((_, n) => n !== i) });
                    setFocusId(id("add-category"));
                  }}
                >
                  {t("dependency.edit.removeCategory", {
                    name: c.label.trim() || t("dependency.edit.categoryFallback", { n: i + 1 }),
                  })}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <div>
          <Button
            id={id("add-category")}
            variant="secondary"
            icon={<Plus {...icon} />}
            disabled={draft.categories.length >= 30}
            onClick={() => {
              const n = draft.categories.length;
              onChange({
                ...draft,
                categories: [
                  ...draft.categories,
                  {
                    key: keyFromLabel(
                      `category ${n + 1}`,
                      new Set(draft.categories.map((c) => c.key)),
                    ),
                    label: "",
                    description: "",
                    minutes: {},
                  },
                ],
              });
              setFocusId(id(definitionField.categoryLabel(n)));
            }}
          >
            {t("dependency.edit.addCategory")}
          </Button>
        </div>
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-2 text-body font-semibold">{t("dependency.edit.skills")}</legend>
        <p className="m-0 max-w-prose text-body-dense">{t("dependency.edit.skillsAbout")}</p>
        {draft.skillMix.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional while being edited.
          <div key={i} className="flex flex-wrap items-end gap-4">
            <SelectField
              id={id(`skill-${i}-skill`)}
              label={t("dependency.edit.skillName", { n: i + 1 })}
              value={s.skill}
              options={SKILLS.map((k) => ({
                value: k,
                label: t("dependency.skill", { skill: k }),
              }))}
              onChange={(e) => setSkill(i, { skill: e.currentTarget.value })}
            />
            <SelectField
              label={t("dependency.edit.skillPeriod", { n: i + 1 })}
              value={s.periodKey}
              options={periodOptions}
              onChange={(e) => setSkill(i, { periodKey: e.currentTarget.value })}
            />
            <TextField
              id={id(definitionField.skill(i))}
              label={t("dependency.edit.skillMinimum", { n: i + 1 })}
              value={s.minimumStaff}
              inputMode="numeric"
              maxLength={3}
              error={errors[definitionField.skill(i)]}
              onChange={(e) => setSkill(i, { minimumStaff: e.currentTarget.value })}
            />
            <Button
              variant="secondary"
              icon={<X {...icon} />}
              onClick={() => {
                onChange({ ...draft, skillMix: draft.skillMix.filter((_, n) => n !== i) });
                setFocusId(id("add-skill"));
              }}
            >
              {t("dependency.edit.removeSkill", { n: i + 1 })}
            </Button>
          </div>
        ))}
        <div>
          <Button
            id={id("add-skill")}
            variant="secondary"
            icon={<Plus {...icon} />}
            disabled={draft.periods.length === 0 || draft.skillMix.length >= 60}
            onClick={() => {
              const n = draft.skillMix.length;
              onChange({
                ...draft,
                skillMix: [
                  ...draft.skillMix,
                  { skill: SKILLS[0], periodKey: draft.periods[0]?.key ?? "", minimumStaff: "1" },
                ],
              });
              setFocusId(id(`skill-${n}-skill`));
            }}
          >
            {t("dependency.edit.addSkill")}
          </Button>
        </div>
      </fieldset>
      <TextField
        id={id(definitionField.review())}
        label={t("dependency.edit.reviewDays")}
        hint={t("dependency.edit.reviewDaysHint")}
        value={draft.reviewIntervalDays}
        inputMode="numeric"
        maxLength={4}
        error={errors[definitionField.review()]}
        onChange={(e) => onChange({ ...draft, reviewIntervalDays: e.currentTarget.value })}
      />
    </div>
  );
}

/** The editor's problems as the form's refusal, each linked to its field. */
function definitionRefusal(
  problems: readonly DefinitionProblem[],
  idPrefix: string,
  extra: Readonly<Record<string, string>> = {},
) {
  const fields = Object.fromEntries(problems.map((p) => [p.field, p.message]));
  const fieldIds = Object.fromEntries(problems.map((p) => [p.field, `${idPrefix}-${p.field}`]));
  return { result: fieldErrors({ ...extra, ...fields }), fields, fieldIds };
}

/** Makes a scale for a home (or the whole organisation) with its first draft. */
export function CreateScaleForm({
  locations,
  wholeOrganisation,
}: {
  readonly locations: readonly { readonly id: string; readonly name: string }[];
  /** Whether the member may make the organisation-wide scale. */
  readonly wholeOrganisation: boolean;
}) {
  const ids = useFieldIds(["name", "locationId", "definition"]);
  const { result, pending, send, setResult } = useSend("/settings/dependency");
  const [draft, setDraft] = useState<DraftDefinition>(EMPTY_DRAFT);
  const [problems, setProblems] = useState<{
    fields: Readonly<Record<string, string>>;
    fieldIds: Readonly<Record<string, string>>;
  }>({ fields: {}, fieldIds: {} });
  const idPrefix = `${ids.definition}-f`;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const where = String(form.get("locationId") ?? "");
    const errors: Record<string, string> = {};
    if (!name) errors.name = t("dependency.create.nameRequired");
    if (!where) errors.locationId = t("dependency.create.chooseWhere");
    const read = readDefinition(draft, t);
    const refusal = definitionRefusal(read.ok ? [] : read.problems, idPrefix, errors);
    setProblems(refusal);
    if (Object.keys(errors).length > 0 || !read.ok) return setResult(refusal.result);
    send(
      "created",
      () => createScale(name, where === "organisation" ? null : where, read.definition),
      (data) => dependencyScalePage((data as { id: string }).id),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.name}
        name="name"
        label={t("dependency.create.name")}
        hint={t("dependency.create.nameHint")}
        maxLength={120}
        autoComplete="off"
        required
        error={errorFor(result, "name")}
      />
      <SelectField
        id={ids.locationId}
        name="locationId"
        label={t("dependency.create.where")}
        emptyOption={t("dependency.create.chooseWhere")}
        options={[
          ...(wholeOrganisation
            ? [{ value: "organisation", label: t("dependency.create.organisation") }]
            : []),
          ...locations.map((l) => ({ value: l.id, label: l.name })),
        ]}
        required
        error={errorFor(result, "locationId")}
      />
      <DefinitionFields
        draft={draft}
        onChange={setDraft}
        errors={problems.fields}
        idPrefix={idPrefix}
      />
      <div>
        <Button type="submit" icon={<FilePlus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("dependency.create.submit")}
        </Button>
      </div>
      <FormFeedback
        result={result && !result.ok ? result : null}
        success=""
        fieldIds={{ ...ids, ...problems.fieldIds }}
      />
    </form>
  );
}

/** Changes a draft; whoever saves it joins its contributors and cannot approve it. */
export function EditDraftForm({
  scaleId,
  versionId,
  version,
  initial,
}: {
  readonly scaleId: string;
  readonly versionId: string;
  readonly version: number;
  readonly initial: DraftDefinition;
}) {
  const ids = useFieldIds(["definition"]);
  const { result, pending, send, setResult } = useSend(dependencyScalePage(scaleId));
  const [draft, setDraft] = useState<DraftDefinition>(initial);
  const [problems, setProblems] = useState<{
    fields: Readonly<Record<string, string>>;
    fieldIds: Readonly<Record<string, string>>;
  }>({ fields: {}, fieldIds: {} });
  const idPrefix = `${ids.definition}-f`;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readDefinition(draft, t);
    const refusal = definitionRefusal(read.ok ? [] : read.problems, idPrefix);
    setProblems(refusal);
    if (!read.ok) return setResult(refusal.result);
    send("saved", () => saveDraft(scaleId, versionId, version, read.definition));
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">{t("dependency.edit.contributor")}</p>
      <DefinitionFields
        draft={draft}
        onChange={setDraft}
        errors={problems.fields}
        idPrefix={idPrefix}
      />
      <div>
        <Button type="submit" icon={<Save {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("dependency.edit.save")}
        </Button>
      </div>
      <FormFeedback
        result={result && !result.ok ? result : null}
        success=""
        fieldIds={problems.fieldIds}
      />
    </form>
  );
}

function ActionButton({
  label,
  buttonIcon,
  onSend,
  done,
  path,
  variant = "primary",
}: {
  readonly label: string;
  readonly buttonIcon: ReactNode;
  readonly onSend: () => Promise<ActionResult<unknown>>;
  readonly done: string;
  readonly path: string;
  readonly variant?: "primary" | "secondary";
}) {
  const { result, pending, send } = useSend(path);
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant={variant}
          icon={buttonIcon}
          disabled={pending}
          onClick={() => send(done, onSend)}
        >
          {pending ? t("common.saving") : label}
        </Button>
      </div>
      <FormFeedback result={result && !result.ok ? result : null} success="" />
    </div>
  );
}

export function StartDraftButton({ scaleId }: { readonly scaleId: string }) {
  return (
    <ActionButton
      label={t("dependency.draft.start")}
      buttonIcon={<FilePlus {...icon} />}
      onSend={() => startDraft(scaleId)}
      done="drafted"
      path={dependencyScalePage(scaleId)}
      variant="secondary"
    />
  );
}

export function ApproveDraftButton({
  scaleId,
  versionId,
  version,
}: {
  readonly scaleId: string;
  readonly versionId: string;
  readonly version: number;
}) {
  const [open, setOpen] = useState(false);
  const { result, pending, send } = useSend(dependencyScalePage(scaleId));
  // Approving puts the version in use at once, for every rota check (HZ-123): confirm first.
  return (
    <div className="flex flex-col gap-2">
      <Sheet
        open={open}
        onOpenChange={setOpen}
        trigger={<Button icon={<CircleCheck {...icon} />}>{t("dependency.draft.approve")}</Button>}
        title={t("dependency.draft.approveTitle")}
        closeLabel={t("common.close")}
      >
        <div className="flex flex-col gap-4">
          <p className="m-0">{t("dependency.draft.approveAbout")}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <SheetClose asChild>
              <Button variant="secondary">{t("dependency.draft.keepDraft")}</Button>
            </SheetClose>
            <Button
              icon={<CircleCheck {...icon} />}
              disabled={pending}
              onClick={() => {
                setOpen(false);
                send("approved", () => approveDraft(scaleId, versionId, version));
              }}
            >
              {pending ? t("common.saving") : t("dependency.draft.approveConfirm")}
            </Button>
          </div>
        </div>
      </Sheet>
      <FormFeedback result={result && !result.ok ? result : null} success="" />
    </div>
  );
}

/** A reason, then the action: discard a draft, or archive a scale. */
export function ReasonButton({
  kind,
  scaleId,
  versionId,
  version,
}: {
  readonly kind: "discard" | "archive";
  readonly scaleId: string;
  readonly versionId?: string;
  readonly version: number;
}) {
  const ids = useFieldIds(["reason"]);
  const [open, setOpen] = useState(false);
  const { result, pending, send, setResult } = useSend(dependencyScalePage(scaleId));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    if (reason.length < 3)
      return setResult(fieldErrors({ reason: t("dependency.reason.required") }));
    send(
      kind === "discard" ? "discarded" : "archived",
      () =>
        kind === "discard" && versionId
          ? discardDraft(scaleId, versionId, version, reason)
          : archiveScale(scaleId, version, reason),
      undefined,
      () => setOpen(false),
    );
  };
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="secondary" icon={<Trash2 {...icon} />}>
          {t("dependency.reason.open", { kind })}
        </Button>
      }
      title={t("dependency.reason.title", { kind })}
      closeLabel={t("common.close")}
    >
      <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <p className="m-0">{t("dependency.reason.about", { kind })}</p>
        <TextArea
          id={ids.reason}
          name="reason"
          label={t("dependency.reason.label")}
          rows={3}
          maxLength={500}
          required
          error={errorFor(result, "reason")}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <SheetClose asChild>
            <Button variant="secondary">{t("dependency.reason.keep", { kind })}</Button>
          </SheetClose>
          <Button type="submit" variant="destructive" disabled={pending}>
            {pending ? t("common.saving") : t("dependency.reason.submit", { kind })}
          </Button>
        </div>
        <FormFeedback result={result && !result.ok ? result : null} success="" fieldIds={ids} />
      </form>
    </Sheet>
  );
}

/**
 * Records a person's category from the approved version of the scale at their home (rule 6): the
 * category, the date it applies from, why, and who decided. The first record is initial; a later
 * one is a review or a correction of the record in force.
 */
export function RecordDependencyForm({
  personId,
  path,
  categories,
  currentId,
  deciders,
  me,
  oneToOne,
}: {
  readonly personId: string;
  readonly path: string;
  readonly categories: readonly { readonly key: string; readonly label: string }[];
  readonly currentId: string | null;
  readonly deciders: readonly { readonly id: string; readonly name: string }[];
  readonly me: string;
  /** The record in force's one-to-one minutes, carried into a review or correction unchanged. */
  readonly oneToOne: readonly { readonly periodKey: string; readonly minutes: number }[];
}) {
  const ids = useFieldIds(["categoryKey", "kind", "effectiveFrom", "reason", "decidedBy"]);
  const { result, pending, send, setResult } = useSend(path);
  const [entryId] = useState(() => uuidv7());
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const categoryKey = String(form.get("categoryKey") ?? "");
    const kind = (currentId ? String(form.get("kind") ?? "review") : "initial") as
      | "initial"
      | "review"
      | "correction";
    const reason = String(form.get("reason") ?? "").trim();
    const decidedBy = String(form.get("decidedBy") ?? "");
    const date = readDateField(form, "effectiveFrom", { subject: t("dependency.record.from"), t });
    const errors: Record<string, string> = {};
    if (!categoryKey) errors.categoryKey = t("dependency.record.chooseCategory");
    if (!reason) errors.reason = t("dependency.record.reasonRequired");
    if (!decidedBy) errors.decidedBy = t("dependency.record.chooseDecider");
    if (!date.ok) errors.effectiveFrom = date.message;
    if (Object.keys(errors).length > 0 || !date.ok || !date.date)
      return setResult(fieldErrors(errors));
    send("recorded", () =>
      recordDependency(personId, {
        id: entryId,
        kind,
        categoryKey,
        effectiveFrom: date.date ?? "",
        reason,
        decidedBy,
        supersedesId: currentId,
        oneToOne,
      }),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.categoryKey}
        name="categoryKey"
        label={t("dependency.record.category")}
        emptyOption={t("dependency.record.chooseCategory")}
        options={categories.map((c) => ({ value: c.key, label: c.label }))}
        required
        error={errorFor(result, "categoryKey")}
      />
      {currentId ? (
        <SelectField
          id={ids.kind}
          name="kind"
          label={t("dependency.record.kind")}
          hint={t("dependency.record.kindHint")}
          options={["review", "correction"].map((k) => ({
            value: k,
            label: t("dependency.kind", { kind: k }),
          }))}
          defaultValue="review"
        />
      ) : null}
      <DateInput
        id={ids.effectiveFrom}
        name="effectiveFrom"
        legend={t("dependency.record.from")}
        hint={t("dependency.record.fromHint")}
        error={errorFor(result, "effectiveFrom")}
      />
      <TextArea
        id={ids.reason}
        name="reason"
        label={t("dependency.record.reason")}
        rows={3}
        maxLength={2000}
        required
        error={errorFor(result, "reason")}
      />
      <SelectField
        id={ids.decidedBy}
        name="decidedBy"
        label={t("dependency.record.decidedBy")}
        options={deciders.map((d) => ({ value: d.id, label: d.name }))}
        defaultValue={me}
        required
        error={errorFor(result, "decidedBy")}
      />
      <div>
        <Button type="submit" icon={<Save {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("dependency.record.submit")}
        </Button>
      </div>
      <FormFeedback result={result && !result.ok ? result : null} success="" fieldIds={ids} />
    </form>
  );
}
