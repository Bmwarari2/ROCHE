// Unit tests for scripts/check-ci-runners.mjs. Run: pnpm test:scripts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkAll, checkWorkflow, workflowJobs } from "./check-ci-runners.mjs";

const workflow = (jobs, header = "name: x\non: push\n") => `${header}\njobs:\n${jobs}`;

describe("workflowJobs", () => {
  it("reads each job and its runner", () => {
    const { jobs } = workflowJobs(
      workflow(`  a:
    runs-on: \${{ vars.CI_RUNNER || 'ubicloud-standard-4' }}
    steps:
      - run: echo a
  b:
    uses: ./.github/workflows/other.yml
`),
    );
    assert.deepEqual(
      jobs.map((j) => j.name),
      ["a", "b"],
    );
    assert.match(jobs[0].runsOn, /^\$\{\{ vars\.CI_RUNNER \|\| 'ubicloud-standard-4' \}\}$/);
    assert.equal(jobs[1].runsOn, null);
  });
});

describe("checkWorkflow", () => {
  it("accepts a job without secrets on Ubicloud", () => {
    const text = workflow(`  test:
    runs-on: \${{ vars.CI_RUNNER || 'ubicloud-standard-4' }}
    steps:
      - run: pnpm test
`);
    assert.deepEqual(checkWorkflow(".github/workflows/ci.yml", text), []);
  });

  it("refuses a job without secrets on GitHub's runner", () => {
    const text = workflow(`  test:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm test
`);
    assert.match(
      checkWorkflow(".github/workflows/ci.yml", text)[0],
      /jobs without secrets run on Ubicloud/,
    );
  });

  it("refuses a job that reads a secret on Ubicloud", () => {
    const text = workflow(`  build:
    runs-on: \${{ vars.CI_RUNNER || 'ubicloud-standard-4' }}
    steps:
      - env:
          EXPO_TOKEN: \${{ secrets.EXPO_TOKEN }}
        run: eas build
`);
    assert.match(
      checkWorkflow(".github/workflows/mobile.yml", text)[0],
      /GitHub-hosted runner literally/,
    );
  });

  it("refuses a cloud identity on Ubicloud, set on the job or the whole workflow", () => {
    const onJob = workflow(`  plan:
    runs-on: ubicloud-standard-2
    permissions:
      id-token: write
`);
    assert.equal(checkWorkflow(".github/workflows/terraform.yml", onJob).length, 1);
    const onWorkflow = workflow(
      `  plan:
    runs-on: ubicloud-standard-2
`,
      "name: x\non: push\npermissions:\n  id-token: write\n",
    );
    assert.equal(checkWorkflow(".github/workflows/terraform.yml", onWorkflow).length, 1);
  });

  it("accepts a privileged job named on GitHub's runner, outside ci.yml", () => {
    const text = workflow(`  apply:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
`);
    assert.deepEqual(checkWorkflow(".github/workflows/terraform.yml", text), []);
  });

  it("never lets ci.yml read a secret, wherever it runs", () => {
    const text = workflow(`  checks:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ secrets.SOMETHING }}
`);
    assert.match(checkWorkflow(".github/workflows/ci.yml", text)[0], /quality gates never do/);
  });

  it("does not count the run's own GITHUB_TOKEN as a secret", () => {
    const text = workflow(`  checks:
    runs-on: \${{ vars.CI_RUNNER || 'ubicloud-standard-4' }}
    steps:
      - with:
          token: \${{ secrets.GITHUB_TOKEN }}
`);
    assert.deepEqual(checkWorkflow(".github/workflows/ci.yml", text), []);
  });
});

describe("the repository's workflows", () => {
  it("all run where ADR-0137 says", () => {
    const dir = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
    assert.deepEqual(checkAll(dir), []);
  });
});
