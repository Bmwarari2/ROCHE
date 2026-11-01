#!/usr/bin/env node
// Licence gate (master prompt section 20, rule 8): every dependency, direct or transitive, must be
// on the allowlist. SPDX expressions are evaluated: OR needs one allowed side, AND needs both.
// Exceptions are listed by package with a reason and recorded in ADR-0024.
import { execFileSync } from "node:child_process";

const ALLOWED = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "ISC",
  "MPL-2.0",
  "PostgreSQL",
  "OFL-1.1",
  "CC0-1.0",
  "Unlicense",
  "BlueOak-1.0.0",
  "Python-2.0",
  // MIT without the attribution clause: strictly more permissive than MIT (ADR-0024).
  "MIT-0",
]);

/** PowerSync is allowed under its Functional Source Licence (section 20); nothing else is. */
const FSL_PACKAGES = new Set(["@powersync/service-sync-rules", "@powersync/service-jsonbig"]);

const EXCEPTIONS = new Map([
  [
    "caniuse-lite",
    "CC-BY-4.0 browser support data read at build time by browserslist; never shipped",
  ],
  [
    "spawndamnit",
    "MIT per its repository LICENCE file; the published package omits the field (dev tool of Changesets)",
  ],
  [
    "parse-cache-control",
    "BSD-3-Clause per its LICENSE file; the package field says only BSD (dev tool: Lighthouse CI)",
  ],
  [
    "xml-escape",
    'MIT per its LICENSE file; the package field says "MIT License" (samlify, via the SSO plugin; ADR-0091)',
  ],
]);

function allowed(expression) {
  const expr = expression.replace(/^\((.*)\)$/, "$1").trim();
  if (expr.includes(" OR ")) return expr.split(" OR ").some((part) => allowed(part));
  if (expr.includes(" AND ")) return expr.split(" AND ").every((part) => allowed(part));
  return ALLOWED.has(expr);
}

const raw = execFileSync("pnpm", ["licenses", "list", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const byLicence = JSON.parse(raw);
const failures = [];
for (const [licence, packages] of Object.entries(byLicence)) {
  for (const pkg of packages) {
    if (allowed(licence)) continue;
    if (licence.startsWith("FSL-") && FSL_PACKAGES.has(pkg.name)) continue;
    if (EXCEPTIONS.has(pkg.name)) continue;
    failures.push(`${pkg.name}@${pkg.versions?.join(",") ?? "?"}: ${licence}`);
  }
}

if (failures.length > 0) {
  console.error(
    "Dependencies with licences outside the allowlist:\n" +
      failures.map((f) => `  ${f}`).join("\n"),
  );
  console.error(
    "Swap the dependency for an allowed one, or record a justified exception in ADR-0024.",
  );
  process.exit(1);
}
console.log(`Licences: ${Object.values(byLicence).flat().length} packages checked, all allowed.`);
