#!/usr/bin/env node
// Docs gate (section 7): a pull request labelled `clinical` must update the hazard log or a safety
// case, and one labelled `data-protection` must update the records-of-processing register or the
// data-standards mapping. Section 20 rule 7 keeps these documents current with the code.
import { changedFiles, pullRequestLabels } from "./changed-files.mjs";

const RULES = {
  clinical: [/^docs\/clinical-safety\/hazard-log\.md$/, /^docs\/clinical-safety\/safety-case\//],
  "data-protection": [
    /^docs\/compliance\/records-of-processing\.md$/,
    /^docs\/specs\/data-standards\.md$/,
    /^docs\/compliance\/dpia-template\.md$/,
  ],
};

const labels = await pullRequestLabels();
const files = changedFiles();
const failures = [];
for (const [label, patterns] of Object.entries(RULES)) {
  if (!labels.includes(label)) continue;
  if (!files.some((f) => patterns.some((p) => p.test(f)))) {
    failures.push(
      `Label "${label}" needs a change to one of: ${patterns.map((p) => p.source).join(", ")}`,
    );
  }
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Docs gate: labels [${labels.join(", ")}] satisfied.`);
