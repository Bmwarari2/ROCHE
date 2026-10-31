"use client";

import type { MessageKey } from "@harbour/i18n";
import enGB from "@harbour/i18n/messages/en-GB.json";
import { useSearchParams } from "next/navigation";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { t } from "@/lib/i18n";

/** The keys a development form may name as done: its own catalogue entries, nothing else. */
const known = (key: string): key is MessageKey =>
  /^development\.[A-Za-z0-9_.]+$/.test(key) && key in enGB;

/**
 * What a training, competence or supervision form did, said when its page opens again at
 * `?done=<key>&at=…`: a status that is read out, with focus on the page's heading (RecordedArrival). Only a known catalogue key is
 * said, so the address can never put words of its own on the page.
 */
export function DevelopmentArrival() {
  const done = useSearchParams().get("done");
  if (!done || !known(done)) return null;
  return <RecordedArrival message={t(done)} param="done" />;
}
