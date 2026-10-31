import { VETTING_RESULT_SCHEMAS } from "@harbour/contracts";
import {
  VETTING_REQUEST_FIELDS,
  type VettingAdapter,
  type VettingAnswer,
  type VettingCheckKind,
  type VettingRequestMap,
  type VettingResultMap,
} from "@harbour/domain";
import { expect, it } from "vitest";
import { strictVetting } from "./vetting";

/**
 * The contract every vetting adapter meets (ADR-0094). Run against each mock scenario here, and
 * against a vendor's sandbox when one is added: the same suite, so a vendor is one adapter class.
 *
 * - every answer is pending, completed with a result that parses with the port's strict schema,
 *   or failed with a short code;
 * - the same reference twice is the same check (the same external reference and result);
 * - a pending check is answered through `status`, and an unknown reference fails;
 * - through `strictVetting`, the adapter is sent only the port's declared fields;
 * - `health` answers.
 */
export interface ContractSubject<K extends VettingCheckKind> {
  readonly kind: K;
  /** A fresh adapter, and what it was sent (when it records requests). */
  readonly make: () => {
    adapter: VettingAdapter<VettingRequestMap[K], VettingResultMap[K]>;
    sent?: () => readonly unknown[];
  };
  readonly request: VettingRequestMap[K];
}

const shape = <R>(answer: VettingAnswer<R>, kind: VettingCheckKind) => {
  if (answer.state === "failed") {
    expect(answer.error).toMatch(/^[a-z_]{1,60}$/);
    expect(typeof answer.retryable).toBe("boolean");
    return;
  }
  expect(answer.externalReference.length).toBeGreaterThan(0);
  expect(answer.externalReference.length).toBeLessThanOrEqual(120);
  if (answer.state === "completed") {
    expect(VETTING_RESULT_SCHEMAS[kind].safeParse(answer.result).success).toBe(true);
  }
};

export function vettingContract<K extends VettingCheckKind>(subject: ContractSubject<K>): void {
  const { kind, make, request } = subject;

  it("answers in the port's shape, strictly", async () => {
    const { adapter } = make();
    const first = await adapter.start(request);
    shape(first, kind);
    if (first.state === "pending") shape(await adapter.status(first.externalReference), kind);
  });

  it("treats the same reference as the same check", async () => {
    const { adapter } = make();
    const one = await adapter.start(request);
    const two = await adapter.start(request);
    expect(two).toEqual(one);
  });

  it("answers a pending check through status, and fails an unknown reference", async () => {
    const { adapter } = make();
    const first = await adapter.start(request);
    if (first.state === "pending") {
      const later = await adapter.status(first.externalReference);
      expect(later.state).not.toBe("pending");
    }
    const unknown = await adapter.status("not-a-reference");
    expect(unknown.state).toBe("failed");
  });

  it("is sent only the port's declared fields", async () => {
    const { adapter, sent } = make();
    const wrapped = strictVetting(kind, adapter);
    await wrapped.start({
      ...request,
      // Something the caller holds that the port must never see.
      nhsNumber: "999 999 9999",
      disclosure: "Never sent",
    } as VettingRequestMap[K]);
    for (const body of sent?.() ?? []) {
      expect(Object.keys(body as object).sort()).toEqual(
        [...(VETTING_REQUEST_FIELDS[kind] as readonly string[])].sort(),
      );
    }
  });

  it("reports its health", async () => {
    const { adapter } = make();
    const health = await adapter.health();
    expect(typeof health.ok).toBe("boolean");
    expect(health.detail.length).toBeGreaterThan(0);
  });
}
