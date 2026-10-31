"use client";

import type { Branding } from "@harbour/contracts";
import { Button, buttonClassName, TextField, VisuallyHidden } from "@harbour/ui";
import { colorDark, colorLight } from "@harbour/ui/tokens";
import { CircleAlert, CircleCheck, ImageUp, Palette, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
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

/** Harbour's own accent per theme, for the preview of "no accent" (the shell's may differ). */
const STANDARD_ACCENT = { light: colorLight.accent, dark: colorDark.accent } as const;

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
function previewOf(advice: AccentAdvice): { accent: string | null; caption: string } {
  if (advice.state === "passes") {
    return {
      accent: advice.accent,
      caption: t("branding.preview.showing", { kind: "chosen", accent: advice.accent }),
    };
  }
  if (advice.state === "fails") {
    return {
      accent: advice.suggestion,
      caption: t("branding.preview.showing", { kind: "suggested", accent: advice.suggestion }),
    };
  }
  return { accent: null, caption: t("branding.preview.showing", { kind: "standard", accent: "" }) };
}

/** The one sentence a screen reader hears, half a second after typing stops. */
function summaryOf(advice: AccentAdvice): string {
  if (advice.state === "passes") return t("branding.accent.passes");
  if (advice.state === "fails") return advice.message;
  return "";
}

function useSettled(value: string, delay = 500): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** What the colour typed does, as an icon and words, with each contrast measured. */
function AccentAdviceView({
  advice,
  onUseSuggestion,
}: {
  readonly advice: AccentAdvice;
  readonly onUseSuggestion: (accent: string) => void;
}) {
  const headingId = useId();
  if (advice.state === "empty" || advice.state === "not_a_colour") return null;
  const passes = advice.state === "passes";
  return (
    <div className="flex flex-col gap-3">
      {/* Shown here; announced once, by the status below the field. */}
      <p className="m-0 flex items-center gap-2 font-semibold" aria-hidden="true">
        {passes ? <CircleCheck {...icon} /> : <CircleAlert {...icon} />}
        <span>{summaryOf(advice)}</span>
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
      <section aria-labelledby={headingId}>
        <h3 id={headingId} className="m-0 text-callout font-semibold">
          {t("branding.accent.checksTitle")}
        </h3>
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
      </section>
    </div>
  );
}

/**
 * The colour in both themes: a sample button and a selected item, drawn with the design system's
 * classes and the accent set on an inner element, so the shell's own accent never shows through.
 * The samples are pictures, not controls: no pointer events, no hover.
 */
function Preview({
  accent,
  caption,
}: {
  readonly accent: string | null;
  readonly caption: string;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="m-0 text-callout font-semibold">
        {t("branding.preview.title")}
      </h3>
      <p className="m-0 text-callout">{caption}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {(["light", "dark"] as const).map((theme) => (
          <div
            key={theme}
            data-theme={theme}
            className="rounded-card border border-border bg-bg p-4 text-text"
          >
            <div
              style={{ "--accent": accent ?? STANDARD_ACCENT[theme] } as CSSProperties}
              className="pointer-events-none flex flex-col items-start gap-3"
            >
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
 * fails is sent, and the API checks again. Nothing typed is cut off: a name that is too long is
 * said at the field when saving.
 */
export function BrandingDetailsForm({ branding }: { readonly branding: Branding }) {
  const ids = useFieldIds(DETAIL_FIELDS);
  const { result, setResult, pending, send } = useBrandingSend();
  const [accent, setAccent] = useState(branding.accent ?? "");
  const advice = accentAdvice(accent, t);
  const preview = previewOf(advice);
  const announced = useSettled(summaryOf(advice));
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
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.displayName}
        name="displayName"
        label={t("branding.name.label")}
        hint={t("branding.name.hint", { registeredName: branding.registeredName })}
        defaultValue={branding.displayName ?? ""}
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
        autoComplete="off"
        spellCheck={false}
        className="max-w-xs"
        error={errorFor(result, "accent")}
      />
      <VisuallyHidden role="status">{announced}</VisuallyHidden>
      <AccentAdviceView
        advice={advice}
        onUseSuggestion={(suggestion) => {
          setAccent(suggestion);
          setResult(null);
          document.getElementById(ids.accent)?.focus();
        }}
      />
      <Preview accent={preview.accent} caption={preview.caption} />
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

/**
 * The logo (platform.tenant.manage): upload a new one, or stop showing the current one after
 * saying what that does. Focus moves into the question and back to the button when kept.
 */
export function BrandingLogoForm({ logo }: { readonly logo: Branding["logo"] }) {
  const ids = useFieldIds(LOGO_FIELDS);
  const { result, setResult, pending, send } = useBrandingSend();
  const [removing, startRemoving] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const confirmTitleId = useId();
  const confirmRef = useRef<HTMLHeadingElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
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
  const keep = () => {
    setConfirming(false);
    requestAnimationFrame(() => removeRef.current?.focus());
  };
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
          {confirming ? null : (
            <Button
              ref={removeRef}
              type="button"
              variant="destructive"
              icon={<Trash2 {...icon} />}
              onClick={() => setConfirming(true)}
            >
              {t("branding.logo.remove")}
            </Button>
          )}
        </div>
      ) : (
        <p className="m-0">{t("branding.logo.none")}</p>
      )}
      {logo && confirming ? (
        <section
          aria-labelledby={confirmTitleId}
          className="flex flex-col gap-3 rounded-card border border-border p-4"
        >
          <h3
            id={confirmTitleId}
            ref={confirmRef}
            tabIndex={-1}
            className="m-0 text-body font-semibold"
          >
            {t("branding.logo.removeConfirmTitle")}
          </h3>
          <p className="m-0">{t("branding.logo.removeConfirmBody")}</p>
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="destructive"
              disabled={removing}
              icon={<Trash2 {...icon} />}
              onClick={remove}
            >
              {removing ? t("branding.logo.removing") : t("branding.logo.remove")}
            </Button>
            <Button type="button" variant="secondary" disabled={removing} onClick={keep}>
              {t("branding.logo.keep")}
            </Button>
          </div>
        </section>
      ) : null}
      <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
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
