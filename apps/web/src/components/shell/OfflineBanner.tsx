"use client";

import { Banner } from "@harbour/ui";
import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * Shown when the browser loses its connection. The web app keeps nothing offline in Phase 0, so
 * the copy says that what is on screen may be out of date and that changes cannot be saved,
 * rather than the mobile app's "kept on this device" (hazard: stale data shown as current).
 */
export function OfflineBanner() {
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  if (online) return null;
  return (
    <Banner
      variant="offline"
      className="mb-6"
      description="Harbour cannot reach the server. What you see may be out of date, and changes cannot be saved until you are back online."
    />
  );
}
