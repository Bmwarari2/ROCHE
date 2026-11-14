#!/usr/bin/env node
// Where each GitHub Actions job runs (ADR-0137). Run: node scripts/check-ci-runners.mjs
//
// - A job that reads a secret (other than the run's own GITHUB_TOKEN) or asks for a cloud identity
//   (`id-token: write`) is privileged. It runs on GitHub's hosted runner, named literally, and
//   never on a third-party runner.
// - Every other job runs on Ubicloud: its `runs-on` names an `ubicloud-` label, usually behind a
//   repository variable (`${{ vars.CI_RUNNER || 'ubicloud-standard-4' }}`) so the runner can be
//   moved with one setting.
// - No job in ci.yml is privileged: the quality gates never read a secret.
//
// A deliberately small reader of the workflow files: it relies on the repository's own layout
// (jobs under `jobs:`, two-space indents), which the tests pin.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SECRET = /\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)[A-Za-z_]/;
const ID_TOKEN = /^\s*id-token:\s*write\s*$/m;
const GITHUB_HOSTED = /^(ubuntu|windows|macos)-[\w.-]+$/;

/** Splits a workflow into its jobs: name, the job's own text and its `runs-on` value. */
export function workflowJobs(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("jobs:");
  if (start === -1) return { header: text, jobs: [] };
  const header = lines.slice(0, start).join("\n");
  const jobs = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const name = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (name) {
      current = { name: name[1], lines: [] };
      jobs.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return {
    header,
    jobs: jobs.map(({ name, lines: body }) => {
      const runsOn = body.map((l) => /^ {4}runs-on:\s*(.+?)\s*$/.exec(l)).find(Boolean);
      return { name, text: body.join("\n"), runsOn: runsOn ? runsOn[1] : null };
    }),
  };
}

/** The problems in one workflow file, as sentences. */
export function checkWorkflow(file, text) {
  const problems = [];
  const { header, jobs } = workflowJobs(text);
  const headerPrivileged = SECRET.test(header) || ID_TOKEN.test(header);
  for (const job of jobs) {
    if (job.runsOn === null) continue; // a reusable workflow call runs where that workflow says
    const privileged = headerPrivileged || SECRET.test(job.text) || ID_TOKEN.test(job.text);
    const where = `${file}: job ${job.name}`;
    if (privileged) {
      if (file.endsWith("/ci.yml") || file === "ci.yml") {
        problems.push(`${where} reads a secret or a cloud identity; the quality gates never do.`);
      }
      if (!GITHUB_HOSTED.test(job.runsOn)) {
        problems.push(
          `${where} reads a secret or a cloud identity, so it must name a GitHub-hosted runner literally (it has "${job.runsOn}").`,
        );
      }
    } else if (!/ubicloud-/.test(job.runsOn)) {
      problems.push(`${where} runs on "${job.runsOn}"; jobs without secrets run on Ubicloud.`);
    }
  }
  return problems;
}

export function checkAll(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .flatMap((f) => checkWorkflow(`.github/workflows/${f}`, readFileSync(join(dir, f), "utf8")));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
  const problems = checkAll(dir);
  for (const p of problems) console.error(p);
  if (problems.length > 0) {
    console.error(`${problems.length} job(s) on the wrong runner (ADR-0137).`);
    process.exit(1);
  }
  console.log("Every job runs where ADR-0137 says.");
}
