import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppBar } from "./AppBar";

const tenant = {
  label: "Organisation",
  options: [
    { id: "t-1", label: "Harbour Example Care" },
    { id: "t-2", label: "Sample Homecare" },
  ],
  value: "t-1",
};

describe("AppBar", () => {
  it("is the page banner with a skip link", () => {
    render(<AppBar tenant={{ ...tenant, onValueChange: vi.fn() }} />);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute(
      "href",
      "#main-content",
    );
  });

  it("switches organisation from an accessible menu", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<AppBar tenant={{ ...tenant, onValueChange }} />);
    const trigger = screen.getByRole("button", { name: "Organisation: Harbour Example Care" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");

    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Harbour Example Care" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await user.click(screen.getByRole("menuitemradio", { name: "Sample Homecare" }));
    expect(onValueChange).toHaveBeenCalledWith("t-2");
  });

  it("shows a single organisation as text, not a menu", () => {
    render(
      <AppBar
        tenant={{ ...tenant, options: tenant.options.slice(0, 1), onValueChange: vi.fn() }}
      />,
    );
    expect(screen.queryByRole("button", { name: /Organisation/ })).toBeNull();
    expect(screen.getByText("Harbour Example Care")).toBeInTheDocument();
  });
});
