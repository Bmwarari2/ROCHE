#!/usr/bin/env node
/**
 * The product rename (ADR-0127): "Harbour" becomes "Thapsus Care" wherever people read it, in one
 * pass after batch 4 merges. See docs/plans/rename-thapsus-care.md for the scope and the order.
 *
 *   node scripts/rename-product.mjs            # dry run: what would change, per file
 *   node scripts/rename-product.mjs --apply    # write the changes
 *   node scripts/rename-product.mjs --check    # exit 1 if any in-scope "Harbour" is left
 *
 * Only the capitalised whole word "Harbour" is touched, so technical identifiers never are:
 * `@harbour/*` packages, `HARBOUR_*` variables, `harbour_*` database roles, `x-harbour-tenant`,
 * cloud resource names, Terraform, bundle ids, the deep link scheme and the passkey rpID are all
 * lower or upper case. Code comments, frozen history (ADRs other than 0127, the changelog
 * fragments, CHANGELOG-DEV.md), migrations, infrastructure and the invented demo place names
 * ("Harbour House" and the rest) are out of scope; see the plan for why.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FROM = "Harbour";
const TO = "Thapsus Care";

/** Invented demo and fixture names: places and organisations, not the product. Kept. */
const DEMO_NAMES =
  /\bHarbour (?:House|Field|Mews|Demo Care|Quay|Lodge|Cottage|Example Care(?: and Support Services)?)\b/g;

const args = new Set(process.argv.slice(2));
const mode = args.has("--apply") ? "apply" : args.has("--check") ? "check" : "dry-run";

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);

/** Which files are in scope, and how: whole file (prose, catalogues) or code lines only. */
function scopeOf(path) {
  if (/^packages\/i18n\/src\/messages\/[^/]+\.json$/.test(path) && !path.endsWith(".status.json"))
    return "whole";
  if (path.endsWith(".md")) {
    // ADR-0127 records the codename on purpose; the master prompt's two lines about the codename
    // are rewritten by hand (the plan, section 1), and the rest of it is in scope.
    if (path.startsWith("docs/decisions/")) return null;
    if (path.startsWith("docs/changelog-dev/") || path === "docs/CHANGELOG-DEV.md") return null;
    if (path === "docs/plans/rename-thapsus-care.md") return null;
    if (path.includes("node_modules/")) return null;
    return "whole";
  }
  if (/^apps\/mobile\/\.maestro\/.+\.ya?ml$/.test(path)) return "whole";
  if (/^(apps|packages)\/.+\.(ts|tsx|mjs|js)$/.test(path)) {
    // Generated from the code: regenerated after, never edited by hand.
    if (path === "packages/contracts/src/client/api-types.ts") return null;
    if (path.includes("/drizzle/")) return null;
    return "code";
  }
  return null;
}

/** A line that is only a comment: kept (internal; the codebase keeps its codename). */
const COMMENT = /^\s*(?:\/\/|\*|\/\*|\{\/\*)/;

/** Lines rewritten by hand (the plan, section 1): left for a person, never half-renamed. */
const BY_HAND = [
  /is a working codename/,
  /\| Harbour \(working name\) \|/,
  // The iOS project name follows Expo's `name` at prebuild: check the real names, then edit.
  /xcodebuild|\.xcworkspace/,
];

function rename(text, scope) {
  let count = 0;
  const swap = (segment) =>
    segment.replace(/\bHarbour\b/g, (match, offset, whole) => {
      // Never inside a host name, address or URL ("Family.Harbour.Example", "Harbour@…").
      // A full stop or colon after it in prose ("… in Harbour.", "Harbour: …") is renamed.
      const before = whole[offset - 1] ?? "";
      const after = whole.slice(offset + match.length, offset + match.length + 3);
      if (/[./@]/.test(before) || /^[.@][A-Za-z0-9]/.test(after) || after.startsWith("://")) {
        return match;
      }
      // Skip the demo names: check whether this occurrence starts one.
      DEMO_NAMES.lastIndex = 0;
      for (const demo of whole.matchAll(DEMO_NAMES)) {
        if (demo.index === offset) return match;
      }
      count += 1;
      return TO;
    });
  const keep = (line) => BY_HAND.some((pattern) => pattern.test(line));
  if (scope === "whole") {
    const lines = text.split("\n").map((line) => (keep(line) ? line : swap(line)));
    return { text: lines.join("\n"), count: () => count };
  }
  const lines = text
    .split("\n")
    .map((line) => (COMMENT.test(line) || keep(line) ? line : swap(line)));
  return { text: lines.join("\n"), count: () => count };
}

let files = 0;
let total = 0;
for (const path of tracked) {
  const scope = scopeOf(path);
  if (!scope) continue;
  let before;
  try {
    before = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  if (!before.includes(FROM)) continue;
  const result = rename(before, scope);
  const n = result.count();
  if (n === 0) continue;
  files += 1;
  total += n;
  if (mode === "apply") writeFileSync(path, result.text);
  else console.log(`${String(n).padStart(4)}  ${path}`);
}

if (mode === "check") {
  if (total > 0) {
    console.error(`${total} in-scope "${FROM}" left in ${files} files (run with --apply).`);
    process.exit(1);
  }
  console.log(`No in-scope "${FROM}" left.`);
} else {
  console.log(
    `${mode === "apply" ? "Changed" : "Would change"} ${total} in ${files} files (${FROM} -> ${TO}).`,
  );
  if (mode === "apply") {
    console.log(
      "Next: regenerate OpenAPI and the client, format, test (docs/plans/rename-thapsus-care.md).",
    );
  }
}
