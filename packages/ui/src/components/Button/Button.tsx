import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "../../lib/cx";
import { type ButtonStyleOptions, buttonClassName } from "./buttonStyles";

interface ButtonContentProps {
  variant: ButtonStyleOptions["variant"];
  icon?: ReactNode;
  children?: ReactNode;
}

function ButtonContent({ variant, icon, children }: ButtonContentProps) {
  return (
    <>
      {icon ? (
        <span className="hb-button__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="hb-button__label">{children}</span>
      {variant === "tertiary" ? (
        <span className="hb-button__chevron" aria-hidden="true">
          ›
        </span>
      ) : null}
    </>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyleOptions {
  /** Optional leading icon, for example `<Plus />`. It is decorative: the text names the button. */
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * The button primitive. Every variant is at least 44 px tall. The tertiary variant is link styled
 * and adds a trailing chevron ("Learn more ›"). It has no client-only behaviour, so server
 * components can render it (for example as a form's submit button).
 */
export function Button({
  variant = "primary",
  fullWidth,
  icon,
  className,
  type = "button",
  children,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClassName({ variant, fullWidth }, className)}
      {...rest}
    >
      <ButtonContent variant={variant} icon={icon}>
        {children}
      </ButtonContent>
    </button>
  );
}

export interface ButtonLinkProps
  extends AnchorHTMLAttributes<HTMLAnchorElement>,
    ButtonStyleOptions {
  href: string;
  icon?: ReactNode;
  ref?: Ref<HTMLAnchorElement>;
}

/** An anchor that looks like a button, for navigation such as "Add a person". */
export function ButtonLink({
  variant = "primary",
  fullWidth,
  icon,
  className,
  children,
  ref,
  ...rest
}: ButtonLinkProps) {
  return (
    <a ref={ref} className={buttonClassName({ variant, fullWidth }, className)} {...rest}>
      <ButtonContent variant={variant} icon={icon}>
        {children}
      </ButtonContent>
    </a>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** The accessible name, also shown as a native tooltip. Required because there is no visible text. */
  label: string;
  icon: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/** A 44 by 44 px button that shows only an icon, such as Close. */
export function IconButton({
  label,
  icon,
  className,
  type = "button",
  ref,
  ...rest
}: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx("hb-icon-button", className)}
      {...rest}
    >
      <span aria-hidden="true" className="hb-icon-button__icon">
        {icon}
      </span>
    </button>
  );
}
