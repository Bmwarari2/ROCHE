import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILTIN_ROLES, PERMISSIONS, type Permission } from "../src/index";

// Writes docs/specs/permissions.md from the code, so the documented matrix can never drift from it.
const roles = BUILTIN_ROLES;
const header = `| Permission | Step-up | Care record | ${roles.map((r) => r.key).join(" | ")} |`;
const divider = `| --- | --- | --- | ${roles.map(() => "---").join(" | ")} |`;
const rows = (Object.keys(PERMISSIONS) as Permission[]).map((p) => {
  const def = PERMISSIONS[p] as { description: string; stepUp?: boolean; careRecord?: boolean };
  const cells = roles.map((r) => (r.permissions.includes(p) ? "yes" : ""));
  return `| \`${p}\` | ${def.stepUp ? "yes" : ""} | ${def.careRecord ? "yes" : ""} | ${cells.join(" | ")} |`;
});
const scopes = roles.map(
  (r) =>
    `| \`${r.key}\` | ${r.name} | ${r.scopeKind} | ${r.requiresExpiry ? "yes" : ""} | ${r.description} |`,
);

const doc = `# Permission matrix

Generated from \`packages/domain/src/platform/permissions.ts\` and \`roles.ts\` by
\`pnpm --filter @harbour/domain permissions:doc\`. Do not edit by hand. Master prompt section 4.

Permissions are named \`module.resource.action\`. **Step-up** permissions need a sign-in within the
last 10 minutes (section 5.3). **Care record** permissions need MFA (TOTP or a passkey). Roles are
per-tenant copies of these built-in roles; tenants may rename or clone them.

## Built-in roles and scope

| Key | Name | Scope | Expiry required | Description |
| --- | --- | --- | --- | --- |
${scopes.join("\n")}

Scope decides whom a role may act on, enforced again by Postgres row-level security (ADR-0002):
\`tenant\` everyone, \`location\` people at the assigned locations, \`assigned\` and \`self\` assigned
people only (plus break-glass), \`none\` no person records.

## Permissions by role

${header}
${divider}
${rows.join("\n")}
`;

const target = fileURLToPath(new URL("../../../docs/specs/permissions.md", import.meta.url));
writeFileSync(target, doc);
console.log(`Wrote ${target}`);
