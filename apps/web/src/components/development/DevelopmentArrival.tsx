"use client";

import { useSearchParams } from "next/navigation";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { developmentArrivalKey as known } from "@/lib/development";
import { t } from "@/lib/i18n";

/**
 * What a training, competence, supervision or Care Certificate form did, said when its page opens again at
 * `?done=<key>&at=…`: a status that is read out, with focus on the page's heading (RecordedArrival). Only a known catalogue key is
 * said, so the address can never put words of its own on the page.
 */
export function DevelopmentArrival() {
  const done = useSearchParams().get("done");
  if (!done || !known(done)) return null;
  return <RecordedArrival message={t(done)} param="done" />;
}
