#!/usr/bin/env node
// Every relative link in docs/ and the root markdown files must resolve to a file in the repository.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const roots = ["docs", "CLAUDE.md", "README.md", "apps", "packages", "infra"];
const files = [];
function walk(path) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    if (/node_modules|\.next|dist|storybook-static|\.expo|\.terraform/.test(path)) return;
    for (const entry of readdirSync(path)) walk(join(path, entry));
  } else if (path.endsWith(".md")) {
    files.push(path);
  }
}
for (const root of roots) walk(root);

const broken = [];
for (const file of files) {
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(<?https?:|mailto:|#)/.test(target)) continue;
    const path = target.split("#")[0];
    if (!path) continue;
    if (!existsSync(resolve(dirname(file), decodeURIComponent(path))))
      broken.push(`${file}: ${target}`);
  }
}
if (broken.length > 0) {
  console.error(`Broken relative links:\n${broken.map((b) => `  ${b}`).join("\n")}`);
  process.exit(1);
}
console.log(`Markdown links: ${files.length} files checked.`);
