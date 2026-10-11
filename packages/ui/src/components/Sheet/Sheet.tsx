"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { type ReactElement, type ReactNode, useRef } from "react";
import { cx } from "../../lib/cx";
import { iconProps } from "../../lib/icon";
import { IconButton } from "../Button/Button";

export interface SheetProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * The element that opens the sheet, usually a `Button`. Focus returns to it when the sheet
   * closes. Without a trigger, focus returns to whatever was focused when the sheet opened.
   */
  trigger?: ReactElement;
  /** Large title at the top of the sheet; it names the dialog. */
  title: ReactNode;
  /** Optional line under the title; it describes the dialog. */
  description?: ReactNode;
  children?: ReactNode;
  /** Actions such as Cancel and Save, pinned to the foot of the sheet. */
  footer?: ReactNode;
  closeLabel?: string;
  /** "large" is wider, for forms with two columns. */
  size?: "regular" | "large";
  className?: string;
}

/**
 * A modal sheet with a large title. Focus is trapped inside while it is open, Escape closes it and
 * focus returns to the control that opened it.
 */
export function Sheet({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  closeLabel = "Close",
  size = "regular",
  className,
}: SheetProps) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const describedBy = description != null ? {} : { "aria-describedby": undefined };

  return (
    <Dialog.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="hb-sheet-overlay" />
        <Dialog.Content
          className={cx("hb-sheet", size === "large" && "hb-sheet--large", className)}
          {...describedBy}
          onOpenAutoFocus={() => {
            const active = document.activeElement;
            returnFocusRef.current = active instanceof HTMLElement ? active : null;
          }}
          onCloseAutoFocus={(event) => {
            const target = returnFocusRef.current;
            if (!trigger && target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          <div className="hb-sheet__header">
            <div className="hb-sheet__heading">
              <Dialog.Title className="hb-sheet__title">{title}</Dialog.Title>
              {description != null ? (
                <Dialog.Description className="hb-sheet__description">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <IconButton
                label={closeLabel}
                icon={<X {...iconProps} size={20} />}
                className="hb-sheet__close"
              />
            </Dialog.Close>
          </div>
          <div className="hb-sheet__body">{children}</div>
          {footer != null ? <div className="hb-sheet__footer">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Closes the surrounding sheet when activated; wrap a Cancel or Done button in it. */
export const SheetClose = Dialog.Close;
