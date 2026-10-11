import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Button } from "../Button/Button";
import { TextField } from "../TextField/TextField";
import { Sheet } from "./Sheet";

function SheetWithTrigger() {
  return (
    <Sheet
      title="Edit team member"
      description="Changes apply from the next shift."
      trigger={<Button variant="secondary">Edit Ben Sample</Button>}
      footer={<Button>Save</Button>}
    >
      <TextField label="Full name" defaultValue="Ben Sample" />
    </Sheet>
  );
}

function ControlledSheet() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Add a person</Button>
      <Sheet open={open} onOpenChange={setOpen} title="Add a person">
        <TextField label="Full name" />
      </Sheet>
    </>
  );
}

describe("Sheet", () => {
  it("opens as a modal dialog named by its large title", async () => {
    const user = userEvent.setup();
    render(<SheetWithTrigger />);
    await user.click(screen.getByRole("button", { name: "Edit Ben Sample" }));
    const dialog = screen.getByRole("dialog", { name: "Edit team member" });
    expect(dialog).toHaveAccessibleDescription("Changes apply from the next shift.");
    expect(screen.getByRole("heading", { name: "Edit team member" })).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes with Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<SheetWithTrigger />);
    const trigger = screen.getByRole("button", { name: "Edit Ben Sample" });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("traps focus inside while open", async () => {
    const user = userEvent.setup();
    render(<SheetWithTrigger />);
    await user.click(screen.getByRole("button", { name: "Edit Ben Sample" }));
    const dialog = screen.getByRole("dialog");
    for (let index = 0; index < 6; index += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("closes with the Close button", async () => {
    const user = userEvent.setup();
    render(<SheetWithTrigger />);
    const trigger = screen.getByRole("button", { name: "Edit Ben Sample" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("returns focus to the opener when controlled without a trigger", async () => {
    const user = userEvent.setup();
    render(<ControlledSheet />);
    const opener = screen.getByRole("button", { name: "Add a person" });
    await user.click(opener);
    expect(screen.getByRole("dialog", { name: "Add a person" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });
});
