// @vitest-environment jsdom
import axe from "axe-core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The withdraw form for a Care mode phone (MOB-010; HZ-006, HZ-040), which the browser journey
 * cannot reach (the demo seed has no synced phone): the coded reason and the tick are both
 * required, a refusal for entries reported since the page opened asks to reload and tick again,
 * step-up is asked for, and success opens the page again with focus on its heading and the status
 * said. Checked with axe-core (WCAG 2.2 AA tags; contrast is left to the browser). Invented ids.
 */

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => search,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const withdrawDevice = vi.fn();
vi.mock("@/app/actions/care-devices", () => ({
  withdrawDevice: (...a: unknown[]) => withdrawDevice(...a),
}));

const { t } = await import("@/lib/i18n");
const { DeviceWithdrawForm } = await import("./DeviceWithdrawForm");
const { RecordedArrival } = await import("@/components/safety/RecordedArrival");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PHONE = "0199d000-0000-4000-8000-0000000babcd";
let root: Root;

beforeEach(() => {
  const host = document.createElement("main");
  document.body.replaceChildren(host);
  root = createRoot(host);
  search = new URLSearchParams();
  withdrawDevice.mockReset();
  for (const f of Object.values(router)) f.mockReset();
});

afterEach(() => act(() => root.unmount()));

const render = (node: ReactNode) =>
  act(async () => {
    root.render(
      <>
        <h1>{t("devices.name", { shortId: "ABCD" })}</h1>
        {node}
      </>,
    );
  });

async function violations(): Promise<string[]> {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map((v) => v.id);
}

const text = () => document.body.textContent ?? "";
const submit = () =>
  act(async () => {
    const button = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(t("devices.withdraw.submit")),
    );
    button?.click();
  });
const choose = (reason: string) =>
  act(async () => {
    (document.querySelector(`input[type="radio"][value="${reason}"]`) as HTMLInputElement).click();
  });
const tick = () =>
  act(async () => {
    (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
  });

describe("hazard HZ-006 hazard HZ-040 withdrawing a Care mode phone", () => {
  it("needs a coded reason and the tick, and sends nothing without them", async () => {
    await render(<DeviceWithdrawForm deviceId={PHONE} entriesWaiting={3} />);
    expect(text()).toContain("3 entries were waiting on it when it last reported");
    expect(document.querySelectorAll("input:checked")).toHaveLength(0);
    expect(await violations()).toEqual([]);
    await submit();
    expect(withdrawDevice).not.toHaveBeenCalled();
    expect(text()).toContain(t("devices.withdraw.reasonRequired"));
    expect(text()).toContain(t("devices.withdraw.confirmRequired"));
    expect(await violations()).toEqual([]);
    // A reason alone is not enough.
    await choose("lost_or_stolen");
    await submit();
    expect(withdrawDevice).not.toHaveBeenCalled();
  });

  it("sends the code and the confirmation, then opens the page again at done", async () => {
    withdrawDevice.mockResolvedValue({ ok: true, data: { replay: false } });
    await render(<DeviceWithdrawForm deviceId={PHONE} entriesWaiting={0} />);
    await choose("staff_left");
    await tick();
    await submit();
    expect(withdrawDevice).toHaveBeenCalledWith(PHONE, {
      reasonCode: "staff_left",
      confirmEntriesWaiting: true,
    });
    expect(router.replace).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^/settings/devices/${PHONE}\\?done=withdrawn&at=\\d+$`)),
    );
  });

  it("asks to reload and tick again when entries were reported since the page opened", async () => {
    const message = t("devices.withdraw.entriesArrived");
    withdrawDevice.mockResolvedValue({
      ok: false,
      code: "entries_waiting",
      message,
      fields: { confirm: message },
    });
    await render(<DeviceWithdrawForm deviceId={PHONE} entriesWaiting={0} />);
    await choose("lost_or_stolen");
    await tick();
    await submit();
    expect(router.replace).not.toHaveBeenCalled();
    expect(text()).toContain("Reload the page to see how many, then tick the box to confirm.");
    // The words are tied to the box.
    const box = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const described = (box.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(described).toContain(message);
    expect(await violations()).toEqual([]);
  });

  it("asks for the second sign-in step, coming back to the phone's page", async () => {
    withdrawDevice.mockResolvedValue({
      ok: false,
      code: "step_up_required",
      message: "Sign in again",
    });
    await render(<DeviceWithdrawForm deviceId={PHONE} entriesWaiting={0} />);
    await choose("replaced");
    await tick();
    await submit();
    expect(text()).toContain(t("devices.withdraw.stepUp"));
    const link = document.querySelector("a[href]") as HTMLAnchorElement;
    expect(decodeURIComponent(link.getAttribute("href") ?? "")).toContain(
      `/settings/devices/${PHONE}`,
    );
  });

  it("says the phone is withdrawn on arrival, with focus on the page's heading", async () => {
    search = new URLSearchParams({ done: "withdrawn", at: "1" });
    await render(
      <RecordedArrival message={t("devices.withdraw.done", { done: "withdrawn" })} param="done" />,
    );
    const status = document.querySelector('[role="status"]');
    expect(status?.textContent).toContain("The phone is withdrawn.");
    const heading = document.querySelector("h1");
    expect(document.activeElement).toBe(heading);
    expect(heading?.getAttribute("aria-describedby")).toBe(status?.querySelector("p")?.id);
    expect(await violations()).toEqual([]);
  });
});
