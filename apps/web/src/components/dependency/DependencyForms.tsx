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
import { type FormEvent, type ReactNode, useState, useTransition } from "react";
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
  type DraftDefinition,
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
 * skill, and how often a category is reviewed. Every figure is the organisation's own.
 */
function DefinitionFields({
  draft,
  onChange,
}: {
  readonly draft: DraftDefinition;
  readonly onChange: (next: DraftDefinition) => void;
}) {
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
  const periodOptions = draft.periods.map((p) => ({ value: p.key, label: p.label || p.key }));

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-2 text-body font-semibold">{t("dependency.edit.periods")}</legend>
        <p className="m-0 max-w-prose text-body-dense">{t("dependency.edit.periodsAbout")}</p>
        {draft.periods.map((p, i) => (
          <div key={p.key} className="flex flex-wrap items-end gap-4">
            <TextField
              label={t("dependency.edit.periodName", { n: i + 1 })}
              value={p.label}
              maxLength={80}
              onChange={(e) => setPeriod(i, { label: e.currentTarget.value })}
            />
            <TextField
              label={t("dependency.edit.periodFrom", { n: i + 1 })}
              hint={t("rota.template.timeHint")}
              value={p.start}
              inputMode="numeric"
              maxLength={5}
              onChange={(e) => setPeriod(i, { start: e.currentTarget.value })}
            />
            <Button
              variant="secondary"
              icon={<X {...icon} />}
              onClick={() =>
                onChange({ ...draft, periods: draft.periods.filter((_, n) => n !== i) })
              }
            >
              {t("dependency.edit.removePeriod", { n: i + 1 })}
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="secondary"
            icon={<Plus {...icon} />}
            disabled={draft.periods.length >= 12}
            onClick={() =>
              onChange({
                ...draft,
                periods: [
                  ...draft.periods,
                  {
                    key: keyFromLabel(
                      `period ${draft.periods.length + 1}`,
                      new Set(draft.periods.map((p) => p.key)),
                    ),
                    label: "",
                    start: "",
                  },
                ],
              })
            }
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
                label={t("dependency.edit.categoryName", { n: i + 1 })}
                value={c.label}
                maxLength={80}
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
                {draft.periods.map((p) => (
                  <TextField
                    key={p.key}
                    label={t("dependency.edit.categoryMinutes", {
                      category: c.label || String(i + 1),
                      period: p.label || p.key,
                    })}
                    hint={t("dependency.edit.minutesHint")}
                    value={c.minutes[p.key] ?? ""}
                    inputMode="numeric"
                    maxLength={4}
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
                  onClick={() =>
                    onChange({ ...draft, categories: draft.categories.filter((_, n) => n !== i) })
                  }
                >
                  {t("dependency.edit.removeCategory", { name: c.label || String(i + 1) })}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <div>
          <Button
            variant="secondary"
            icon={<Plus {...icon} />}
            disabled={draft.categories.length >= 30}
            onClick={() =>
              onChange({
                ...draft,
                categories: [
                  ...draft.categories,
                  {
                    key: keyFromLabel(
                      `category ${draft.categories.length + 1}`,
                      new Set(draft.categories.map((c) => c.key)),
                    ),
                    label: "",
                    description: "",
                    minutes: {},
                  },
                ],
              })
            }
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
              label={t("dependency.edit.skillMinimum", { n: i + 1 })}
              value={s.minimumStaff}
              inputMode="numeric"
              maxLength={3}
              onChange={(e) => setSkill(i, { minimumStaff: e.currentTarget.value })}
            />
            <Button
              variant="secondary"
              icon={<X {...icon} />}
              onClick={() =>
                onChange({ ...draft, skillMix: draft.skillMix.filter((_, n) => n !== i) })
              }
            >
              {t("dependency.edit.removeSkill", { n: i + 1 })}
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="secondary"
            icon={<Plus {...icon} />}
            disabled={draft.periods.length === 0 || draft.skillMix.length >= 60}
            onClick={() =>
              onChange({
                ...draft,
                skillMix: [
                  ...draft.skillMix,
                  { skill: SKILLS[0], periodKey: draft.periods[0]?.key ?? "", minimumStaff: "1" },
                ],
              })
            }
          >
            {t("dependency.edit.addSkill")}
          </Button>
        </div>
      </fieldset>
      <TextField
        label={t("dependency.edit.reviewDays")}
        hint={t("dependency.edit.reviewDaysHint")}
        value={draft.reviewIntervalDays}
        inputMode="numeric"
        maxLength={4}
        onChange={(e) => onChange({ ...draft, reviewIntervalDays: e.currentTarget.value })}
      />
    </div>
  );
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
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const where = String(form.get("locationId") ?? "");
    const errors: Record<string, string> = {};
    if (!name) errors.name = t("dependency.create.nameRequired");
    if (!where) errors.locationId = t("dependency.create.chooseWhere");
    const read = readDefinition(draft, t);
    if (!read.ok) errors.definition = read.problems.join(" ");
    if (Object.keys(errors).length > 0 || !read.ok) return setResult(fieldErrors(errors));
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
      <div id={ids.definition} tabIndex={-1}>
        <DefinitionFields draft={draft} onChange={setDraft} />
      </div>
      <div>
        <Button type="submit" icon={<FilePlus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("dependency.create.submit")}
        </Button>
      </div>
      <FormFeedback result={result && !result.ok ? result : null} success="" fieldIds={ids} />
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
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readDefinition(draft, t);
    if (!read.ok) return setResult(fieldErrors({ definition: read.problems.join(" ") }));
    send("saved", () => saveDraft(scaleId, versionId, version, read.definition));
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">{t("dependency.edit.contributor")}</p>
      <div id={ids.definition} tabIndex={-1}>
        <DefinitionFields draft={draft} onChange={setDraft} />
      </div>
      <div>
        <Button type="submit" icon={<Save {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("dependency.edit.save")}
        </Button>
      </div>
      <FormFeedback result={result && !result.ok ? result : null} success="" fieldIds={ids} />
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
  return (
    <ActionButton
      label={t("dependency.draft.approve")}
      buttonIcon={<CircleCheck {...icon} />}
      onSend={() => approveDraft(scaleId, versionId, version)}
      done="approved"
      path={dependencyScalePage(scaleId)}
    />
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
            <Button variant="secondary">{t("common.cancel")}</Button>
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
}: {
  readonly personId: string;
  readonly path: string;
  readonly categories: readonly { readonly key: string; readonly label: string }[];
  readonly currentId: string | null;
  readonly deciders: readonly { readonly id: string; readonly name: string }[];
  readonly me: string;
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
