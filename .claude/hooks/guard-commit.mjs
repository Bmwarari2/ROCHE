#!/usr/bin/env node
// Claude Code PreToolUse hook: refuses `git commit` when a .env file or a private key is staged, and
// refuses commits straight to main (master prompt section 7). Exit code 2 blocks the tool call.
import { execFileSync } from "node:child_process";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const command = JSON.parse(input || "{}")?.tool_input?.command ?? "";
if (!/\bgit\s+commit\b/.test(command)) process.exit(0);

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const staged = git("diff", "--cached", "--name-only").split("\n").filter(Boolean);
const secrets = staged.filter(
  (f) =>
    (/(^|\/)\.env(\.|$)/.test(f) && !f.endsWith(".env.example")) ||
    /\.(pem|key|p12|p8|jks)$/.test(f),
);
if (secrets.length > 0) {
  console.error(`Refusing to commit secrets or environment files: ${secrets.join(", ")}`);
  process.exit(2);
}
if (git("rev-parse", "--abbrev-ref", "HEAD") === "main") {
  console.error("Refusing to commit directly to main. Create a branch: feat/<area>-<slug>.");
  process.exit(2);
}
process.exit(0);
