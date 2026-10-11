import type { HTMLAttributes, ReactNode, Ref } from "react";

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  level: HeadingLevel;
  children?: ReactNode;
  ref?: Ref<HTMLHeadingElement>;
}

/** Renders h1 to h6 so components can fit into the page's heading outline. */
export function Heading({ level, children, ...rest }: HeadingProps) {
  const Tag = `h${level}` as const;
  return <Tag {...rest}>{children}</Tag>;
}
