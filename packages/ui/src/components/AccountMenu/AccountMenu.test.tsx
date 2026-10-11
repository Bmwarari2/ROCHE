import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";
import { AccountMenu, type AccountMenuItem } from "./AccountMenu";

function renderMenu(overrides: Partial<Parameters<typeof AccountMenu>[0]> = {}) {
  const onSignOut = vi.fn();
  const items: AccountMenuItem[] = [
    { id: "security", label: "Sign-in and security", href: "/settings/security" },
    { id: "sign-out", label: "Sign out", onSelect: onSignOut },
  ];
  const result = render(
    <AccountMenu
      userName="Ben Sample"
      userDetail="ben.sample@example.invalid"
      organisationName="Harbour Example Care"
      locationName="Rowan House"
      items={items}
      {...overrides}
    />,
  );
  return { ...result, onSignOut };
}

describe("AccountMenu", () => {
  it("is a menu button named for the signed-in person, with their name beside the icon", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Your account: Ben Sample" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(within(trigger).getByText("Ben Sample")).toBeInTheDocument();
    expect(trigger.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("opens from the keyboard and shows who, where and the items", async () => {
    const user = userEvent.setup();
    renderMenu();
    const trigger = screen.getByRole("button", { name: /^Your account/ });
    trigger.focus();
    await user.keyboard("{Enter}");

    const menu = await screen.findByRole("menu");
    expect(menu).toHaveAccessibleName("Your account: Ben Sample");
    expect(within(menu).getByText("ben.sample@example.invalid")).toBeInTheDocument();
    expect(within(menu).getByText("Harbour Example Care").parentElement).toHaveTextContent(
      "Organisation: Harbour Example Care",
    );
    expect(within(menu).getByText("Rowan House").parentElement).toHaveTextContent(
      "Location: Rowan House",
    );

    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Sign-in and security", "Sign out"]);
    expect(items[0]).toHaveAttribute("href", "/settings/security");
    // Opening from the keyboard focuses the first item; the arrow keys move between items.
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(items[0]).toHaveFocus();
  });

  it("runs an action item and closes, returning focus to the button", async () => {
    const user = userEvent.setup();
    const { onSignOut } = renderMenu();
    const trigger = screen.getByRole("button", { name: /^Your account/ });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("stays open when the action prevents the default, and closes with Escape", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn((event: Event) => event.preventDefault());
    renderMenu({ items: [{ id: "sign-out", label: "Sign out", onSelect }] });
    await user.click(screen.getByRole("button", { name: /^Your account/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not run a disabled item", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderMenu({ items: [{ id: "sign-out", label: "Sign out", onSelect, disabled: true }] });
    await user.click(screen.getByRole("button", { name: /^Your account/ }));
    const item = await screen.findByRole("menuitem", { name: "Sign out" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    await user.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("uses the app's words and link component", async () => {
    const user = userEvent.setup();
    const LinkStub = ({
      href,
      ...rest
    }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
      <a href={href} data-router-link="true" {...rest} />
    );
    renderMenu({
      triggerLabel: "Eich cyfrif: Ben Sample",
      organisationLabel: "Sefydliad",
      locationLabel: "Lleoliad",
      linkComponent: LinkStub,
    });
    await user.click(screen.getByRole("button", { name: "Eich cyfrif: Ben Sample" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Rowan House").parentElement).toHaveTextContent(
      "Lleoliad: Rowan House",
    );
    expect(within(menu).getByRole("menuitem", { name: "Sign-in and security" })).toHaveAttribute(
      "data-router-link",
      "true",
    );
  });
});
