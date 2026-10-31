import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { House, Pill, Users } from "lucide-react";
import { describe, expect, it } from "vitest";
import type { SidebarItem } from "../Sidebar/Sidebar";
import { NavMenu } from "./NavMenu";

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

describe("NavMenu (the phone's navigation, MOB-013)", () => {
  it("is a button with a visible word that opens the modules with their labels", async () => {
    const user = userEvent.setup();
    render(<NavMenu items={items} currentId="people" />);
    const button = screen.getByRole("button", { name: "Menu" });
    expect(button).toHaveTextContent("Menu");
    await user.click(button);
    const dialog = screen.getByRole("dialog", { name: "Modules" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Modules" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "People" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Medicines, 2 overdue" })).toBeInTheDocument();
  });

  it("closes when a module is chosen, and on Escape returns focus to the button", async () => {
    const user = userEvent.setup();
    render(<NavMenu items={items} />);
    const button = screen.getByRole("button", { name: "Menu" });
    await user.click(button);
    await user.click(screen.getByRole("link", { name: "Home" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(button);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("takes its words from the app", async () => {
    const user = userEvent.setup();
    render(<NavMenu items={items} buttonLabel="Dewislen" label="Modiwlau" closeLabel="Cau" />);
    await user.click(screen.getByRole("button", { name: "Dewislen" }));
    expect(screen.getByRole("dialog", { name: "Modiwlau" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cau" })).toBeInTheDocument();
  });
});
