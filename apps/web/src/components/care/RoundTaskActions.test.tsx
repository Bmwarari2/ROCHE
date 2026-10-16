// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEditing, startEditing, stopEditing } from "@/lib/round-editing";

const router = { push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const moveRoundTask = vi.fn();
vi.mock("@/app/actions/round", () => ({
  moveRoundTask: (...args: unknown[]) => moveRoundTask(...args),
}));

const { RoundTaskActions } = await import("./RoundTaskActions");
const { RoundRefresh } = await import("./RoundRefresh");

const LOCATION = "0194d000-0000-7000-8000-000000000101";
const TASK = "0194d000-0000-7000-8000-00000000d001";
const TITLE = "Turn";
const NAME = "Ada Example";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("main");
  document.body.replaceChildren(host);
  root = createRoot(host);
  router.push.mockReset();
  router.refresh.mockReset();
  moveRoundTask.mockReset();
});

afterEach(() => act(() => root.unmount()));

const actions = { start: false, done: true, recordFirst: false, skip: true };

const render = (version: number) =>
  act(() =>
    root.render(
      <RoundTaskActions
        locationId={LOCATION}
        taskId={TASK}
        version={version}
        title={TITLE}
        actions={actions}
        recordHref={null}
        returnTo={`/round/${LOCATION}`}
        name={NAME}
      />,
    ),
  );

const button = (name: string) =>
  [...host.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === name,
  );

const type = (text: string) =>
  act(() => {
    const input = host.querySelector<HTMLInputElement>('input[name="reason"]');
    if (input) input.value = text;
  });

const submit = () =>
  act(async () => {
    host.querySelector("form")?.requestSubmit();
  });

describe("marking a round task not done", () => {
  it("hazard HZ-003 never sends the reason against a version the carer did not see, and says the task changed", async () => {
    moveRoundTask.mockResolvedValue({ ok: true, data: {} });
    await render(1);
    await act(async () => button(`Not done: ${TITLE} for ${NAME}`)?.click());
    await type("Asleep, will try at 03:00");
    // A re-read swaps in a new version while the reason is typed.
    await render(2);
    await submit();
    expect(moveRoundTask).not.toHaveBeenCalled();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      "This task changed while you were typing. Check it before saving.",
    );
    // The typed reason is kept; sent again once the carer has been told, against the new version.
    expect(host.querySelector<HTMLInputElement>('input[name="reason"]')?.value).toBe(
      "Asleep, will try at 03:00",
    );
    await submit();
    expect(moveRoundTask).toHaveBeenCalledWith(LOCATION, TASK, {
      to: "skipped",
      version: 2,
      reason: "Asleep, will try at 03:00",
    });
  });

  it("hazard HZ-003 holds the round's re-read while a reason is typed, and reads again once it is closed", async () => {
    vi.useFakeTimers();
    try {
      await act(() => root.render(<RoundRefresh inMs={1_000} />));
      startEditing(TASK);
      expect(isEditing()).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(router.refresh).not.toHaveBeenCalled();
      await act(async () => stopEditing(TASK));
      expect(router.refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the reason form as being typed while it is open", async () => {
    await render(1);
    expect(isEditing()).toBe(false);
    await act(async () => button(`Not done: ${TITLE} for ${NAME}`)?.click());
    expect(isEditing()).toBe(true);
    await act(async () => button("Cancel")?.click());
    expect(isEditing()).toBe(false);
  });
});
