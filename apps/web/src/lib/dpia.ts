import { type DpiaOverview, SaveDataProtectionSettings } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";
import type { FieldErrors } from "./outcome";

/**
 * The DPIA page (PLAT-023; platform-completions.md rules 17 to 22): pure and unit tested. Every
 * state is the API's; the page says it with an icon and a word, and a state it does not know warns
 * rather than reading as calm. The API checks every permission, step-up and rule again.
 */

export const DPIA_PAGE = "/settings/data-protection";
const READERS = ["platform.dpia.read", "platform.dpia.prepare", "platform.dpia.sign"];

export function dpiaShown(permissions: readonly string[]): boolean {
  return READERS.some((p) => permissions.includes(p));
}

const CHIPS: Record<DpiaOverview["state"], Omit<SafetyChip, "label">> = {
  not_started: { status: "due", icon: "circle-minus" },
  draft: { status: "due", icon: "clock" },
  prepared: { status: "due", icon: "clock" },
  signed: { status: "done", icon: "circle-check" },
  review_due: { status: "overdue", icon: "triangle-alert" },
};

export function dpiaChip(state: string, t: Translator): SafetyChip {
  const known = CHIPS[state as DpiaOverview["state"]];
  return {
    ...(known ?? { status: "overdue", icon: "circle-alert" }),
    label: t("dpia.state", { state: known ? state : "unknown" }),
  };
}

/** The sections the organisation answers, from Harbour's prefill. */
export interface DpiaPrefill {
  readonly sections: readonly {
    readonly key: string;
    readonly title: string;
    readonly tenantFields: readonly string[];
  }[];
  readonly risks: readonly { readonly id: string; readonly risk: string }[];
}

export function prefillOf(value: Record<string, unknown>): DpiaPrefill {
  const sections = Array.isArray(value.sections) ? (value.sections as DpiaPrefill["sections"]) : [];
  const risks = Array.isArray(value.risks) ? (value.risks as DpiaPrefill["risks"]) : [];
  return { sections, risks };
}

const RISK_LEVELS = ["low", "medium", "high"] as const;

/** The draft's answers, ratings and ICO reference from the form, by the prefill's fields. */
export function readDraft(form: { get(name: string): unknown }, prefill: DpiaPrefill) {
  const text = (name: string) => String(form.get(name) ?? "").trim();
  const answers: Record<string, Record<string, string>> = {};
  for (const section of prefill.sections) {
    if (section.tenantFields.length === 0) continue;
    answers[section.key] = Object.fromEntries(
      section.tenantFields.map((f) => [f, text(`answer.${section.key}.${f}`)]),
    );
  }
  const residualRisk = Object.fromEntries(
    prefill.risks.map((r) => {
      const level = text(`risk.${r.id}`);
      return [r.id, (RISK_LEVELS as readonly string[]).includes(level) ? level : null];
    }),
  ) as Record<string, (typeof RISK_LEVELS)[number] | null>;
  const ico = text("icoReference");
  return { answers, residualRisk, icoReference: ico || null };
}

export type SettingsInput = ReturnType<typeof SaveDataProtectionSettings.parse>;

const SETTINGS_MESSAGE: Readonly<Record<string, string>> = {
  dpoEmail: "dpia.settings.dpoEmailInvalid",
  privacyNoticeUrl: "dpia.settings.privacyInvalid",
  dpoName: "dpia.settings.dpoNameInvalid",
};

/** The governance settings from the form, checked with the API's own schema. */
export function readSettings(
  form: { get(name: string): unknown },
  extra: { readonly expectedVersion: number; readonly dpaSignedOn: string | null },
  t: Translator,
):
  | { readonly ok: true; readonly value: SettingsInput }
  | { readonly ok: false; fields: FieldErrors } {
  const text = (name: string) => String(form.get(name) ?? "").trim();
  const orNull = (name: string) => text(name) || null;
  const flag = (name: string) => form.get(name) === "on";
  const beyond = text("usesDataBeyondDirectCare");
  const parsed = SaveDataProtectionSettings.safeParse({
    leadId: orNull("leadId"),
    dpoName: orNull("dpoName"),
    dpoEmail: orNull("dpoEmail"),
    sector: text("sector") || "independent",
    privacyNoticeUrl: orNull("privacyNoticeUrl"),
    dpaSignedOn: extra.dpaSignedOn,
    usesDataBeyondDirectCare: beyond === "yes" ? true : beyond === "no" ? false : null,
    marketingEnabled: flag("marketingEnabled"),
    aiFreeTextEnabled: flag("aiFreeTextEnabled"),
    aiProvider: orNull("aiProvider"),
    expectedVersion: extra.expectedVersion,
  });
  if (parsed.success) return { ok: true, value: parsed.data };
  const fields: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? "");
    fields[key] ??= t((SETTINGS_MESSAGE[key] ?? "dpia.settings.invalid") as never);
  }
  return { ok: false, fields };
}

/**
 * The signing form is offered only to whoever may sign this version: a holder of
 * platform.dpia.sign named as the lead, who prepared none of it (the API checks it all again).
 */
export function maySign(
  open: {
    readonly status: string;
    readonly preparedBy: readonly ({ readonly id: string } | null)[];
  } | null,
  leadId: string | null,
  me: string,
  permissions: readonly string[],
): boolean {
  return (
    open?.status === "prepared" &&
    permissions.includes("platform.dpia.sign") &&
    leadId === me &&
    !open.preparedBy.some((p) => p?.id === me)
  );
}

/** What the draft form says before sending: a risk that stays high needs the ICO reference. */
export function checkDraft(draft: ReturnType<typeof readDraft>, t: Translator): FieldErrors {
  const high = Object.values(draft.residualRisk).some((level) => level === "high");
  return high && !draft.icoReference ? { icoReference: t("dpia.draft.icoRequired") } : {};
}
