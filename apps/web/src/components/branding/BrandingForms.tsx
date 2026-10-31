"use client";

import type { Branding } from "@harbour/contracts";
import { Button, buttonClassName, TextField } from "@harbour/ui";
import { CircleAlert, CircleCheck, ImageUp, Palette, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type CSSProperties, type FormEvent, useState, useTransition } from "react";
import { removeLogo, saveBranding, uploadLogo } from "@/app/actions/branding";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import {
  type AccentAdvice,
  accentAdvice,
  BRANDING_PAGE,
  checkLabel,
  LOGO_ROUTE,
  LOGO_TYPES,
  logoProblem,
  readBranding,
} from "@/lib/branding";
import { t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const small = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

/** Sends an action and, once done, opens the page again saying what was done (a new `at`). */
function useBrandingSend() {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = (done: string, call: () => Promise<ActionResult<unknown>>) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok)
        router.replace(`${BRANDING_PAGE}?done=${done}&at=${Date.now()}`, { scroll: false });
    });
  return { result, setResult, pending, send };
}

const DETAIL_FIELDS = ["displayName", "accent"] as const;

/** The colour the preview shows: the one typed when it passes, else the suggestion, else none. */
function previewOf(advice: AccentAdvice): { accent: string | null; label: string } {
  if (advice.state === "passes") {
    return {
      accent: advice.accent,
      label: t("branding.preview.chosen", { accent: advice.accent }),
    };
  }
  if (advice.state === "fails") {
    return {
      accent: advice.suggestion,
      label: t("branding.preview.suggested", { accent: advice.suggestion }),
    };
  }
  return { accent: null, label: t("branding.preview.standard") };
}

/** What the colour typed does, as an icon and words, with each contrast measured. */
function AccentAdviceView({
  advice,
  onUseSuggestion,
}: {
  readonly advice: AccentAdvice;
  readonly onUseSuggestion: (accent: string) => void;
}) {
  if (advice.state === "empty" || advice.state === "not_a_colour") return null;
  const passes = advice.state === "passes";
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 flex items-center gap-2 font-semibold">
        {passes ? <CircleCheck {...icon} /> : <CircleAlert {...icon} />}
        <span>
          {passes ? t("branding.accent.passes") : `${t("branding.accent.fails")} ${advice.message}`}
        </span>
      </p>
      {advice.state === "fails" ? (
        <div>
          <Button
            type="button"
            variant="secondary"
            icon={<Palette {...icon} />}
            onClick={() => onUseSuggestion(advice.suggestion)}
          >
            {t("branding.accent.useSuggestion", { suggestion: advice.suggestion })}
          </Button>
        </div>
      ) : null}
      <div>
        <h3 className="m-0 text-callout font-semibold">{t("branding.accent.checksTitle")}</h3>
        <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-callout">
          {advice.checks.map((check) => (
            <li key={`${check.theme}-${check.surface}`} className="flex items-center gap-2">
              {check.passes ? <CircleCheck {...small} /> : <CircleAlert {...small} />}
              <span>
                <span className="font-semibold">
                  {t("branding.accent.checkPasses", { passes: check.passes ? "yes" : "no" })}
                </span>
                {": "}
                {checkLabel(check, t)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * The colour in both themes: a primary button and a selected item, drawn with the design system's
 * classes and the accent set on an inner element (so the shell's own accent does not apply).
 */
function Preview({ accent, label }: { readonly accent: string | null; readonly label: string }) {
  const style = accent ? ({ "--accent": accent } as CSSProperties) : undefined;
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <h3 className="m-0 text-callout font-semibold">{label}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {(["light", "dark"] as const).map((theme) => (
          <div
            key={theme}
            data-theme={theme}
            className="rounded-card border border-border bg-bg p-4 text-text"
          >
            <div style={style} className="flex flex-col items-start gap-3">
              <p className="m-0 text-callout text-text-secondary">
                {t("branding.preview.theme", { theme })}
              </p>
              <span className={buttonClassName({ variant: "primary" })}>
                {t("branding.preview.button")}
              </span>
              <span className="border-0 border-b-2 border-solid border-accent pb-1">
                {t("branding.preview.selected")}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The display name and accent (platform.tenant.manage). The colour is checked as it is typed:
 * a colour that fails says why and offers the nearest one that works in one step; nothing that
 * fails is sent, and the API checks again.
 */
export function BrandingDetailsForm({ branding }: { readonly branding: Branding }) {
  const ids = useFieldIds(DETAIL_FIELDS);
  const { result, setResult, pending, send } = useBrandingSend();
  const [accent, setAccent] = useState(branding.accent ?? "");
  const advice = accentAdvice(accent, t);
  const preview = previewOf(advice);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readBranding(new FormData(event.currentTarget), branding.version, t);
    if (!read.ok) {
      setResult(fieldErrors(read.fields));
      return;
    }
    send("saved", () => saveBranding(read.value));
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.displayName}
        name="displayName"
        label={t("branding.name.label")}
        hint={t("branding.name.hint", { registeredName: branding.registeredName })}
        defaultValue={branding.displayName ?? ""}
        maxLength={80}
        autoComplete="organization"
        error={errorFor(result, "displayName")}
      />
      <TextField
        id={ids.accent}
        name="accent"
        label={t("branding.accent.label")}
        hint={t("branding.accent.hint")}
        value={accent}
        onChange={(event) => setAccent(event.currentTarget.value)}
        maxLength={7}
        autoComplete="off"
        spellCheck={false}
        className="max-w-xs"
        error={errorFor(result, "accent")}
      />
      <div aria-live="polite">
        <AccentAdviceView
          advice={advice}
          onUseSuggestion={(suggestion) => {
            setAccent(suggestion);
            setResult(null);
            document.getElementById(ids.accent)?.focus();
          }}
        />
      </div>
      <Preview accent={preview.accent} label={preview.label} />
      <div>
        <Button type="submit" disabled={pending} icon={<Save {...icon} />}>
          {pending ? t("common.saving") : t("branding.save")}
        </Button>
      </div>
      <ManageFeedback result={result} path={BRANDING_PAGE} fieldIds={ids} />
    </form>
  );
}

const LOGO_FIELDS = ["logo"] as const;

/** The logo (platform.tenant.manage): upload a new one, or stop showing the current one. */
export function BrandingLogoForm({ logo }: { readonly logo: Branding["logo"] }) {
  const ids = useFieldIds(LOGO_FIELDS);
  const { result, setResult, pending, send } = useBrandingSend();
  const [removing, startRemoving] = useTransition();
  const router = useRouter();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("logo");
    const problem = logoProblem(file instanceof File ? file : null, t);
    if (problem) {
      setResult(fieldErrors({ logo: problem }));
      return;
    }
    send("logo", () => uploadLogo(form));
  };
  const remove = () =>
    startRemoving(async () => {
      const outcome = await removeLogo();
      setResult(outcome);
      if (outcome.ok)
        router.replace(`${BRANDING_PAGE}?done=removed&at=${Date.now()}`, { scroll: false });
    });
  return (
    <div className="flex flex-col gap-4">
      {logo ? (
        <div className="flex flex-wrap items-center gap-4">
          {/* biome-ignore lint/performance/noImgElement: the logo comes through the app's own route, at its own size. */}
          <img
            src={`${LOGO_ROUTE}?v=${logo.documentId}`}
            alt={t("branding.logo.current")}
            height={48}
            className="h-12 w-auto max-w-[240px] object-contain"
          />
          <Button
            type="button"
            variant="destructive"
            disabled={removing}
            icon={<Trash2 {...icon} />}
            onClick={remove}
          >
            {removing ? t("branding.logo.removing") : t("branding.logo.remove")}
          </Button>
        </div>
      ) : (
        <p className="m-0">{t("branding.logo.none")}</p>
      )}
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <TextField
          id={ids.logo}
          name="logo"
          type="file"
          accept={LOGO_TYPES.join(",")}
          label={t("branding.logo.label")}
          hint={t("branding.logo.hint")}
          error={errorFor(result, "logo")}
        />
        <div>
          <Button type="submit" disabled={pending} icon={<ImageUp {...icon} />}>
            {pending ? t("branding.logo.uploading") : t("branding.logo.upload")}
          </Button>
        </div>
      </form>
      <ManageFeedback result={result} path={BRANDING_PAGE} fieldIds={ids} />
    </div>
  );
}
