import { render, screen, within } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { describe, expect, it } from "vitest";
import { TabNav } from "./TabNav";

const items = [
  { href: "/people/1", label: "Overview" },
  { href: "/people/1/notes", label: "Notes", current: true },
  { href: "/people/1/charts", label: "Charts" },
];

describe("TabNav", () => {
  it("is a named navigation landmark of links, not an ARIA tablist", () => {
    render(<TabNav label="Record sections" items={items} />);
    const nav = screen.getByRole("navigation", { name: "Record sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Overview", "Notes", "Charts"]);
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("marks only the current page with aria-current", () => {
    render(<TabNav label="Record sections" items={items} />);
    expect(screen.getByRole("link", { name: "Notes" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Charts" })).toHaveAttribute(
      "href",
      "/people/1/charts",
    );
  });

  it("renders links through the app's link component", () => {
    function AppLink(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
      return <a data-app-link="yes" {...props} />;
    }
    render(<TabNav label="Record sections" items={items} linkComponent={AppLink} />);
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("data-app-link", "yes");
    }
  });
});
