// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const acknowledgeHandover = vi.fn();
vi.mock("@/app/actions/handover", () => ({
  acknowledgeHandover: (...args: unknown[]) => acknowledgeHandover(...args),
  addHandoverNote: vi.fn(),
  compileHandover: vi.fn(),
}));

const { AcknowledgeHandover } = await import("./HandoverActions");

const LOCATION = "0194d000-0000-7000-8000-000000000101";
const HANDOVER = "0194d000-0000-7000-8000-00000000c001";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("main");
  document.body.replaceChildren(host);
  root = createRoot(host);
  router.push.mockReset();
  router.refresh.mockReset();
  acknowledgeHandover.mockReset();
});

afterEach(() => act(() => root.unmount()));

const render = (seenToken: string) =>
  act(() =>
    root.render(
      <AcknowledgeHandover locationId={LOCATION} handoverId={HANDOVER} seenToken={seenToken} />,
    ),
  );

const press = () =>
  act(async () => {
    host.querySelector("button")?.click();
  });

describe("acknowledging a handover as shown", () => {
  it("hazard HZ-018 sends the token of the handover as shown, with a new id when the token changes", async () => {
    acknowledgeHandover.mockResolvedValue({ ok: true, data: { id: HANDOVER } });
    await render("token-a");
    await press();
    const [first] = acknowledgeHandover.mock.calls;
    expect(first?.[0]).toBe(LOCATION);
    expect(first?.[1]).toBe(HANDOVER);
    expect(first?.[2].seenToken).toBe("token-a");
    expect(router.push.mock.calls[0]?.[0]).toMatch(
      new RegExp(`^/handover/${LOCATION}/${HANDOVER}\\?done=acknowledged&at=\\d+$`),
    );
    await render("token-b");
    await press();
    const second = acknowledgeHandover.mock.calls[1];
    expect(second?.[2].seenToken).toBe("token-b");
    expect(second?.[2].id).not.toBe(first?.[2].id);
  });

  it("hazard HZ-018 reloads with the new items and says so when the handover changed since it was opened", async () => {
    acknowledgeHandover.mockResolvedValue({
      ok: false,
      code: "handover_changed",
      message:
        "Items were added since you opened the handover. They are shown now: read them, then acknowledge it.",
    });
    await render("token-a");
    await press();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Items were added since you opened the handover.");
    expect(document.activeElement).toBe(alert);
  });
});
