#!/usr/bin/env node
// Medicines gate (section 7, hooks): any change to packages/domain/src/medicines must change a test
// in the same module, because medicines rules are hazard-log controls (HZ-003, HZ-004, HZ-005, HZ-009).
import { changedFiles } from "./changed-files.mjs";

const files = changedFiles();
const source = files.filter((f) => /^packages\/domain\/src\/medicines\/.*(?<!\.test)\.ts$/.test(f));
const tests = files.filter((f) => /^packages\/domain\/src\/medicines\/.*\.test\.ts$/.test(f));
if (source.length > 0 && tests.length === 0) {
  console.error(
    `Medicines rules changed without tests:\n${source.map((f) => `  ${f}`).join("\n")}`,
  );
  process.exit(1);
}
console.log("Medicines gate: satisfied.");
