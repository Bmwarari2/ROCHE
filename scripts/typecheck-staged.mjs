#!/usr/bin/env node
// Pre-commit: typecheck only the workspace packages that have staged changes, so unrelated work in
// progress elsewhere never blocks a commit. CI typechecks everything.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((f) => /\.(ts|tsx|mts)$/.test(f));
const dirs = new Set(
  staged.map((f) => f.split("/").slice(0, 2).join("/")).filter((d) => /^(apps|packages)\//.test(d)),
);
for (const dir of dirs) {
  const manifest = `${dir}/package.json`;
  if (!existsSync(manifest)) continue;
  const { name, scripts } = JSON.parse(readFileSync(manifest, "utf8"));
  if (!scripts?.typecheck) continue;
  console.log(`typecheck ${name}`);
  execFileSync("pnpm", ["--filter", name, "typecheck"], { stdio: "inherit" });
}
