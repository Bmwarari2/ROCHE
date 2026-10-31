"use client";

import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

/**
 * A form tucked under its own control: a 44 px button that says whether it is open
 * (aria-expanded) with a chevron that turns, not a link's underline. The form is only put on the
 * page once opened, so hidden fields never sit in the tab order or the accessibility tree.
 */
export function StaffDisclosure({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-target cursor-pointer items-center gap-2 self-start bg-transparent p-0 text-left font-semibold text-text"
      >
        <ChevronRight
          size={18}
          strokeWidth={1.5}
          aria-hidden="true"
          className={open ? "rotate-90" : undefined}
        />
        <span>{label}</span>
      </button>
      <div id={id} hidden={!open} className="flex flex-col gap-3">
        {open ? children : null}
      </div>
    </div>
  );
}
