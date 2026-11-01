import { SILO_STATUS_ID } from "./silo-status-id";

/**
 * A polite status region on the page, outside every form, so a step that succeeds is announced
 * even when its form is replaced (see `announceAndRefocus`).
 */
export function SiloStatus() {
  return <p id={SILO_STATUS_ID} role="status" className="sr-only" />;
}
