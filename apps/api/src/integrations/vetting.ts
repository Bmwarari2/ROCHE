import { createHash } from "node:crypto";
import { VETTING_RESULT_SCHEMAS } from "@harbour/contracts";
import {
  type DbsApplicationResult,
  type HealthResult,
  type IdspRequest,
  type IdspResult,
  type NmcRegisterResult,
  PORT_OF_CHECK,
  type UpdateServiceResult,
  ukIsoDate,
  VETTING_REQUEST_FIELDS,
  type VettingAdapter,
  type VettingAnswer,
  type VettingCheckKind,
  type VettingPort,
  type VettingRequestMap,
  type VettingResultMap,
} from "@harbour/domain";

/**
 * Adapters for the vetting ports (ADR-0094; workforce.md section 2e). No vendor is chosen
 * (H-521 to H-523), so the only adapter is the mock: it records what it was asked and answers
 * from its configured `scenario`, never touching the network, and it never runs in production. A
 * port is off unless the organisation has a connection for it with a provider this build knows.
 *
 * Every adapter is wrapped by `strictVetting`, which sends only the port's declared fields, parses
 * each answer with the port's strict schema (an unexpected field, such as anything a DBS
 * certificate disclosed, fails the answer) and keeps provider error text out of the database.
 */

/** Providers each vetting port accepts in `integration_connection`. */
export const KNOWN_VETTING_PROVIDERS: Record<VettingPort, readonly string[]> = {
  "workforce.idsp": ["mock"],
  "workforce.dbs_ebulk": ["mock"],
  "workforce.dbs_update_service": ["mock"],
  "workforce.nmc_register": ["mock"],
};

/** Mock scenarios, chosen by the connection's `scenario` setting (the first is the default). */
export const MOCK_SCENARIOS: Record<VettingCheckKind, readonly string[]> = {
  idsp_right_to_work: ["verified", "not_verified", "pending", "unavailable"],
  dbs_application: ["clear", "disclosed", "withdrawn", "unavailable"],
  dbs_status_check: ["no_new_information", "new_information", "details_not_matched", "unavailable"],
  nmc_register_check: ["registered", "conditions", "not_registered", "unavailable"],
};

type Clock = () => Date;

const digits = (seed: string, n: number) =>
  BigInt(`0x${createHash("sha256").update(seed).digest("hex").slice(0, 15)}`)
    .toString()
    .padStart(n, "0")
    .slice(-n);

const plusYearMinusDay = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/**
 * The mock for one check kind. A start answers completed at once, except the DBS application
 * (always pending first, as the e-bulk route is) and the IDSP `pending` scenario; `status` then
 * completes it. The same reference twice gives the same answer. References are check ids (UUIDs).
 */
export class MockVetting<K extends VettingCheckKind>
  implements VettingAdapter<VettingRequestMap[K], VettingResultMap[K]>
{
  readonly provider = "mock";
  /** What the mock was asked, for the contract tests. */
  readonly requests: VettingRequestMap[K][] = [];

  constructor(
    readonly kind: K,
    readonly scenario: string = MOCK_SCENARIOS[kind][0] ?? "",
    private readonly clock: Clock = () => new Date(),
  ) {
    if (!MOCK_SCENARIOS[kind].includes(scenario)) {
      throw new Error(`Unknown mock scenario ${scenario} for ${kind}.`);
    }
  }

  private today() {
    return ukIsoDate(this.clock());
  }

  private result(request: VettingRequestMap[K]): VettingResultMap[K] {
    const on = this.today();
    const s = this.scenario;
    switch (this.kind) {
      case "idsp_right_to_work": {
        const r = request as IdspRequest;
        const out: IdspResult =
          s === "not_verified"
            ? { outcome: "not_verified", checkedOn: on }
            : { outcome: "identity_verified", checkedOn: on, document: r.document };
        return out as VettingResultMap[K];
      }
      case "dbs_application": {
        const out: DbsApplicationResult =
          s === "withdrawn"
            ? { outcome: "withdrawn", checkedOn: on }
            : {
                outcome: "certificate_issued",
                checkedOn: on,
                issuedOn: on,
                certificateNumber: `00${digits(request.reference, 10)}`,
                level: "enhanced_adults_barred",
                result: s === "disclosed" ? "information_disclosed" : "clear",
              };
        return out as VettingResultMap[K];
      }
      case "dbs_status_check": {
        const out: UpdateServiceResult = {
          outcome: s as UpdateServiceResult["outcome"],
          checkedOn: on,
        };
        return out as VettingResultMap[K];
      }
      default: {
        const out: NmcRegisterResult =
          s === "not_registered"
            ? { outcome: "not_registered", checkedOn: on, renewalDueOn: null }
            : {
                outcome: s === "conditions" ? "registered_with_conditions" : "registered",
                checkedOn: on,
                renewalDueOn: plusYearMinusDay(on),
              };
        return out as VettingResultMap[K];
      }
    }
  }

  /**
   * Stateless, so a check started in one request is answered in the next: the external
   * reference carries the check's reference (and, for the IDSP, the document type).
   */
  async start(request: VettingRequestMap[K]): Promise<VettingAnswer<VettingResultMap[K]>> {
    this.requests.push(request);
    if (this.scenario === "unavailable") {
      return { state: "failed", retryable: true, error: "provider_unavailable" };
    }
    const document = "document" in request ? String(request.document) : "-";
    const externalReference = `mock:${request.reference}:${document}`;
    return this.kind === "dbs_application" || this.scenario === "pending"
      ? { state: "pending", externalReference }
      : { state: "completed", externalReference, result: this.result(request) };
  }

  async status(externalReference: string): Promise<VettingAnswer<VettingResultMap[K]>> {
    const match = /^mock:([0-9a-f-]{36}):([a-z_]+|-)$/.exec(externalReference);
    if (!match) return { state: "failed", retryable: false, error: "unknown_reference" };
    const request = {
      reference: match[1],
      ...(match[2] !== "-" ? { document: match[2] } : {}),
    } as unknown as VettingRequestMap[K];
    return { state: "completed", externalReference, result: this.result(request) };
  }

  async health(): Promise<HealthResult> {
    return { ok: true, detail: "Mock adapter: checks are answered from its scenario, not made." };
  }
}

/** Only the port's declared fields, so nothing else the caller holds reaches a vendor. */
export function minimalRequest<K extends VettingCheckKind>(
  kind: K,
  request: VettingRequestMap[K],
): VettingRequestMap[K] {
  const fields = VETTING_REQUEST_FIELDS[kind] as readonly string[];
  return Object.fromEntries(
    fields.map((f) => [f, (request as unknown as Record<string, unknown>)[f]]),
  ) as unknown as VettingRequestMap[K];
}

/** Provider error text never reaches the database or the logs: a short code only. */
const errorCode = (error: unknown) =>
  typeof error === "string" && /^[a-z_]{1,60}$/.test(error) ? error : "provider_error";

/**
 * Wraps an adapter: minimal requests, strictly parsed answers, short error codes, and a thrown
 * adapter error turned into a retryable failure.
 */
export function strictVetting<K extends VettingCheckKind>(
  kind: K,
  adapter: VettingAdapter<VettingRequestMap[K], VettingResultMap[K]>,
): VettingAdapter<VettingRequestMap[K], VettingResultMap[K]> {
  const schema = VETTING_RESULT_SCHEMAS[kind];
  const checked = (
    answer: VettingAnswer<VettingResultMap[K]>,
  ): VettingAnswer<VettingResultMap[K]> => {
    if (answer.state === "failed") {
      return { state: "failed", retryable: answer.retryable, error: errorCode(answer.error) };
    }
    if (typeof answer.externalReference !== "string" || answer.externalReference.length > 120) {
      return { state: "failed", retryable: false, error: "invalid_answer" };
    }
    if (answer.state === "pending") {
      return { state: "pending", externalReference: answer.externalReference };
    }
    const parsed = schema.safeParse(answer.result);
    if (!parsed.success) return { state: "failed", retryable: false, error: "invalid_answer" };
    return {
      state: "completed",
      externalReference: answer.externalReference,
      result: parsed.data as VettingResultMap[K],
    };
  };
  const guard = async (fn: () => Promise<VettingAnswer<VettingResultMap[K]>>) => {
    try {
      return checked(await fn());
    } catch {
      return { state: "failed", retryable: true, error: "provider_error" } as const;
    }
  };
  return {
    provider: adapter.provider,
    health: () => adapter.health(),
    start: (request) => guard(() => adapter.start(minimalRequest(kind, request))),
    status: (externalReference) => guard(() => adapter.status(externalReference)),
  };
}

export interface VettingConnection {
  readonly provider: string;
  readonly settings: Record<string, unknown>;
}

export interface VettingAdapterOptions {
  readonly production: boolean;
  readonly clock?: Clock;
  /** Tests: the mock to use, so what it was sent can be read. */
  readonly mocks?: Partial<{ [K in VettingCheckKind]: MockVetting<K> }>;
}

/**
 * The adapter for a check, or null when its port is off: no connection, a provider this build
 * does not know, or the mock in production.
 */
export function createVettingAdapter<K extends VettingCheckKind>(
  kind: K,
  connection: VettingConnection | null,
  options: VettingAdapterOptions,
): VettingAdapter<VettingRequestMap[K], VettingResultMap[K]> | null {
  if (!connection) return null;
  const port = PORT_OF_CHECK[kind];
  if (!KNOWN_VETTING_PROVIDERS[port].includes(connection.provider)) return null;
  if (connection.provider === "mock") {
    if (options.production) return null;
    const given = options.mocks?.[kind] as MockVetting<K> | undefined;
    const scenario =
      typeof connection.settings.scenario === "string" ? connection.settings.scenario : undefined;
    const mock =
      given ??
      new MockVetting(
        kind,
        scenario && MOCK_SCENARIOS[kind].includes(scenario) ? scenario : undefined,
        options.clock,
      );
    return strictVetting(kind, mock);
  }
  return null;
}
