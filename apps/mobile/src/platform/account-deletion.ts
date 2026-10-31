import type { AccountDeletionRequest } from "@harbour/contracts";
import type { FetchLike } from "../auth/http";
import { isRetryableStatus } from "../auth/http";
import { parseInstant, ukDateTimeParts } from "../care/time";
import type { Translator } from "../i18n/t";
import { readProblemBody, TENANT_HEADER } from "../sync/session-signals";

/**
 * "Delete my account" (MOB-011; master prompt 17.3; App Store guideline 5.1.1(v) and Google
 * Play's account deletion policy). A staff account belongs to the care provider that set it up, so
 * the app sends a request to the provider (`POST /v1/me/account-deletion-request`), which a
 * Registered Manager answers within the rate table's confirmation period. Nothing is deleted on the
 * device or the server by asking; the person keeps working until the provider acts. Care records
 * are never deleted this way. Demo mode sends nothing.
 */

export type DeletionOutcome =
  | {
      readonly kind: "requested" | "already_requested";
      readonly respondBy: string;
      readonly routedToManager: boolean;
    }
  | { readonly kind: "offline" }
  | { readonly kind: "server" }
  | { readonly kind: "session" }
  | { readonly kind: "refused"; readonly reason: string | null }
  | { readonly kind: "demo" };

export interface DeletionRequestDeps {
  readonly apiUrl: string;
  readonly fetch: FetchLike;
  readonly token: string;
  readonly tenantId: string;
  readonly demoMode: boolean;
}

function isRequest(body: unknown): body is AccountDeletionRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    (b.status === "requested" || b.status === "already_requested") &&
    typeof b.respondBy === "string" &&
    typeof b.routedToManager === "boolean"
  );
}

export async function requestAccountDeletion(deps: DeletionRequestDeps): Promise<DeletionOutcome> {
  if (deps.demoMode) return { kind: "demo" };
  let response: Response;
  try {
    response = await deps.fetch(`${deps.apiUrl}/v1/me/account-deletion-request`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${deps.token}`,
        [TENANT_HEADER]: deps.tenantId,
      },
      credentials: "omit",
    });
  } catch {
    return { kind: "offline" };
  }
  if (response.ok) {
    const body: unknown = await response.json().catch(() => null);
    if (!isRequest(body)) return { kind: "refused", reason: null };
    return { kind: body.status, respondBy: body.respondBy, routedToManager: body.routedToManager };
  }
  if (response.status === 401) return { kind: "session" };
  // A busy or failing server is not "no connection": the words must say which (CONTENT.md).
  if (isRetryableStatus(response.status)) return { kind: "server" };
  return { kind: "refused", reason: (await readProblemBody(response)).reason };
}

/** What the screen says after asking: a title and words, never colour alone (MOB-011). */
export interface DeletionMessage {
  readonly title: string;
  readonly body: string;
  readonly sent: boolean;
}

/** The organisation's name for the words, or "your organisation" when it is not known. */
export function organisationWords(name: string | null | undefined): {
  readonly named: "yes" | "no";
  readonly organisation: string;
} {
  const trimmed = name?.trim() ?? "";
  return trimmed ? { named: "yes", organisation: trimmed } : { named: "no", organisation: "" };
}

export function deletionMessage(
  outcome: DeletionOutcome,
  organisationName: string | null | undefined,
  t: Translator,
): DeletionMessage {
  const org = organisationWords(organisationName);
  const notSent = (body: string): DeletionMessage => ({
    title: t("mobile.account.notSentTitle"),
    body,
    sent: false,
  });
  switch (outcome.kind) {
    case "requested":
    case "already_requested": {
      const instant = parseInstant(outcome.respondBy);
      const date = instant ? ukDateTimeParts(instant).date : outcome.respondBy;
      // Each title says what happened: kept but not yet seen, asked before, or sent now.
      if (!outcome.routedToManager) {
        return {
          title: t("mobile.account.keptTitle"),
          body: t("mobile.account.noManager", org),
          sent: true,
        };
      }
      return outcome.kind === "requested"
        ? {
            title: t("mobile.account.sentTitle"),
            body: t("mobile.account.requested", { ...org, date }),
            sent: true,
          }
        : {
            title: t("mobile.account.alreadyTitle"),
            body: t("mobile.account.alreadyRequested", { ...org, date }),
            sent: true,
          };
    }
    case "demo":
      return { title: t("mobile.account.demoTitle"), body: t("mobile.account.demo"), sent: false };
    case "offline":
      return notSent(t("mobile.account.offline"));
    case "server":
      return notSent(t("mobile.account.server"));
    case "session":
      return notSent(t("mobile.account.session"));
    case "refused":
      return notSent(
        outcome.reason
          ? t("mobile.account.refused", { reason: outcome.reason })
          : t("mobile.account.refusedNoReason"),
      );
  }
}
