/**
 * The organisation's own escalation policy for a validated tool's result (medical-device boundary,
 * section 5 rule 4; hazards HZ-012 and HZ-014; human action H-73). Harbour states the published
 * band and links the policy the organisation configured for that tool and band, by its own title,
 * reference and document; it adds no recommendation of its own, and when nothing is configured it
 * says so rather than suggesting a response.
 *
 * A link names a tool and either one of its bands or every band, for the whole organisation or one
 * location. The most specific link wins: the location's for the band, the location's for every
 * band, the organisation's for the band, then the organisation's for every band.
 */

import type { BradenBand } from "./braden";
import type { MustBand } from "./must";
import type { News2Band } from "./news2";
import type { WaterlowBand } from "./waterlow";

/** The tools whose results link a policy: NEWS2 on vital signs and the stored assessments. */
export const ESCALATION_POLICY_TOOLS = [
  "news2",
  "must",
  "waterlow",
  "braden",
  "ng249_falls",
] as const;
export type EscalationPolicyTool = (typeof ESCALATION_POLICY_TOOLS)[number];

/**
 * The bands each tool's results carry (the `band` stored with every result, from news2.ts, must.ts,
 * waterlow.ts and braden.ts) that a policy may be linked to. The NG249 falls pathway has no band,
 * so its policy is for the tool as a whole.
 */
export const ESCALATION_POLICY_BANDS: Readonly<Record<EscalationPolicyTool, readonly string[]>> = {
  news2: ["low", "low_medium", "medium", "high"] satisfies readonly News2Band[],
  must: ["low", "medium", "high"] satisfies readonly MustBand[],
  waterlow: [
    "not_at_risk",
    "at_risk",
    "high_risk",
    "very_high_risk",
  ] satisfies readonly WaterlowBand[],
  braden: [
    "severe_risk",
    "high_risk",
    "moderate_risk",
    "at_risk",
    "below_at_risk_threshold",
  ] satisfies readonly BradenBand[],
  ng249_falls: [],
};

export function isEscalationPolicyTool(value: string): value is EscalationPolicyTool {
  return (ESCALATION_POLICY_TOOLS as readonly string[]).includes(value);
}

/** A configured link, as stored. */
export interface EscalationPolicyLink {
  readonly id: string;
  readonly toolKey: EscalationPolicyTool;
  /** One band of the tool, or null for every band. */
  readonly band: string | null;
  /** One location, or null for the whole organisation. */
  readonly locationId: string | null;
  /** The policy's name as the organisation calls it. */
  readonly title: string;
  /** The organisation's own reference for it (a document number and version), if any. */
  readonly reference: string | null;
  /** The policy document in the organisation's document store, if uploaded. */
  readonly documentId: string | null;
}

export type EscalationPolicyResolution =
  | {
      readonly status: "configured";
      readonly toolKey: EscalationPolicyTool;
      /** The result's band (null for a result with no band). */
      readonly band: string | null;
      readonly link: EscalationPolicyLink;
      /** Whether the link was for this band or for every band of the tool. */
      readonly matchedOn: "band" | "tool";
      /** Whether the link was the location's own or the organisation's. */
      readonly scope: "location" | "organisation";
    }
  | {
      readonly status: "not_configured";
      readonly toolKey: EscalationPolicyTool;
      readonly band: string | null;
    };

/**
 * The policy a result links: the most specific configured link for its tool, band and location,
 * or "not configured". Never invents a response; the band is passed through as stored.
 */
export function escalationPolicyFor(
  links: readonly EscalationPolicyLink[],
  result: {
    readonly toolKey: EscalationPolicyTool;
    readonly band: string | null;
    readonly locationId: string | null;
  },
): EscalationPolicyResolution {
  const forTool = links.filter((l) => l.toolKey === result.toolKey);
  const order: readonly {
    readonly scope: "location" | "organisation";
    readonly matchedOn: "band" | "tool";
  }[] = [
    { scope: "location", matchedOn: "band" },
    { scope: "location", matchedOn: "tool" },
    { scope: "organisation", matchedOn: "band" },
    { scope: "organisation", matchedOn: "tool" },
  ];
  for (const step of order) {
    if (step.scope === "location" && result.locationId === null) continue;
    if (step.matchedOn === "band" && result.band === null) continue;
    const link = forTool.find(
      (l) =>
        (step.scope === "location" ? l.locationId === result.locationId : l.locationId === null) &&
        (step.matchedOn === "band" ? l.band === result.band : l.band === null),
    );
    if (link) {
      return {
        status: "configured",
        toolKey: result.toolKey,
        band: result.band,
        link,
        matchedOn: step.matchedOn,
        scope: step.scope,
      };
    }
  }
  return { status: "not_configured", toolKey: result.toolKey, band: result.band };
}

/**
 * Whether every result of a tool would find one of the organisation's policies: every band of the
 * tool (the falls pathway has none, so it needs a link for the tool), at every location given, or
 * for the whole organisation when none is given. This is what the onboarding item
 * `escalation_policies_linked` asks (platform-completions.md rule 26; HZ-014).
 */
export function escalationPolicyCovers(
  links: readonly EscalationPolicyLink[],
  toolKey: EscalationPolicyTool,
  locationIds: readonly string[],
): boolean {
  const bands = ESCALATION_POLICY_BANDS[toolKey];
  const places = locationIds.length > 0 ? locationIds : [null];
  return places.every((locationId) =>
    (bands.length > 0 ? bands : [null]).every(
      (band) => escalationPolicyFor(links, { toolKey, band, locationId }).status === "configured",
    ),
  );
}

/**
 * The validated tools as the onboarding checklist reads them (`OnboardingState.validatedTools`),
 * fed from the organisation's links: linked when every result of the tool, at every location,
 * finds a policy. The document is the organisation's link for the whole tool, when it has one. A
 * tool Harbour links no policy for is never linked.
 */
export function validatedToolsWithLinks(
  tools: readonly { readonly key: string; readonly enabled: boolean }[],
  links: readonly EscalationPolicyLink[],
  locationIds: readonly string[],
): {
  readonly key: string;
  readonly enabled: boolean;
  readonly escalationPolicyDocumentId: string | null;
  readonly escalationPolicyLinked: boolean;
}[] {
  return tools.map((tool) => {
    if (!isEscalationPolicyTool(tool.key)) {
      return { ...tool, escalationPolicyDocumentId: null, escalationPolicyLinked: false };
    }
    const toolKey = tool.key;
    const wholeTool = links.find(
      (l) => l.toolKey === toolKey && l.band === null && l.locationId === null,
    );
    return {
      ...tool,
      escalationPolicyDocumentId: wholeTool?.documentId ?? null,
      escalationPolicyLinked: escalationPolicyCovers(links, toolKey, locationIds),
    };
  });
}

export interface EscalationPolicyLinkInput {
  readonly toolKey: string;
  readonly band: string | null;
  readonly title: string;
  readonly reference: string | null;
}

export type EscalationPolicyLinkCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly field: "toolKey" | "band" | "title" | "reference";
      readonly message: string;
    };

/** Printable characters only: the title and reference are shown beside clinical results. */
const PLAIN_TEXT = /^[^\p{Cc}\p{Cf}]*$/u;

/** Checks a link before it is saved: a known tool, one of its own bands, and a plain title. */
export function checkEscalationPolicyLink(
  input: EscalationPolicyLinkInput,
): EscalationPolicyLinkCheck {
  if (!isEscalationPolicyTool(input.toolKey)) {
    return { ok: false, field: "toolKey", message: "Choose a validated tool from the list." };
  }
  if (input.band !== null && !ESCALATION_POLICY_BANDS[input.toolKey].includes(input.band)) {
    return {
      ok: false,
      field: "band",
      message:
        input.toolKey === "ng249_falls"
          ? "The falls assessment has no bands: link one policy for the whole assessment."
          : "Choose one of the tool's own bands, or every band.",
    };
  }
  const title = input.title.trim();
  if (title.length < 3 || title.length > 200 || !PLAIN_TEXT.test(title)) {
    return {
      ok: false,
      field: "title",
      message: "Give the policy's name as your organisation calls it, in 3 to 200 characters.",
    };
  }
  const reference = input.reference?.trim() ?? "";
  if (reference.length > 100 || !PLAIN_TEXT.test(reference)) {
    return {
      ok: false,
      field: "reference",
      message: "Keep the policy's reference to 100 characters or fewer.",
    };
  }
  return { ok: true };
}
