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
 * The words name a person, so nothing is said while the app is locked.
 */
import { AccessibilityInfo, Platform } from "react-native";

/** Said anyway after this long if the stack sends no transition event. */
export const ANNOUNCE_FALLBACK_MS = 1000;

/** How long to listen for VoiceOver's report on the announcement before giving up. */
const FINISHED_LISTEN_MS = 15_000;

interface Pending {
  readonly words: string;
  readonly canSpeak: () => boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

let pending: Pending | null = null;

/**
 * Leaves the confirmation to be said when the screen returned to appears. A newer one replaces
 * one not yet said. `canSpeak` is asked at that moment (false while the app is locked).
 */
export function announceAfterReturn(words: string, canSpeak: () => boolean): void {
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => announceReturned(), ANNOUNCE_FALLBACK_MS);
  pending = { words, canSpeak, timer };
}

/**
 * Says the waiting confirmation, once. Called by the stack when a screen has appeared, with whether
 * the app is unlocked now; the fallback timer asks the form's own check instead.
 */
export function announceReturned(unlocked?: boolean): void {
  const current = pending;
  if (!current) return;
  pending = null;
  clearTimeout(current.timer);
  if (!(unlocked ?? current.canSpeak())) return;
  speak(current.words);
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

/** Tests only: forgets a waiting confirmation. */
export function resetPendingAnnouncement(): void {
  if (pending) clearTimeout(pending.timer);
  pending = null;
}
