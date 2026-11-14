/**
 * The spoken save confirmation, said once the screen the form returns to is on screen (HZ-001;
 * accessibility reviews M1 and, 14/11/2026, H1).
 *
 * Announcing straight after `router.back()` speaks while the native stack is still popping: when the
 * pop ends, the platform reads the newly focused element and cuts the confirmation off. So the form
 * leaves the words here, and the stack the form belongs to (`people/_layout.tsx`,
 * `round/_layout.tsx`) calls `announceReturned` when the screen it returns to has appeared
 * (`transitionEnd`, not closing). A timer says them anyway if no such event comes.
 *
 * `queue: true` makes VoiceOver wait for what it is already saying; Android ignores the option.
 * On iOS, if VoiceOver reports the confirmation was cut off, it is said once more.
 *
 * The words name a person, so nothing is said while the app is locked: the vault reports whether
 * it is unlocked (`setAnnouncementsAllowed`), and a confirmation still waiting is dropped when it
 * locks or the app leaves the foreground, since the fallback timer can fire on the way back.
 */
import { AccessibilityInfo, AppState, Platform } from "react-native";

/** Said anyway after this long if the stack sends no transition event. */
export const ANNOUNCE_FALLBACK_MS = 1000;

/** How long to listen for VoiceOver's report on the announcement before giving up. */
const FINISHED_LISTEN_MS = 15_000;

interface Pending {
  readonly words: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly appState: { remove(): void };
}

let pending: Pending | null = null;
let allowed = false;

function take(): Pending | null {
  const current = pending;
  pending = null;
  if (current) {
    clearTimeout(current.timer);
    current.appState.remove();
  }
  return current;
}

/**
 * Whether a confirmation may be said: true only while the vault is unlocked. Called by the vault
 * whenever its state changes; false also drops a confirmation still waiting.
 */
export function setAnnouncementsAllowed(unlocked: boolean): void {
  allowed = unlocked;
  if (!unlocked) take();
}

/** Leaves the confirmation to be said when the screen returned to appears; replaces one waiting. */
export function announceAfterReturn(words: string): void {
  take();
  if (!allowed) return;
  const timer = setTimeout(() => announceReturned(), ANNOUNCE_FALLBACK_MS);
  const appState = AppState.addEventListener("change", (next: string) => {
    if (next !== "active") take();
  });
  pending = { words, timer, appState };
}

/** Says the waiting confirmation, once. Called by the stack when a screen has appeared. */
export function announceReturned(): void {
  const current = take();
  if (current && allowed) speak(current.words);
}

function speak(words: string): void {
  AccessibilityInfo.announceForAccessibilityWithOptions(words, { queue: true });
  if (Platform.OS !== "ios") return;
  let retried = false;
  const subscription = AccessibilityInfo.addEventListener(
    "announcementFinished",
    (event: { announcement: string; success: boolean }) => {
      if (event.announcement !== words) return;
      if (!event.success && !retried) {
        retried = true;
        AccessibilityInfo.announceForAccessibilityWithOptions(words, { queue: true });
        return;
      }
      stop();
    },
  );
  const timer = setTimeout(() => subscription.remove(), FINISHED_LISTEN_MS);
  function stop() {
    clearTimeout(timer);
    subscription.remove();
  }
}

/** Tests only: forgets a waiting confirmation and the vault's last state. */
export function resetPendingAnnouncement(): void {
  take();
  allowed = false;
}
