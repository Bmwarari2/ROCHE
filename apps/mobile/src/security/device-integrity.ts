/**
 * Jailbreak and root detection (sections 5.3 and 17.2: warn, and disable eMAR on a compromised
 * device). Phase 2 slice 69 adds the on-device heuristics (`jail-monkey`, MIT, in
 * `native-integrity.ts`) behind this interface; `integrityFromSignals` decides from what they
 * report, so the rule is tested without a device. A phone whose checks cannot run reads as
 * "unknown", and eMAR stays off (`allowsHighRiskFeatures`).
 *
 * Server-verified attestation (Google Play Integrity API, Apple App Attest) checked by the API
 * before it accepts eMAR uploads is a follow-up (H-1432, ADR-0081): on-device checks alone can be
 * bypassed, and the vendors join the sub-processor register when it lands.
 */

export type IntegrityStatus = "trusted" | "compromised" | "unknown";

export interface DeviceIntegrityResult {
  readonly status: IntegrityStatus;
  /** Plain-English reasons for the user and support, without personal data. */
  readonly reasons: readonly string[];
  readonly checkedAt: Date;
}

export interface DeviceIntegrityChecker {
  check(): Promise<DeviceIntegrityResult>;
}

/** Stub: always "unknown", so features that require a trusted device (eMAR) stay off. */
export const stubIntegrityChecker: DeviceIntegrityChecker = {
  async check() {
    return {
      status: "unknown",
      reasons: ["Device integrity checks are not available in this version."],
      checkedAt: new Date(),
    };
  },
};

/** eMAR and other high-risk features need a positively trusted device. */
export function allowsHighRiskFeatures(result: DeviceIntegrityResult | null): boolean {
  return result?.status === "trusted";
}

/** What the on-device checks report. */
export interface IntegritySignals {
  /** Rooted (Android) or jailbroken (iOS). */
  readonly jailBroken: boolean;
  /** A hooking framework (Frida, Substrate, Xposed) is present. */
  readonly hookDetected: boolean;
}

/** The status from the on-device checks: any signal makes the device compromised. */
export function integrityFromSignals(
  signals: IntegritySignals | null,
  checkedAt: Date,
): DeviceIntegrityResult {
  if (signals === null) {
    return {
      status: "unknown",
      reasons: ["The device's integrity could not be checked."],
      checkedAt,
    };
  }
  const reasons = [
    ...(signals.jailBroken ? ["The device is rooted or jailbroken."] : []),
    ...(signals.hookDetected ? ["A tool that can change how apps run is installed."] : []),
  ];
  return { status: reasons.length > 0 ? "compromised" : "trusted", reasons, checkedAt };
}
