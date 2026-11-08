import { describe, expect, it } from "vitest";
import { phoneWitnessPolicy } from "./witness-policy";

describe("hazard HZ-116 the phone offers no witness only where the home's policy allows it", () => {
  it.each([
    ["a care home", ["residential"], "required"],
    ["a nursing home", ["nursing"], "required"],
    ["home care", ["domiciliary"], "where_available"],
    ["supported living and live-in", ["supported_living", "live_in"], "where_available"],
    ["home care run beside a care home", ["domiciliary", "residential"], "required"],
    ["a service type the phone does not know", ["something_new"], "required"],
  ] as const)("%s", (_case, services, policy) => {
    expect(phoneWitnessPolicy(services.map((service_type) => ({ service_type })))).toEqual({
      policy,
      known: true,
    });
  });

  it("says it does not know the home's rules yet, and needs a witness meanwhile", () => {
    expect(phoneWitnessPolicy([])).toEqual({ policy: "required", known: false });
  });
});
