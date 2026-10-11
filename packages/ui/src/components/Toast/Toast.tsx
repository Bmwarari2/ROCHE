"use client";

import * as ToastPrimitive from "@radix-ui/react-toast";
import { CircleAlert, CircleCheck, Info, type LucideIcon, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { cx } from "../../lib/cx";
import { iconProps } from "../../lib/icon";

export type ToastVariant = "neutral" | "success" | "error";

export interface ToastAction {
  /** Button text, for example "Undo". */
  label: string;
  /** How to do the same thing without the toast, read by screen readers. Required by Radix. */
  altText: string;
  onAction: () => void;
}

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** One action, typically "Undo" after a reversible change. */
  action?: ToastAction;
  /** Milliseconds before it hides. Toasts with an action stay longer by default. */
  duration?: number;
}

export interface ToastProps extends ToastOptions {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const variantIcons: Record<ToastVariant, LucideIcon> = {
  neutral: Info,
  success: CircleCheck,
  error: CircleAlert,
};

const ACTION_DURATION = 10000;

/** A single toast. Use inside `ToastProvider`, or call `useToast().toast()` instead. */
export function Toast({
  title,
  description,
  variant = "neutral",
  action,
  duration,
  open,
  defaultOpen,
  onOpenChange,
}: ToastProps) {
  const Icon = variantIcons[variant];
  return (
    <ToastPrimitive.Root
      className={cx("hb-toast", `hb-toast--${variant}`)}
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      duration={duration ?? (action ? ACTION_DURATION : undefined)}
      type={variant === "error" ? "foreground" : "background"}
    >
      <span className="hb-toast__icon" aria-hidden="true">
        <Icon {...iconProps} size={20} />
      </span>
      <div className="hb-toast__text">
        <ToastPrimitive.Title className="hb-toast__title">{title}</ToastPrimitive.Title>
        {description ? (
          <ToastPrimitive.Description className="hb-toast__description">
            {description}
          </ToastPrimitive.Description>
        ) : null}
      </div>
      {action ? (
        <ToastPrimitive.Action altText={action.altText} asChild>
          <button type="button" className="hb-toast__action" onClick={action.onAction}>
            {action.label}
          </button>
        </ToastPrimitive.Action>
      ) : null}
      <ToastPrimitive.Close className="hb-toast__close" aria-label="Dismiss notification">
        <X {...iconProps} size={16} />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}

interface ToastContextValue {
  /** Shows a toast and returns its id. */
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

interface QueuedToast extends ToastOptions {
  id: string;
  open: boolean;
}

export interface ToastProviderProps {
  children?: ReactNode;
  /** Default time on screen in milliseconds. */
  duration?: number;
  /** Accessible name of the notifications region; {hotkey} is replaced with the shortcut. */
  label?: string;
}

let toastCount = 0;

/**
 * Hosts toasts in the bottom corner. F8 moves focus to them. Toasts pause while hovered or
 * focused, so there is time to use an Undo action.
 */
export function ToastProvider({
  children,
  duration = 6000,
  label = "Notifications ({hotkey})",
}: ToastProviderProps) {
  const [toasts, setToasts] = useState<QueuedToast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((all) => all.map((item) => (item.id === id ? { ...item, open: false } : item)));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    toastCount += 1;
    const id = `toast-${toastCount}`;
    setToasts((all) => [...all, { ...options, id, open: true }]);
    return id;
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastPrimitive.Provider duration={duration} swipeDirection="right" label="Notification">
      <ToastContext.Provider value={value}>
        {children}
        {toasts.map(({ id, open, ...options }) => (
          <Toast
            key={id}
            {...options}
            open={open}
            onOpenChange={(isOpen) => {
              if (!isOpen) {
                dismiss(id);
                // Remove after the exit animation has had time to finish.
                setTimeout(() => setToasts((all) => all.filter((item) => item.id !== id)), 400);
              }
            }}
          />
        ))}
        <ToastPrimitive.Viewport className="hb-toast-viewport" label={label} />
      </ToastContext.Provider>
    </ToastPrimitive.Provider>
  );
}

/** Returns `toast()` and `dismiss()` for the nearest `ToastProvider`. */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used inside a ToastProvider.");
  }
  return context;
}
