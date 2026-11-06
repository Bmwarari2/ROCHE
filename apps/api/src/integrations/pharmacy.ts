/**
 * The pharmacy ordering port (medicines.md section 15 rule 7; slice 42; ADR-0103). A submitted
 * order is sent as its lines (the product, quantity and unit, and an opaque id per person, never a
 * name) and the pharmacy's reference comes back. Only a contract-tested mock exists until the
 * pharmacy integration is chosen and assessed (H-517, H-1321); `PHARMACY_ORDERS` is `off` by
 * default and in production, and an order is then submitted by hand.
 */

export interface PharmacyOrderLine {
  readonly lineId: string;
  /** An opaque id for the person; the pharmacy matches it to its own records (H-1321). */
  readonly personRef: string;
  readonly vmpId: string;
  readonly quantity: number;
  readonly unitCode: string;
}

export interface PharmacyOrder {
  readonly orderId: string;
  readonly cycleStartsOn: string;
  readonly lines: readonly PharmacyOrderLine[];
}

export interface PharmacyOrderPort {
  submit(order: PharmacyOrder): Promise<{ readonly reference: string }>;
}

/** The pharmacy did not take the order; its words are never kept. */
export class PharmacyUnavailable extends Error {
  constructor() {
    super("pharmacy_unavailable");
  }
}

/** Sends through the port, with a reference of a safe shape, or refuses. */
export async function submitToPharmacy(
  port: PharmacyOrderPort,
  order: PharmacyOrder,
): Promise<string> {
  let reference: string;
  try {
    ({ reference } = await port.submit(order));
  } catch {
    throw new PharmacyUnavailable();
  }
  if (!/^[A-Za-z0-9-]{1,64}$/.test(reference)) throw new PharmacyUnavailable();
  return reference;
}

/** The mock: records each order it is given, answers with a reference, calls nothing. */
export class MockPharmacy implements PharmacyOrderPort {
  readonly received: PharmacyOrder[] = [];
  failNext = false;
  async submit(order: PharmacyOrder): Promise<{ readonly reference: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("mock failure");
    }
    this.received.push(order);
    return { reference: `mock-order-${this.received.length}` };
  }
}
