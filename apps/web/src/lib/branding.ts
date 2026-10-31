import { type AccentCheck, checkAccent, checkBrandName } from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import type { FieldErrors } from "./outcome";

/**
 * White-label branding in the web app (PLAT-002; platform.md, white-label branding): pure and unit
 * tested. The shell applies only an accent that passes `checkAccent` here again, whatever the API
 * sent; the settings screen says why a colour fails and offers the nearest one that works. The API
 * checks the permission and every rule again.
 */

export const BRANDING_PAGE = "/settings/branding";
export const MANAGE_BRANDING = "platform.tenant.manage";
/** The logo, through the web tier (the browser never reaches the API's /v1 routes itself). */
export const LOGO_ROUTE = "/branding/logo";
export const LOGO_TYPES = ["image/png", "image/jpeg"] as const;
export const LOGO_MAX_BYTES = 512 * 1024;

export function brandingShown(permissions: readonly string[]): boolean {
  return permissions.includes(MANAGE_BRANDING);
}

/**
 * The style the shell sets for the organisation's accent, in both themes, or null for Harbour's
 * own. Only `--accent` and `--accent-hover` change: the focus ring and status colours never take
 * the accent. `!important` wins over the theme rules (light, dark by media query, dark pinned);
 * the value is a normalised `#rrggbb`, so nothing else can reach the style sheet.
 */
export function accentStyle(accent: string | null | undefined): string | null {
  if (!accent) return null;
  const verdict = checkAccent(accent);
  if (!verdict.ok) return null;
  const value = verdict.accent;
  return `:root,[data-theme]{--accent:${value} !important;--accent-hover:${value} !important;}`;
}

/** The logo's address in the shell, changing with the document so a new logo is fetched. */
export function logoSrc(documentId: string | null | undefined): string | null {
  return documentId ? `${LOGO_ROUTE}?v=${encodeURIComponent(documentId)}` : null;
}

/** A contrast ratio as people read it: "4.6:1", rounded down so a pass never reads higher. */
export function ratioLabel(ratio: number): string {
  const floored = Math.floor(ratio * 10) / 10;
  return `${new Intl.NumberFormat("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(floored)}:1`;
}

export type AccentAdvice =
  | { readonly state: "empty" }
  | { readonly state: "not_a_colour"; readonly message: string }
  | {
      readonly state: "passes";
      readonly accent: string;
      readonly checks: readonly AccentCheck[];
    }
  | {
      readonly state: "fails";
      readonly problem: "too_light" | "too_dark";
      readonly accent: string;
      readonly message: string;
      readonly suggestion: string;
      readonly checks: readonly AccentCheck[];
    };

/** What the settings screen says about the colour typed, before anything is sent. */
export function accentAdvice(raw: string, t: Translator): AccentAdvice {
  if (raw.trim() === "") return { state: "empty" };
  const verdict = checkAccent(raw);
  if (verdict.ok) return { state: "passes", accent: verdict.accent, checks: verdict.checks };
  if (verdict.problem === "not_a_colour") {
    return { state: "not_a_colour", message: t("branding.accent.notAColour") };
  }
  return {
    state: "fails",
    problem: verdict.problem,
    accent: verdict.accent,
    message: t("branding.accent.failsSummary", { problem: verdict.problem }),
    suggestion: verdict.suggestion,
    checks: verdict.checks,
  };
}

/** One check, in words: "White words on it, light theme: 4.6:1 (needs 4.5:1)". */
export function checkLabel(check: AccentCheck, t: Translator): string {
  return t("branding.accent.check", {
    use: check.use,
    surface: check.surface,
    theme: check.theme,
    ratio: ratioLabel(check.ratio),
    needed: ratioLabel(check.needed),
  });
}

export interface BrandingInput {
  readonly displayName: string | null;
  readonly accent: string | null;
  readonly expectedVersion: number;
}

/** The name and accent from the form, checked as the API checks them. */
export function readBranding(
  form: { get(name: string): unknown },
  expectedVersion: number,
  t: Translator,
): { ok: true; value: BrandingInput } | { ok: false; fields: FieldErrors } {
  const fields: Record<string, string> = {};
  const name = checkBrandName(String(form.get("displayName") ?? ""));
  if (!name.ok) fields.displayName = t("branding.name.refused", { problem: name.problem });
  const accentRaw = String(form.get("accent") ?? "").trim();
  const advice = accentAdvice(accentRaw, t);
  if (advice.state === "not_a_colour" || advice.state === "fails") {
    fields.accent =
      advice.state === "fails"
        ? t("branding.accent.refusedWithSuggestion", {
            problem: advice.problem,
            suggestion: advice.suggestion,
          })
        : advice.message;
  }
  if (Object.keys(fields).length > 0 || !name.ok) return { ok: false, fields };
  return {
    ok: true,
    value: {
      displayName: name.name,
      accent: advice.state === "passes" ? advice.accent : null,
      expectedVersion,
    },
  };
}

/** Why a logo cannot be sent, before it is: its type and size, as the API checks them. */
export function logoProblem(
  file: { readonly type: string; readonly size: number } | null,
  t: Translator,
): string | null {
  if (!file || file.size === 0) return t("branding.logo.choose");
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return t("branding.logo.wrongType");
  if (file.size > LOGO_MAX_BYTES) return t("branding.logo.tooLarge");
  return null;
}
