import {
  type HealthResult,
  type HrAbsence,
  type HrCapability,
  type HrClockEvent,
  type HrEmployee,
  type HrLocation,
  type HrPage,
  type HrPayUnit,
  type HrResult,
  type HrShift,
  type HrStarter,
  type HrWorkspace,
  type OutboundFlow,
  outboundProblems,
  type ThapsusHrPort,
} from "@harbour/domain";

/**
 * Thapsus-HR mock (Phase 2 slice 86; INTG-014; ADR-0126; integrations.md section 11). No network.
 *
 * Pinned to Thapsus-HR commit d9888cef (01/11/2026), whose facts ADR-0126 records: employees,
 * org, leave and time scopes; `POST /v1/employees`; `/v1/shifts` and `/v1/clock/events`;
 * employee webhooks only; payroll and pay rates closed to API clients. The partner capabilities of
 * section 11.9 (K1 to K7, Thapsus-HR's Phase 19) are described here as planned: they answer
 * `planned` until Phase 19 ships, when the pin, this file and its contract tests are checked
 * again against Thapsus-HR's published OpenAPI document.
 */

export const THAPSUS_HR_PINNED_COMMIT = "d9888cef";

/** What Thapsus-HR offers at the pinned commit, and what its Phase 19 plans (section 11.9). */
export const THAPSUS_HR_CAPABILITIES: Readonly<Record<HrCapability, "available" | "planned">> = {
  employees_read: "available",
  employees_write: "available",
  org_read: "available",
  leave_read: "available",
  time_write: "available",
  partner_connections: "planned", // K1
  partner_managed_records: "planned", // K2: shifts and clock events a partner owns
  partner_events: "planned", // K3: shift, leave, sickness and timesheet events
  partner_pay_items: "planned", // K4: PUT /v1/pay-periods/{id}/partner-items
  pay_rates_read: "planned", // K5: scope pay-rates:read
  partner_rate_limit: "planned", // K6
};

const planned = { ok: false, error: "planned" } as const;

export class MockThapsusHr implements ThapsusHrPort {
  readonly pinnedCommit = THAPSUS_HR_PINNED_COMMIT;
  readonly employeesById = new Map<string, HrEmployee & { leavingDate: string | null }>();
  readonly absencesList: (HrAbsence & Record<string, unknown>)[] = [];
  readonly locationsList: HrLocation[] = [];
  /**
   * Idempotency keys by route, with what they created and when: Thapsus-HR keeps a key 24 hours,
   * so a retry after that creates the record again unless Harbour looks up its partner reference
   * first (rule 5).
   */
  private readonly keys = new Map<string, { id: string; body: string; at: number }>();
  /** The mock's clock, for tests of the 24-hour window. */
  now: () => number = () => Date.now();
  /** Every write the mock was given, for tests to check nothing extra crossed. */
  readonly writes: { readonly route: string; readonly body: unknown }[] = [];
  /** Calls left this minute before a 429 (600 by default in Thapsus-HR). */
  callsLeft = Number.POSITIVE_INFINITY;
  private next = 1;

  /**
   * `apiBaseUrl` is where this adapter sends, from Harbour's connection record; `workspaceInfo` is
   * what the workspace says about itself, which is never trusted for the UK check.
   */
  constructor(
    readonly workspaceInfo: HrWorkspace,
    readonly apiBaseUrl: string = workspaceInfo.apiBaseUrl,
  ) {}

  /**
   * Serve the pay capabilities Thapsus-HR's Phase 19 plans (K4, K5), for building and testing
   * against them before they ship. Off by default, as at the pinned commit.
   */
  phase19 = false;
  readonly payPeriodsList: Record<string, unknown>[] = [];
  readonly ratesList: Record<string, unknown>[] = [];
  /** The partner items held per pay period (replaced by each put). */
  readonly payItems = new Map<string, readonly HrPayUnit[]>();

  capabilities() {
    return this.phase19
      ? {
          ...THAPSUS_HR_CAPABILITIES,
          partner_pay_items: "available" as const,
          pay_rates_read: "available" as const,
        }
      : THAPSUS_HR_CAPABILITIES;
  }

  private limited(): HrResult<never> | null {
    if (this.callsLeft <= 0) return { ok: false, error: "rate_limited", retryAfterSeconds: 60 };
    this.callsLeft -= 1;
    return null;
  }

  async workspace(): Promise<HrResult<HrWorkspace>> {
    return this.limited() ?? { ok: true, value: this.workspaceInfo };
  }

  async locations(): Promise<HrResult<readonly HrLocation[]>> {
    return this.limited() ?? { ok: true, value: this.locationsList };
  }

  async employees(cursor: string | null): Promise<HrResult<HrPage<HrEmployee>>> {
    const all = [...this.employeesById.values()];
    const start = cursor === null ? 0 : Number(cursor);
    const items = all.slice(start, start + 100);
    const nextCursor = start + 100 < all.length ? String(start + 100) : null;
    return this.limited() ?? { ok: true, value: { items, nextCursor } };
  }

  async employee(id: string) {
    const hit = this.employeesById.get(id);
    return (
      this.limited() ??
      (hit
        ? { ok: true as const, value: hit }
        : { ok: false as const, error: "not_found" as const })
    );
  }

  private idempotent(
    /** The flow whose allow-list the body is checked against; null when the caller checked it. */
    flow: OutboundFlow | null,
    key: string,
    route: string,
    body: object,
  ): HrResult<{ readonly id: string }> {
    // Anything outside the flow's allow-list is refused, never sent (rule 4).
    if (flow && outboundProblems(flow, body).length > 0) return { ok: false, error: "refused" };
    const scoped = `${route} ${key}`;
    const text = JSON.stringify(body);
    const known = this.keys.get(scoped);
    if (known && this.now() - known.at < 24 * 3_600_000) {
      return known.body === text
        ? { ok: true, value: { id: known.id } }
        : { ok: false, error: "conflict" };
    }
    const id = `hr-${this.next++}`;
    this.keys.set(scoped, { id, body: text, at: this.now() });
    this.writes.push({ route, body });
    return { ok: true, value: { id } };
  }

  async createEmployee(starter: HrStarter, idempotencyKey: string) {
    return (
      this.limited() ?? this.idempotent("starter", idempotencyKey, "POST /v1/employees", starter)
    );
  }

  async absences(cursor: string | null) {
    const start = cursor === null ? 0 : Number(cursor);
    const items = this.absencesList.slice(start, start + 100);
    const nextCursor = start + 100 < this.absencesList.length ? String(start + 100) : null;
    return this.limited() ?? { ok: true as const, value: { items, nextCursor } };
  }

  async upsertShift(shift: HrShift, idempotencyKey: string) {
    // Available today; partner ownership (read-only to others, 409 partnerManaged) is K2, planned.
    return this.limited() ?? this.idempotent("shift", idempotencyKey, "POST /v1/shifts", shift);
  }

  async cancelShift(harbourRef: string, idempotencyKey: string) {
    return (
      this.limited() ??
      this.idempotent("shift", idempotencyKey, "DELETE /v1/shifts", { harbourRef })
    );
  }

  async postClockEvent(event: HrClockEvent, idempotencyKey: string) {
    // `source: partner` is K2, planned; the route itself is available.
    return (
      this.limited() ??
      this.idempotent("clock_event", idempotencyKey, "POST /v1/clock/events", event)
    );
  }

  /**
   * Units by pay code for a pay period (K4: `PUT /v1/pay-periods/{id}/partner-items`, idempotent;
   * a later put replaces the partner's items for the period). Planned at the pinned commit; the
   * mock serves it only with `phase19` set, as Thapsus-HR's Phase 19 plans it (slice 89).
   */
  async putPayUnits(
    payPeriodId: string,
    units: readonly HrPayUnit[],
    key: string,
  ): Promise<HrResult<{ readonly accepted: number }>> {
    if (!this.phase19) return planned; // K4
    if (!this.payPeriodsList.some((p) => p.id === payPeriodId)) {
      return this.limited() ?? { ok: false, error: "not_found" };
    }
    // Each item within the pay units allow-list, for this period (rule 4).
    if (
      units.some(
        (u) => outboundProblems("pay_units", u).length > 0 || u.payPeriodId !== payPeriodId,
      )
    ) {
      return this.limited() ?? { ok: false, error: "refused" };
    }
    const before = this.writes.length;
    const r =
      this.limited() ??
      this.idempotent(null, key, "PUT /v1/pay-periods/partner-items", { payPeriodId, units });
    if (!r.ok) return r;
    // A replay of the same key answers as before and changes nothing.
    if (this.writes.length > before) this.payItems.set(payPeriodId, units);
    return { ok: true, value: { accepted: units.length } };
  }

  /** Hourly rates and effective dates only (K5, scope pay-rates:read); `phase19` as above. */
  async rates(
    employeeIds: readonly string[],
  ): Promise<HrResult<readonly Readonly<Record<string, unknown>>[]>> {
    if (!this.phase19) return planned; // K5
    const wanted = new Set(employeeIds);
    return (
      this.limited() ?? {
        ok: true,
        value: this.ratesList.filter((r) => wanted.has(String(r.employeeId))),
      }
    );
  }

  /** Pay periods readable by API clients (K5); `phase19` as above. */
  async payPeriods(): Promise<HrResult<readonly Readonly<Record<string, unknown>>[]>> {
    if (!this.phase19) return planned; // K5
    return this.limited() ?? { ok: true, value: this.payPeriodsList };
  }

  async health(): Promise<HealthResult> {
    return { ok: true, detail: `mock Thapsus-HR (pinned ${THAPSUS_HR_PINNED_COMMIT}, no network)` };
  }
}
