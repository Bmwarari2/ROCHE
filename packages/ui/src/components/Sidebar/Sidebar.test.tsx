import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { House, Pill, Users } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarItem } from "./Sidebar";

const items: SidebarItem[] = [
  { id: "home", label: "Home", href: "#home", icon: <House /> },
  { id: "people", label: "People", href: "#people", icon: <Users /> },
  {
    id: "medicines",
    label: "Medicines",
    href: "#medicines",
    icon: <Pill />,
    badge: "2",
    badgeLabel: "2 overdue",
  },
];

describe("Sidebar", () => {
  it("is a named navigation landmark that marks the current page", () => {
    render(<Sidebar items={items} currentId="people" />);
    expect(screen.getByRole("navigation", { name: "Modules" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "People" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Medicines, 2 overdue" })).toBeInTheDocument();
  });

  it("collapses to icons, keeps labels as accessible names and keeps focus on the toggle", async () => {
    const user = userEvent.setup();
    const onCollapsedChange = vi.fn();
    render(<Sidebar items={items} currentId="people" onCollapsedChange={onCollapsedChange} />);
    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    toggle.focus();
    await user.keyboard("{Enter}");

    expect(onCollapsedChange).toHaveBeenCalledWith(true);
    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expand).toHaveFocus();
    expect(screen.getByRole("navigation")).toHaveAttribute("data-collapsed", "true");
    // Labels are hidden visually but still name the links.
    expect(screen.getByRole("link", { name: "People" })).toHaveAttribute("aria-current", "page");
  });
});
