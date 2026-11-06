import type {
  HealthResult,
  HrAbsence,
  HrCapability,
  HrClockEvent,
  HrEmployee,
  HrLocation,
  HrPage,
  HrPayUnit,
  HrRate,
  HrResult,
  HrShift,
  HrStarter,
  HrWorkspace,
  ThapsusHrPort,
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
  /** Idempotency keys seen, with what they created (Thapsus-HR keeps them 24 hours). */
  private readonly keys = new Map<string, string>();
  /** Every write the mock was given, for tests to check nothing extra crossed. */
  readonly writes: { readonly route: string; readonly body: unknown }[] = [];
  /** Calls left this minute before a 429 (600 by default in Thapsus-HR). */
  callsLeft = Number.POSITIVE_INFINITY;
  private next = 1;

  constructor(readonly workspaceInfo: HrWorkspace) {}

  capabilities() {
    return THAPSUS_HR_CAPABILITIES;
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

  private idempotent(key: string, route: string, body: unknown): HrResult<{ readonly id: string }> {
    const known = this.keys.get(key);
    if (known) return { ok: true, value: { id: known } };
    const id = `hr-${this.next++}`;
    this.keys.set(key, id);
    this.writes.push({ route, body });
    return { ok: true, value: { id } };
  }

  async createEmployee(starter: HrStarter, idempotencyKey: string) {
    return this.limited() ?? this.idempotent(idempotencyKey, "POST /v1/employees", starter);
  }

  async absences(cursor: string | null) {
    const start = cursor === null ? 0 : Number(cursor);
    const items = this.absencesList.slice(start, start + 100);
    const nextCursor = start + 100 < this.absencesList.length ? String(start + 100) : null;
    return this.limited() ?? { ok: true as const, value: { items, nextCursor } };
  }

  async upsertShift(shift: HrShift, idempotencyKey: string) {
    // Available today; partner ownership (read-only to others, 409 partnerManaged) is K2, planned.
    return this.limited() ?? this.idempotent(idempotencyKey, "POST /v1/shifts", shift);
  }

  async postClockEvent(event: HrClockEvent, idempotencyKey: string) {
    // `source: partner` is K2, planned; the route itself is available.
    return this.limited() ?? this.idempotent(idempotencyKey, "POST /v1/clock/events", event);
  }

  async putPayUnits(
    _payPeriodId: string,
    _units: readonly HrPayUnit[],
    _key: string,
  ): Promise<HrResult<{ readonly accepted: number }>> {
    return planned; // K4
  }

  async rates(_employeeIds: readonly string[]): Promise<HrResult<readonly HrRate[]>> {
    return planned; // K5
  }

  async health(): Promise<HealthResult> {
    return { ok: true, detail: `mock Thapsus-HR (pinned ${THAPSUS_HR_PINNED_COMMIT}, no network)` };
  }
}
