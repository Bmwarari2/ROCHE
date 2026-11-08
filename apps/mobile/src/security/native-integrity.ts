/**
 * The on-device root and jailbreak checks (`jail-monkey`, MIT; ADR-0029, ADR-0081), behind
 * `DeviceIntegrityChecker`. A check that throws reads as "unknown", so eMAR stays off.
 */
import JailMonkey from "jail-monkey";
import {
  type DeviceIntegrityChecker,
  type IntegritySignals,
  integrityFromSignals,
} from "./device-integrity";

export const nativeIntegrityChecker: DeviceIntegrityChecker = {
  async check() {
    let signals: IntegritySignals | null = null;
    try {
      signals = { jailBroken: JailMonkey.isJailBroken(), hookDetected: JailMonkey.hookDetected() };
    } catch {
      signals = null;
    }
    return integrityFromSignals(signals, new Date());
  },
};
