---
name: new-module
description: Scaffold a Harbour bounded context or feature slice end to end - spec, schema with RLS, domain rules with table-driven tests, API routes with OpenAPI, web and mobile UI, audit events, hazard log and data-protection updates. Use when starting any feature-register row.
---

# New module or feature slice

Follow the order in master prompt section 19 ("Order of work inside a phase"). Do every step; the
definition of done (section 19) is the checklist.

1. **Pick the row** in `docs/specs/feature-register.md` and mark it `partial`.
2. **Spec first**: create or update `docs/specs/<context>.md` with purpose, the section 9-17 feature
   table rows covered, acceptance criteria, permission matrix (`module.resource.action` names, add new
   ones to `packages/domain/src/platform/permissions.ts` and to built-in roles), retention class,
   offline behaviour (section 17.1) and the hazards touched.
3. **Domain rules** in `packages/domain/src/<context>/`: pure functions, no I/O. Write table-driven
   tests first. Statutory figures come from the rate table: add rows to `docs/specs/rates.md`, never
   literals. Keep coverage at or above 90%.
4. **Schema**: tables in `packages/db/src/schema/<context>.ts` using `id()`, `tenantId()`,
   `mutableColumns()` or `eventColumns()`. Composite `(tenant_id, id)` foreign keys to parents. Then
   use the `add-migration` skill. Append-only tables: add to the append-only trigger list and revoke
   UPDATE in the security migration. Person data: add the `person_child_scope` restrictive policy.
5. **API**: routes in `apps/api/src/routes/<context>.ts` with `createRoute`, schemas in
   `packages/contracts`, `requirePermission` for every route, `withTenant` for every query,
   `auditInTx` for every view of a care record and every change, `publish` for domain events.
   Regenerate `apps/api/openapi.json` and the typed client.
6. **Tests through the API** in `apps/api/test/`: permission refusals, cross-tenant 404s, scope.
7. **Web UI** in `apps/web` with `@harbour/ui` components; Playwright journey with axe.
8. **Mobile** where section 17.1 needs it offline: add the table to the sync streams and the client
   schema, extend `packages/sync/test/streams.test.ts`, Maestro flow.
9. **Documents in the same PR**: hazard log (label `clinical`), records of processing and
   data-standards (label `data-protection`), user guide section, release note.
10. Mark the register row `done` only when spec, code, tests and user docs are all linked.
