"use client";

import { useEffect } from "react";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";

/**
 * Says what was just done on a template page and takes focus there (ArrivalNotice), then takes
 * `done` and `at` off the address, as RecordedArrival does, so reloading or sharing the page does
 * not say it again. The page keys this on `at`, so each save is a new arrival.
 */
export function TemplateArrival({ message }: { readonly message: string }) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("done") || url.searchParams.has("at")) {
      url.searchParams.delete("done");
      url.searchParams.delete("at");
      window.history.replaceState(window.history.state, "", url);
    }
  }, []);
  return <ArrivalNotice>{message}</ArrivalNotice>;
}
