# Biome reads the generated API client again

Branch `chore/biome-max-size`.

## What changed

- `biome.json`: `files.maxSize` is 4 MiB. The generated client
  (`packages/contracts/src/client/api-types.ts`) reached Biome's default 1 MiB limit once the Phase 2
  routes landed, so `generate:client` (which formats the file) exited with "no files were processed"
  and CI's API contract step failed on every branch adding routes. Several branches had worked
  around it in different ways (a 2 MiB setting, a `--files-max-size` flag in the script); with this
  on `main` they take `main`'s setting when they merge it.

## Human actions logged

- None.

## Tests

- `pnpm --filter @harbour/contracts generate:client` and `pnpm exec biome ci .` succeed.
