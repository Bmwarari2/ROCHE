# Accessibility checklist

| Item | Value |
| --- | --- |
| Target | [WCAG 2.2](https://www.w3.org/TR/WCAG22/) Level AA on web and mobile (master prompt 5.4); WCAG applied to native apps by analogy |
| Also | [Accessible Information Standard](https://www.england.nhs.uk/long-read/accessible-information-standard-requirements-dapb1605/): every person's communication and information needs (SNOMED-coded) flag on every screen and print |
| Owner | Engineering lead; the `accessibility-reviewer` agent reviews PRs labelled `accessibility` and every UI PR |
| Product rules beyond AA | Targets 44 x 44 px (web) and 44 pt (iOS) / 48 dp (Android); status never by colour alone (icon plus word); plain English; British date and time formats |

## How verification works

| Method | Scope | Rule |
| --- | --- | --- |
| **axe (automated, CI)** | axe-core runs on every Storybook story (light and dark) and in every Playwright journey | Zero serious or critical violations; a failure blocks merge |
| **Native checks (automated, CI)** | `packages/ui-native` component tests assert an accessible label, role and state on every interactive component; Maestro flows select elements by accessibility label | A component without a label fails its test |
| **Manual pass (per release)** | Screen readers: NVDA with Firefox or Chrome on Windows, VoiceOver with Safari on macOS, VoiceOver on iOS, TalkBack on Android. Also keyboard only, 200% text zoom, 400% zoom (320 CSS px reflow), reduced motion, high-contrast theme, dynamic type at the largest size | Scripted journeys: sign in, find a person, write a note, chart, sync banner states; later phases add each module's journey. Results logged in the table at the end |

Automated tools find only part of WCAG failures, so a criterion marked "manual" is never signed off by CI alone.

## WCAG 2.2 A and AA criteria

"axe" means axe-core covers it in CI (at least partly); "manual" means the release pass covers it. Criteria marked "later" apply once the content type exists.

### Perceivable

| Criterion | Level | Where it matters in Harbour | Verified by |
| --- | --- | --- | --- |
| 1.1.1 Non-text content | A | Person photos (alt text is "Photo of {name}"; decorative icons hidden); body map has a text list of marks; charts have data tables | axe, manual |
| 1.2.1 to 1.2.5 Time-based media | A, AA | Training videos and e-learning (Phase 2) need captions, transcripts and audio description | manual (later, Phase 2) |
| 1.3.1 Info and relationships | A | Form labels, table headers on MAR and rotas, headings, landmarks | axe, manual |
| 1.3.2 Meaningful sequence | A | Reading order of the point-of-care header and cards | manual |
| 1.3.3 Sensory characteristics | A | Instructions never rely on shape, colour or position alone | manual |
| 1.3.4 Orientation | AA | Mobile and tablet work in portrait and landscape (MAR split view on tablets) | manual |
| 1.3.5 Identify input purpose | AA | `autocomplete` on sign-in, contact and staff profile fields | axe, manual |
| 1.4.1 Use of colour | A | Status, alerts, RAG ratings and sync banner use icon plus word | manual, design-system tests |
| 1.4.2 Audio control | A | Alarm sounds (missed visit, Phase 4) can be paused | manual (later) |
| 1.4.3 Contrast (minimum) | AA | Tokens meet 4.5:1 text and 3:1 large text; tenant accent auto-adjusted to at least 4.5:1 | axe, token tests |
| 1.4.4 Resize text | AA | 200% without loss; mobile dynamic type | manual |
| 1.4.5 Images of text | AA | None used; logos exempt | manual |
| 1.4.10 Reflow | AA | Web works at 320 CSS px wide without two-dimensional scrolling, except data tables such as the MAR grid | manual |
| 1.4.11 Non-text contrast | AA | Focus rings, input borders, icons, chart lines at 3:1 | axe (partial), manual |
| 1.4.12 Text spacing | AA | No clipping when spacing is increased | manual |
| 1.4.13 Content on hover or focus | AA | Tooltips dismissible, hoverable, persistent | manual |

### Operable

| Criterion | Level | Where it matters in Harbour | Verified by |
| --- | --- | --- | --- |
| 2.1.1 Keyboard | A | Every web function, including the rota builder, body map and drag-to-reorder alternatives | manual, Playwright keyboard journeys |
| 2.1.2 No keyboard trap | A | Dialogs, date pickers, rich-text editor | manual |
| 2.1.4 Character key shortcuts | A | Any single-key shortcuts can be turned off or remapped | manual |
| 2.2.1 Timing adjustable | A | Auto-lock and session timeouts. Entered data is kept as an encrypted draft and restored after unlock, so no work is lost. Personal devices warn 20 seconds before lock with a one-tap "Stay signed in". On shared devices the 30-second lock is a security control the tenant can adjust up to 2 minutes; see [kiosk.md](kiosk.md). Recorded as an accessibility decision for review | manual |
| 2.2.2 Pause, stop, hide | A | Auto-updating dashboards and banners can be paused; no auto-scrolling | manual |
| 2.3.1 Three flashes | A | No flashing content | manual |
| 2.4.1 Bypass blocks | A | Skip link to main content | axe, manual |
| 2.4.2 Page titled | A | Every route has a unique title (module, page, tenant) | axe |
| 2.4.3 Focus order | A | Logical order; focus moves into and back from dialogs | manual |
| 2.4.4 Link purpose (in context) | A | No bare "click here" | axe (partial), manual |
| 2.4.5 Multiple ways | AA | Navigation plus search | manual |
| 2.4.6 Headings and labels | AA | Descriptive headings and labels | manual |
| 2.4.7 Focus visible | AA | Visible focus ring from the design tokens | manual, Storybook |
| 2.4.11 Focus not obscured (minimum) | AA | Sticky headers, the sync banner and the point-of-care header never hide the focused element | manual |
| 2.5.1 Pointer gestures | A | Multi-point or path gestures (pinch on body map, swipe actions) have single-pointer alternatives | manual |
| 2.5.2 Pointer cancellation | A | Actions fire on release; destructive actions confirm | manual |
| 2.5.3 Label in name | A | Visible label text is contained in the accessible name (voice control) | axe (partial), manual |
| 2.5.4 Motion actuation | A | No shake-to-act | manual |
| 2.5.7 Dragging movements | AA | Rota builder, task ordering and body map placement have non-drag alternatives | manual |
| 2.5.8 Target size (minimum) | AA | Product rule of 44 x 44 px exceeds the 24 x 24 px minimum | axe (2.5.8 rule), manual |

### Understandable

| Criterion | Level | Where it matters in Harbour | Verified by |
| --- | --- | --- | --- |
| 3.1.1 Language of page | A | `lang="en-GB"`, or `cy` for Welsh tenants | axe |
| 3.1.2 Language of parts | AA | Mixed Welsh and English content (Active Offer) marked up | manual (later, Phase 7) |
| 3.2.1 On focus | A | No context change on focus | manual |
| 3.2.2 On input | A | Changing a select never navigates without warning | manual |
| 3.2.3 Consistent navigation | AA | Same navigation across modules | manual |
| 3.2.4 Consistent identification | AA | Same icons and labels for the same functions (design system) | manual |
| 3.2.6 Consistent help | A | Help and support link in the same place on every page | manual |
| 3.3.1 Error identification | A | Errors in text next to the field and in a summary | axe (partial), manual |
| 3.3.2 Labels or instructions | A | Units shown with every numeric clinical input (kg, mmHg, degrees Celsius) | axe, manual |
| 3.3.3 Error suggestion | AA | Error messages say how to fix | manual |
| 3.3.4 Error prevention (legal, financial, data) | AA | Review before submitting CQC notifications, invoices and signed records; corrections by referenced events | manual |
| 3.3.7 Redundant entry | A | Information entered earlier in a process is pre-filled (for example incident to notification form) | manual |
| 3.3.8 Accessible authentication (minimum) | AA | Passkeys need no cognitive test; password and one-time-code fields allow paste and password managers (`autocomplete="one-time-code"`). On shared devices a PIN is a memory test, so an alternative is needed; see [kiosk.md](kiosk.md) | manual |

### Robust

| Criterion | Level | Where it matters in Harbour | Verified by |
| --- | --- | --- | --- |
| 4.1.2 Name, role, value | A | Radix primitives on web; accessible label, role and state on every native control | axe, native component tests |
| 4.1.3 Status messages | AA | Sync banner state changes, save confirmations and "queued offline" messages are announced politely (`aria-live`, `accessibilityLiveRegion`) without moving focus | manual, component tests |

(4.1.1 Parsing was removed in WCAG 2.2.)

## Public sector tenants

Tenants that are public sector bodies may need to publish an accessibility statement under the Public Sector Bodies Accessibility Regulations 2018. Thapsus publishes an accessibility statement for Harbour, with known issues from the manual pass, that tenants can rely on `[human action: publish and keep current]`.

## Manual pass log

| Release | Date | Tester | Assistive technology and platforms | Journeys | Issues found (links) | Result |
| --- | --- | --- | --- | --- | --- | --- |
| v0.0 Phase 0 | `[date]` | `[name]` | | Sign in, tenant and location switcher, person list and header (web and mobile), sync banner states | | `[pending]` |
