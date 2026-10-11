/**
 * Jailbreak and root detection (sections 5.3 and 17.2: warn, and disable eMAR on a compromised
 * device). Phase 0 ships the interface and a stub so screens and the eMAR gate can be built
 * against it.
 *
 * TODO(phase-2, eMAR): replace the stub with a native check before eMAR ships:
 * - on-device heuristics with `jail-monkey` (MIT), wrapped behind this interface, and
 * - server-verified attestation (Google Play Integrity API, Apple App Attest) checked by the API
 *   before it accepts eMAR uploads, since on-device checks alone can be bypassed.
 * Record the choice in an ADR and add the vendor to the sub-processor register if it receives data.
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
