"use client";

import type { DataProtectionSettings } from "@harbour/contracts";
import { Button, Checkbox, DateInput, SelectField, TextArea, TextField } from "@harbour/ui";
import { FileCheck, PenLine, Save, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import {
  type DraftInput,
  prepareDpia,
  saveDataProtection,
  saveDpiaDraft,
  signDpia,
} from "@/app/actions/dpia";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { checkDraft, DPIA_PAGE, type DpiaPrefill, readDraft, readSettings } from "@/lib/dpia";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors, partsFor, partsRefusal } from "@/lib/outcome";
import { dateBoxesOf, readDateField } from "@/lib/uk-time";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/** Sends an action and, once done, opens the page again saying what was done (a new `at`). */
function useDpiaSend() {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = (done: string, call: () => Promise<ActionResult<unknown>>) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok)
        router.replace(`${DPIA_PAGE}?done=${done}&at=${Date.now()}`, { scroll: false });
    });
  return { result, setResult, pending, send };
}

const SETTINGS_FIELDS = [
  "leadId",
  "dpoName",
  "dpoEmail",
  "privacyNoticeUrl",
  "dpaSignedOn",
] as const;

/**
 * The organisation's data protection governance (platform.tenant.manage): the lead who signs the
 * DPIA, the DPO, the privacy notice, the DPA date, use beyond direct care and the optional
 * processing. Naming a different lead needs a fresh step-up, so the notice asks for it.
 */
export function GovernanceForm({
  settings,
  members,
}: {
  readonly settings: DataProtectionSettings;
  readonly members: readonly { readonly id: string; readonly name: string }[];
}) {
  const ids = useFieldIds(SETTINGS_FIELDS);
  const { result, setResult, pending, send } = useDpiaSend();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const dpa = readDateField(form, "dpaSignedOn", {
      subject: t("dpia.settings.dpaSubject"),
      optional: true,
      t,
    });
    if (!dpa.ok) {
      setResult(partsRefusal("dpaSignedOn", dpa));
      return;
    }
    const read = readSettings(
      form,
      { expectedVersion: settings.version, dpaSignedOn: dpa.date },
      t,
    );
    if (!read.ok) {
      setResult(fieldErrors(read.fields));
      return;
    }
    send("settings", () => saveDataProtection(read.value));
  };
  const beyond =
    settings.usesDataBeyondDirectCare === null
      ? ""
      : settings.usesDataBeyondDirectCare
        ? "yes"
        : "no";
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.leadId}
        name="leadId"
        label={t("dpia.settings.lead")}
        hint={t("dpia.settings.leadHint")}
        emptyOption={t("dpia.settings.leadEmpty")}
        defaultValue={settings.leadId ?? ""}
        options={members.map((m) => ({ value: m.id, label: m.name }))}
        error={errorFor(result, "leadId")}
      />
      <TextField
        id={ids.dpoName}
        name="dpoName"
        label={t("dpia.settings.dpoName")}
        defaultValue={settings.dpoName ?? ""}
        maxLength={200}
        autoComplete="off"
        error={errorFor(result, "dpoName")}
      />
      <TextField
        id={ids.dpoEmail}
        name="dpoEmail"
        type="email"
        label={t("dpia.settings.dpoEmail")}
        defaultValue={settings.dpoEmail ?? ""}
        maxLength={254}
        autoComplete="off"
        spellCheck={false}
        error={errorFor(result, "dpoEmail")}
      />
      <SelectField
        name="sector"
        label={t("dpia.settings.sector")}
        defaultValue={settings.sector}
        options={(["independent", "public"] as const).map((v) => ({
          value: v,
          label: t("dpia.settings.sectorOption", { sector: v }),
        }))}
      />
      <TextField
        id={ids.privacyNoticeUrl}
        name="privacyNoticeUrl"
        type="url"
        label={t("dpia.settings.privacy")}
        hint={t("dpia.settings.privacyHint")}
        defaultValue={settings.privacyNoticeUrl ?? ""}
        maxLength={500}
        spellCheck={false}
        error={errorFor(result, "privacyNoticeUrl")}
      />
      <DateInput
        id={ids.dpaSignedOn}
        name="dpaSignedOn"
        legend={t("dpia.settings.dpa")}
        hint={t("care.date.hint")}
        defaultValue={settings.dpaSignedOn}
        error={errorFor(result, "dpaSignedOn")}
        errorParts={dateBoxesOf(partsFor(result, "dpaSignedOn"))}
        labels={{ day: t("care.date.day"), month: t("care.date.month"), year: t("care.date.year") }}
      />
      <SelectField
        name="usesDataBeyondDirectCare"
        label={t("dpia.settings.beyond")}
        emptyOption={t("dpia.settings.beyondUnanswered")}
        defaultValue={beyond}
        options={(["yes", "no"] as const).map((v) => ({
          value: v,
          label: t("dpia.settings.beyondOption", { answer: v }),
        }))}
      />
      <Checkbox
        name="marketingEnabled"
        label={t("dpia.settings.marketing")}
        defaultChecked={settings.marketingEnabled}
      />
      <Checkbox
        name="aiFreeTextEnabled"
        label={t("dpia.settings.aiFreeText")}
        defaultChecked={settings.aiFreeTextEnabled}
      />
      {/* The AI provider is chosen with the AI module, not here: kept as it is. */}
      <input type="hidden" name="aiProvider" value={settings.aiProvider ?? ""} />
      <div>
        <Button type="submit" disabled={pending} icon={<Save {...icon} />}>
          {pending ? t("common.saving") : t("dpia.settings.save")}
        </Button>
      </div>
      <ManageFeedback
        result={result}
        path={DPIA_PAGE}
        fieldIds={ids}
        stepUp={t("dpia.settings.stepUp")}
      />
    </form>
  );
}

/**
 * The open version's answers and residual risk ratings (platform.dpia.prepare), with the ICO
 * reference when a risk stays high. Whoever saves joins the preparers, who may not sign it.
 */
export function DraftForm({
  prefill,
  answers,
  residualRisk,
  icoReference,
  version,
}: {
  readonly prefill: DpiaPrefill;
  readonly answers: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly residualRisk: Readonly<Record<string, string | null>>;
  readonly icoReference: string | null;
  /** The open version's `version`, or undefined to start a new one. */
  readonly version: number | undefined;
}) {
  const { result, setResult, pending, send } = useDpiaSend();
  // One id per field, so a refusal is said at its field and the summary links to it.
  const ids = useFieldIds([
    ...prefill.sections.flatMap((s) => s.tenantFields.map((f) => `answer.${s.key}.${f}`)),
    ...prefill.risks.map((r) => `risk.${r.id}`),
    "icoReference",
  ]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const draft = readDraft(new FormData(event.currentTarget), prefill);
    const errors = checkDraft(draft, t);
    if (Object.keys(errors).length > 0) {
      setResult(fieldErrors(errors));
      return;
    }
    const input: DraftInput = {
      ...(version === undefined ? {} : { expectedVersion: version }),
      ...draft,
    };
    send("saved", () => saveDpiaDraft(input));
  };
  return (
    <form method="post" className="flex flex-col gap-6" onSubmit={submit} noValidate>
      {prefill.sections
        .filter((s) => s.tenantFields.length > 0)
        .map((section) => (
          <fieldset key={section.key} className="m-0 flex flex-col gap-3 border-0 p-0">
            <legend className="mb-2 text-body font-semibold">{section.title}</legend>
            {section.tenantFields.map((field) => (
              <TextArea
                key={field}
                id={ids[`answer.${section.key}.${field}`]}
                error={errorFor(result, `answer.${section.key}.${field}`)}
                name={`answer.${section.key}.${field}`}
                label={t("dpia.field", { field })}
                rows={3}
                maxLength={10_000}
                defaultValue={answers[section.key]?.[field] ?? ""}
                formatCount={(remaining) => characterCount(remaining)}
              />
            ))}
          </fieldset>
        ))}
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-2 text-body font-semibold">{t("dpia.draft.risks")}</legend>
        {prefill.risks.map((risk) => (
          <SelectField
            key={risk.id}
            id={ids[`risk.${risk.id}`]}
            error={errorFor(result, `risk.${risk.id}`)}
            name={`risk.${risk.id}`}
            label={t("dpia.draft.risk", { id: risk.id, risk: risk.risk })}
            emptyOption={t("dpia.draft.riskEmpty")}
            defaultValue={residualRisk[risk.id] ?? ""}
            options={(["low", "medium", "high"] as const).map((level) => ({
              value: level,
              label: t("dpia.level", { level }),
            }))}
          />
        ))}
      </fieldset>
      <TextField
        id={ids.icoReference}
        error={errorFor(result, "icoReference")}
        name="icoReference"
        label={t("dpia.draft.ico")}
        hint={t("dpia.draft.icoHint")}
        defaultValue={icoReference ?? ""}
        maxLength={100}
      />
      <div>
        <Button type="submit" disabled={pending} icon={<Save {...icon} />}>
          {pending ? t("common.saving") : t("dpia.draft.save")}
        </Button>
      </div>
      <ManageFeedback result={result} path={DPIA_PAGE} fieldIds={ids} />
    </form>
  );
}

/** Marks the open version ready to sign: frozen as it stands, with its SHA-256. */
export function PrepareDpia({ version }: { readonly version: number }) {
  const { result, pending, send } = useDpiaSend();
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          variant="secondary"
          disabled={pending}
          icon={<FileCheck {...icon} />}
          onClick={() => send("prepared", () => prepareDpia(version))}
        >
          {pending ? t("common.saving") : t("dpia.prepare")}
        </Button>
      </div>
      <ManageFeedback result={result} path={DPIA_PAGE} />
    </div>
  );
}

const SIGN_FIELDS = ["typedName"] as const;

/**
 * Signs the prepared version (platform.dpia.sign, by the named lead, with a fresh step-up): the
 * typed name binds to the version's SHA-256 as shown, so a version changed since is refused.
 */
export function SignDpia({ id, sha256 }: { readonly id: string; readonly sha256: string }) {
  const ids = useFieldIds(SIGN_FIELDS);
  const { result, pending, send } = useDpiaSend();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const typedName = String(new FormData(event.currentTarget).get("typedName") ?? "").trim();
    send("signed", () => signDpia(id, { typedName, sha256Seen: sha256 }));
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <div role="note" className="flex gap-3">
        <ShieldCheck {...icon} className="mt-0.5 shrink-0" />
        <div className="flex flex-col gap-1">
          <p className="m-0">{t("dpia.sign.statement")}</p>
          <p className="m-0 break-all font-mono text-body-dense">
            {t("dpia.sign.sha", { sha256 })}
          </p>
        </div>
      </div>
      <TextField
        id={ids.typedName}
        name="typedName"
        label={t("dpia.sign.typedName")}
        hint={t("dpia.sign.typedNameHint")}
        autoComplete="name"
        maxLength={120}
        error={errorFor(result, "typedName")}
      />
      <div>
        <Button type="submit" disabled={pending} icon={<PenLine {...icon} />}>
          {pending ? t("common.saving") : t("dpia.sign.submit")}
        </Button>
      </div>
      <ManageFeedback
        result={result}
        path={DPIA_PAGE}
        fieldIds={ids}
        stepUp={t("dpia.sign.stepUp")}
      />
    </form>
  );
}
