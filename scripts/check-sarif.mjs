#!/usr/bin/env node
// CodeQL gate (section 7) while GitHub code scanning is not enabled on the repository (human action
// H-17): fails on any result whose rule carries a security severity of 7.0 or more (high or
// critical), and prints where. Usage: node scripts/check-sarif.mjs <directory of .sarif files>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HIGH = 7.0;
const dir = process.argv[2];
if (!dir) {
  console.error("Usage: check-sarif.mjs <directory>");
  process.exit(2);
}

const files = readdirSync(dir).filter((f) => f.endsWith(".sarif"));
if (files.length === 0) {
  console.error(`No SARIF files in ${dir}: the analysis did not run.`);
  process.exit(1);
}

const findings = [];
for (const file of files) {
  const sarif = JSON.parse(readFileSync(join(dir, file), "utf8"));
  for (const run of sarif.runs ?? []) {
    const rules = new Map();
    for (const rule of run.tool?.driver?.rules ?? []) rules.set(rule.id, rule);
    for (const ext of run.tool?.extensions ?? []) {
      for (const rule of ext.rules ?? []) rules.set(rule.id, rule);
    }
    for (const result of run.results ?? []) {
      const rule = rules.get(result.ruleId) ?? {};
      const severity = Number(rule.properties?.["security-severity"] ?? 0);
      if (severity < HIGH) continue;
      const location = result.locations?.[0]?.physicalLocation;
      findings.push(
        `${severity.toFixed(1)} ${result.ruleId} ${location?.artifactLocation?.uri ?? "?"}:${location?.region?.startLine ?? "?"}`,
      );
    }
  }
}

if (findings.length > 0) {
  console.error(`High or critical CodeQL findings:\n${findings.join("\n")}`);
  process.exit(1);
}
console.log(`CodeQL: no high or critical security findings in ${files.length} SARIF file(s).`);
