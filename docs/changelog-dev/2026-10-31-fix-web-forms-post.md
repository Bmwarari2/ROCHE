# Forms post before the page hydrates

Branch `fix/web-forms-post-before-hydration`.

## What changed

- Every web form handled in the browser (`onSubmit`) now says `method="post"`: 70 forms in 49
  files, from sign-in, the second factor and invitation acceptance to notes, incidents and
  break-glass reasons. Before, a form submitted before the page hydrated fell back to the HTML
  default, a GET, and put every field in the address: a password or a one-time code, or a care
  note, would reach the browser history and the server's request logs. A builder saw the demo
  password in the address while a journey signed in on a slow dev server.
- `apps/web/src/forms.test.ts`: parses every component and fails on a form handled in the browser
  without `method="post"` or a server action; table-driven cases for the checker itself. It fails
  on main before this change.

## Found, not fixed here

- None.

## Human actions logged

- None.

## Tests

- `forms.test.ts` 7 passed (1 failed before the fix); web unit tests 1050 passed; Biome and the web
  typecheck clean.
