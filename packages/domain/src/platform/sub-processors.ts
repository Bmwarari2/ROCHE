import { addUkDays } from "../shared/time";
import { can, type EffectiveAccess } from "./access";
import type { FlagKey } from "./feature-flags";
import type { PlatformRates } from "./rates";

/**
 * Sub-processor register and change notices (UK GDPR Art 28(2) and (4); DPA template clause 6;
 * docs/compliance/sub-processors.md; platform-completions.md rules 23 to 25). Tenants see the
 * sub-processors their configuration uses. Thapsus notifies them before a new or replacement
 * sub-processor processes their data; the notice period is also the window in which the tenant may
 * object on reasonable data protection grounds. The period is contractual (the tenant's DPA), so
 * it is a tenant setting resolved from the rate table (`sub_processor.notice_days`), never statute.
 */

export type AiProvider = "bedrock_london" | "bedrock_eu" | "anthropic" | "tenant_own";

export type SubProcessorUse =
  | { readonly kind: "always" }
  | { readonly kind: "capability"; readonly capability: "mobile_push" | "sms" }
  | { readonly kind: "ai_provider"; readonly provider: AiProvider };

export interface SubProcessorDefinition {
  readonly name: string;
  readonly service: string;
  readonly purpose: string;
  readonly location: string;
  readonly outsideUk: boolean;
  readonly use: SubProcessorUse;
}

/** Mirrors docs/compliance/sub-processors.md sections 1 and 3 (a test keeps them in step). */
export const SUB_PROCESSORS = {
  aws_hosting: {
    name: "Amazon Web Services",
    service: "RDS, S3, ECS Fargate, KMS, Secrets Manager, CloudWatch, CloudFront, WAF",
    purpose: "Hosting, storage, backups and compute",
    location: "AWS eu-west-2 (London)",
    outsideUk: false,
    use: { kind: "always" },
  },
  aws_ses: {
    name: "Amazon Web Services",
    service: "Simple Email Service (SES)",
    purpose: "Transactional email",
    location: "AWS eu-west-2 (London)",
    outsideUk: false,
    use: { kind: "always" },
  },
  sentry: {
    name: "Functional Software Inc. (Sentry)",
    service: "Error monitoring",
    purpose: "Diagnosing application errors (scrubbed, opaque ids only)",
    location: "Sentry EU region (EEA)",
    outsideUk: true,
    use: { kind: "always" },
  },
  grafana: {
    name: "Grafana Labs (Grafana Cloud)",
    service: "Traces, metrics and logs",
    purpose: "Operating and diagnosing the service (opaque ids only)",
    location: "Grafana Cloud UK region",
    outsideUk: false,
    use: { kind: "always" },
  },
  expo_push: {
    name: "Expo (650 Industries)",
    service: "Expo push notification service",
    purpose: "Delivering push notifications without personal data",
    location: "United States",
    outsideUk: true,
    use: { kind: "capability", capability: "mobile_push" },
  },
  apns_fcm: {
    name: "Apple (APNs) and Google (Firebase Cloud Messaging)",
    service: "Platform push delivery, reached through Expo",
    purpose: "Final delivery of push notifications",
    location: "United States and global",
    outsideUk: true,
    use: { kind: "capability", capability: "mobile_push" },
  },
  uk_sms_gateway: {
    name: "UK SMS gateway",
    service: "SMS",
    purpose: "SMS notifications and documented SMS sign-in exceptions",
    location: "United Kingdom",
    outsideUk: false,
    use: { kind: "capability", capability: "sms" },
  },
  bedrock_london: {
    name: "Amazon Web Services",
    service: "Amazon Bedrock, in-Region models in London",
    purpose: "Optional AI module (pseudonymised)",
    location: "AWS eu-west-2 (London)",
    outsideUk: false,
    use: { kind: "ai_provider", provider: "bedrock_london" },
  },
  bedrock_eu: {
    name: "Amazon Web Services",
    service: "Amazon Bedrock, Claude models via EU-geography cross-region inference",
    purpose: "Optional AI module (pseudonymised)",
    location: "EU regions in the Bedrock EU inference profile",
    outsideUk: true,
    use: { kind: "ai_provider", provider: "bedrock_eu" },
  },
  anthropic: {
    name: "Anthropic",
    service: "Claude via the Anthropic API under a zero-data-retention agreement",
    purpose: "Optional AI module (pseudonymised)",
    location: "Outside the UK, as stated for the configuration chosen",
    outsideUk: true,
    use: { kind: "ai_provider", provider: "anthropic" },
  },
} as const satisfies Record<string, SubProcessorDefinition>;

export type SubProcessorKey = keyof typeof SUB_PROCESSORS;

export interface SubProcessorConfig {
  readonly features: readonly FlagKey[];
  readonly capabilities: { readonly mobilePush: boolean; readonly sms: boolean };
  /** The AI provider chosen, used only while the AI module is on. A tenant's own key is its own contract. */
  readonly aiProvider: AiProvider | null;
}

/** True when a sub-processor with this use processes this tenant's data. */
export function subProcessorUsedBy(use: SubProcessorUse, config: SubProcessorConfig): boolean {
  switch (use.kind) {
    case "always":
      return true;
    case "capability":
      return use.capability === "mobile_push"
        ? config.capabilities.mobilePush
        : config.capabilities.sms;
    case "ai_provider":
      return (
        config.features.includes("module.ai") &&
        config.aiProvider === use.provider &&
        use.provider !== "tenant_own"
      );
  }
}

/** The sub-processors this tenant's configuration uses: what it sees and acknowledges in-app. */
export function subProcessorsInUse(config: SubProcessorConfig): SubProcessorKey[] {
  return (Object.keys(SUB_PROCESSORS) as SubProcessorKey[]).filter((key) =>
    subProcessorUsedBy(SUB_PROCESSORS[key].use, config),
  );
}

// ------------------------------------------------------------------------------------------------
// Change notices
// ------------------------------------------------------------------------------------------------

export interface SubProcessorNotice {
  readonly id: string;
  /** The catalogue key once the release adds it; the notice may come before that release. */
  readonly subProcessorKey: string;
  readonly kind: "new" | "replacement";
  readonly use: SubProcessorUse;
  readonly announcedAt: Date;
  /** When it will start processing data. */
  readonly effectiveFrom: Date;
}

/** End of the notice and objection window for one tenant (UK calendar days). */
export function objectionWindowEndsAt(
  notice: Pick<SubProcessorNotice, "announcedAt">,
  rates: Pick<PlatformRates, "subProcessorNoticeDays">,
): Date {
  return addUkDays(notice.announcedAt, rates.subProcessorNoticeDays);
}

export type NoticeTimingCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly problem: "notice_too_short";
      readonly earliestEffectiveFrom: Date;
    };

/**
 * Thapsus-side check before announcing: the change may not take effect before the longest notice
 * period among the tenants it affects (each tenant's DPA may set its own).
 */
export function checkNoticeTiming(
  notice: Pick<SubProcessorNotice, "announcedAt" | "effectiveFrom">,
  affectedTenantNoticeDays: readonly number[],
): NoticeTimingCheck {
  if (affectedTenantNoticeDays.length === 0) return { ok: true };
  const earliest = objectionWindowEndsAt(notice, {
    subProcessorNoticeDays: Math.max(...affectedTenantNoticeDays),
  });
  if (notice.effectiveFrom.getTime() < earliest.getTime()) {
    return { ok: false, problem: "notice_too_short", earliestEffectiveFrom: earliest };
  }
  return { ok: true };
}

export const OBJECTION_RESOLUTIONS = [
  "objection_withdrawn",
  "not_used_for_tenant",
  "services_ended",
] as const;
export type ObjectionResolution = (typeof OBJECTION_RESOLUTIONS)[number];

export interface NoticeResponse {
  readonly acknowledgedAt: Date | null;
  readonly objection: {
    readonly at: Date;
    readonly grounds: string;
    readonly resolvedAt: Date | null;
    readonly resolution: ObjectionResolution | null;
  } | null;
}

export type NoticeState =
  | "not_applicable"
  | "awaiting_response"
  | "acknowledged"
  | "objected"
  | "objection_resolved"
  | "deemed_accepted";

/**
 * Where a notice stands for one tenant: not applicable when the tenant's configuration does not
 * use it; an open objection until it is resolved; acknowledged; awaiting a response while the
 * window is open; deemed accepted once the window closes without an objection (clause 6.2).
 */
export function noticeStateFor(
  notice: SubProcessorNotice,
  response: NoticeResponse,
  config: SubProcessorConfig,
  now: Date,
  rates: Pick<PlatformRates, "subProcessorNoticeDays">,
): NoticeState {
  if (!subProcessorUsedBy(notice.use, config)) return "not_applicable";
  if (response.objection) return response.objection.resolvedAt ? "objection_resolved" : "objected";
  if (response.acknowledgedAt) return "acknowledged";
  return now.getTime() < objectionWindowEndsAt(notice, rates).getTime()
    ? "awaiting_response"
    : "deemed_accepted";
}

/**
 * Whether the new sub-processor may process this tenant's data now: not before the effective date
 * or the end of this tenant's window, and never while an objection is open or after it was
 * resolved by not using it for the tenant or by ending the affected services.
 */
export function mayProcessTenantData(
  notice: SubProcessorNotice,
  response: NoticeResponse,
  now: Date,
  rates: Pick<PlatformRates, "subProcessorNoticeDays">,
): boolean {
  if (now.getTime() < notice.effectiveFrom.getTime()) return false;
  if (now.getTime() < objectionWindowEndsAt(notice, rates).getTime()) return false;
  const objection = response.objection;
  if (!objection) return true;
  return objection.resolvedAt !== null && objection.resolution === "objection_withdrawn";
}

export const OBJECTION_GROUNDS_MIN_LENGTH = 20;

export type NoticeResponseProblem =
  | "missing_permission"
  | "not_applicable"
  | "window_closed"
  | "already_objected"
  | "grounds_required";

export type NoticeResponseCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: NoticeResponseProblem; readonly message: string };

const RESPONSE_MESSAGES: Record<NoticeResponseProblem, string> = {
  missing_permission:
    "Only the organisation's data protection lead or owner can answer this notice.",
  not_applicable: "This change does not affect your organisation's data.",
  window_closed: "The time to object has passed. Contact Thapsus support if you have a concern.",
  already_objected: "Your organisation has already objected. Thapsus will be in touch.",
  grounds_required: `Explain the data protection grounds for objecting (${OBJECTION_GROUNDS_MIN_LENGTH} characters or more).`,
};

/**
 * Acknowledging or objecting to a notice needs `platform.dpia.sign`. An objection must come within
 * the window and give its grounds; an acknowledgement can come at any time.
 */
export function checkNoticeResponse(input: {
  readonly kind: "acknowledge" | "object";
  readonly notice: SubProcessorNotice;
  readonly response: NoticeResponse;
  readonly config: SubProcessorConfig;
  readonly access: EffectiveAccess;
  readonly grounds?: string;
  readonly now: Date;
  readonly rates: Pick<PlatformRates, "subProcessorNoticeDays">;
}): NoticeResponseCheck {
  const fail = (problem: NoticeResponseProblem): NoticeResponseCheck => ({
    ok: false,
    problem,
    message: RESPONSE_MESSAGES[problem],
  });
  if (!can(input.access, "platform.dpia.sign")) return fail("missing_permission");
  if (!subProcessorUsedBy(input.notice.use, input.config)) return fail("not_applicable");
  if (input.response.objection && input.response.objection.resolvedAt === null) {
    return fail("already_objected");
  }
  if (input.kind === "acknowledge") return { ok: true };
  if (input.now.getTime() >= objectionWindowEndsAt(input.notice, input.rates).getTime()) {
    return fail("window_closed");
  }
  if ((input.grounds ?? "").trim().length < OBJECTION_GROUNDS_MIN_LENGTH) {
    return fail("grounds_required");
  }
  return { ok: true };
}
