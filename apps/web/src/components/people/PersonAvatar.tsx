"use client";

import { useState } from "react";

export interface PersonAvatarProps {
  readonly personId: string;
  readonly initials: string;
  readonly hasPhoto: boolean;
  /** Alternative text for the photo; empty when the name is shown beside it. */
  readonly alt: string;
  readonly size?: "small" | "large";
}

/**
 * The person's photo (it helps prevent wrong-person selection), or their initials when there is
 * no photo or it cannot be loaded.
 */
export function PersonAvatar({
  personId,
  initials,
  hasPhoto,
  alt,
  size = "small",
}: PersonAvatarProps) {
  const [failed, setFailed] = useState(false);
  const dimension = size === "large" ? 72 : 40;
  const box = size === "large" ? "h-[72px] w-[72px] text-intro" : "h-10 w-10 text-callout";
  if (hasPhoto && !failed) {
    return (
      // biome-ignore lint/performance/noImgElement: next/image is not used for authenticated, per-person photos served through our own route.
      <img
        src={`/people/${personId}/photo`}
        alt={alt}
        width={dimension}
        height={dimension}
        className={`${box} shrink-0 rounded-full object-cover`}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${box} inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-bg-secondary font-semibold text-text-secondary`}
    >
      {initials}
    </span>
  );
}
