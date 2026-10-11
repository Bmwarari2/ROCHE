import type { AnchorHTMLAttributes, ComponentType, Ref } from "react";

/**
 * A component that renders an anchor, such as Next.js `Link`. Components that render navigation
 * accept one so apps get client-side routing; the default is a plain `a` element.
 */
export type LinkComponent = ComponentType<
  AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; ref?: Ref<HTMLAnchorElement> }
>;
