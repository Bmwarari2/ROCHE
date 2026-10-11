import { execFileSync } from "node:child_process";

/** Files changed between BASE_SHA and HEAD_SHA (pull requests) or in the last commit. */
export function changedFiles() {
  const base = process.env.BASE_SHA;
  const head = process.env.HEAD_SHA ?? "HEAD";
  const range = base ? [`${base}...${head}`] : ["HEAD~1", "HEAD"];
  const out = execFileSync("git", ["diff", "--name-only", ...range], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

/** Labels on the pull request that triggered this run, from the GitHub event payload. */
export async function pullRequestLabels() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return [];
  const { readFile } = await import("node:fs/promises");
  const event = JSON.parse(await readFile(path, "utf8"));
  return (event.pull_request?.labels ?? []).map((l) => l.name);
}
