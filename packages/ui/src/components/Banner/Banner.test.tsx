import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Banner } from "./Banner";

describe("Banner", () => {
  it("announces offline and syncing politely", () => {
    const { rerender } = render(<Banner variant="offline" />);
    expect(screen.getByRole("status")).toHaveTextContent("You are offline");
    rerender(<Banner variant="syncing" />);
    expect(screen.getByRole("status")).toHaveTextContent("Sending your changes");
  });

  it("uses an alert for a failed sync and offers a retry", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<Banner variant="syncFailed" onRetry={onRetry} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Your changes have not been sent yet");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("uses an alert for stale data and shows when it was last updated", () => {
    render(<Banner variant="stale" detail="Last updated 03/10/2026 09:15" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("This information may be out of date");
    expect(alert).toHaveTextContent("Last updated 03/10/2026 09:15");
  });
});
