// @vitest-environment jsdom
import axe from "axe-core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The link to the HR platform's linked states (slice 90; HZ-133, HZ-140), which the browser
 * journeys cannot reach (no link can be connected there): each section and form rendered with the
 * data a linked organisation has, in the light and the dark theme, and checked with axe-core
 * (WCAG 2.2 AA tags; contrast is left to the real browser and the token ratios). Invented data.
 */

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const actions = {
  testHrLink: vi.fn(),
  syncHrLink: vi.fn(),
  disconnectHrLink: vi.fn(),
  releaseHrCopies: vi.fn(),
  changePayRoute: vi.fn(),
};
vi.mock("@/app/actions/hr-link", () => ({
  changeHrLinkSettings: vi.fn(),
  changePayCodes: vi.fn(),
  changePayRoute: (...a: unknown[]) => actions.changePayRoute(...a),
  confirmHrMatch: vi.fn(),
  connectHrLink: vi.fn(),
  disconnectHrLink: (...a: unknown[]) => actions.disconnectHrLink(...a),
  mapHrLocation: vi.fn(),
  rejectHrMatch: vi.fn(),
  releaseHrCopies: (...a: unknown[]) => actions.releaseHrCopies(...a),
  syncHrLink: (...a: unknown[]) => actions.syncHrLink(...a),
  testHrLink: (...a: unknown[]) => actions.testHrLink(...a),
}));

const { DEFAULT_HR_OWNERS } = await import("@harbour/domain");
const { t } = await import("@/lib/i18n");
const forms = await import("./HrLinkForms");
const sections = await import("./HrLinkSections");
const { ManagedInHrPlatform } = await import("./ManagedInHrPlatform");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MANAGER = { manage: true, review: true, payCodes: true } as const;
const READER = { manage: false, review: false, payCodes: false } as const;
const STAFF = "0194d000-0000-7000-8000-00000000f001";

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("main");
  document.body.replaceChildren(host);
  root = createRoot(host);
  for (const f of [...Object.values(actions), ...Object.values(router)]) f.mockReset();
});

afterEach(() => act(() => root.unmount()));

const render = (node: ReactNode) =>
  act(async () => {
    root.render(
      <>
        <h1>{t("hrLink.title")}</h1>
        {node}
      </>,
    );
  });

async function violations(): Promise<string[]> {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
}

const linked = {
  connected: true,
  status: "connected",
  workspaceSlug: "sunrise-care",
  stalenessMinutes: 15,
  matchesToReview: 1,
  leaversNotEnded: 1,
  staleness: {
    stale: true,
    lastGoodSyncAt: "2026-11-06T22:05:00Z",
    lastErrorCode: "unavailable",
    failures: 3,
  },
};

const states: [string, () => ReactNode][] = [
  ["status and sync health", () => <sections.StatusSection link={linked} may={MANAGER} />],
  ["status for a reader", () => <sections.StatusSection link={linked} may={READER} />],
  [
    "the match review queue with a leaver",
    () => (
      <sections.MatchesSection
        items={[
          {
            id: "0194d000-0000-7000-8000-00000000e001",
            version: 1,
            employeeNumber: "E100",
            reason: "conflict",
            candidateStaffProfileId: STAFF,
            hrName: "Ada Example",
            hrWorkEmail: "ada@example.invalid",
            leavingOn: "2026-11-30",
          },
        ]}
        staffFor={() => [{ id: STAFF, label: "Ada Example, Care worker" }]}
      />
    ),
  ],
  [
    "deliveries",
    () => (
      <sections.DeliveriesSection
        items={[
          {
            id: "0194d000-0000-7000-8000-00000000d001",
            kind: "shift",
            state: "sent",
            attempts: 1,
            lastErrorCode: null,
            sentAt: "2026-11-06T21:00:00Z",
          },
          {
            id: "0194d000-0000-7000-8000-00000000d002",
            kind: "pay_units",
            state: "refused",
            attempts: 2,
            lastErrorCode: "refused",
            sentAt: null,
          },
        ]}
      />
    ),
  ],
  [
    "pay with a change waiting, for a manager who approves pay",
    () => (
      <sections.PaySection
        pay={{
          route: "harbour_export",
          pendingRoute: "thapsus_hr",
          pendingFrom: "2026-11-30",
          codes: { hours: "BASIC", sleep_in: "SLEEP" },
        }}
        version={4}
        may={MANAGER}
      />
    ),
  ],
  [
    "pay for a reader",
    () => (
      <sections.PaySection
        pay={{ route: "thapsus_hr", pendingRoute: null, pendingFrom: null, codes: { hours: "B" } }}
        version={4}
        may={READER}
      />
    ),
  ],
  [
    "absence copies to release",
    () => (
      <sections.ReleaseSection
        connected
        asked
        needsStepUp={false}
        held={{
          mode: "drift",
          error: null,
          items: [
            {
              hrId: "abs_1",
              kind: "annual_leave",
              startsOn: "2026-11-20",
              endsOn: "2026-11-24",
              name: "Ada Example",
            },
            { hrId: "abs_2", kind: "sickness", startsOn: "2026-11-02", endsOn: null, name: null },
          ],
        }}
      />
    ),
  ],
  [
    "absence copies needing a step-up",
    () => <sections.ReleaseSection connected={false} asked={false} needsStepUp held={null} />,
  ],
  [
    "absence copies that could not be read",
    () => (
      <sections.ReleaseSection
        connected
        asked
        needsStepUp={false}
        held={{ mode: "none", error: "rate_limited", items: [] }}
      />
    ),
  ],
  ["the connect form", () => <forms.ConnectForm />],
  [
    "owners and the limit",
    () => <forms.SettingsForm version={4} owners={DEFAULT_HR_OWNERS} stalenessMinutes={15} />,
  ],
  [
    "location mapping",
    () => (
      <forms.LocationMapForm
        locationId="0194d000-0000-7000-8000-000000000101"
        name="Example House"
        current="loc_main"
        options={[
          { id: "loc_main", name: "Main house" },
          { id: "loc_annex", name: "Annexe" },
        ]}
      />
    ),
  ],
  [
    "the managed in the HR platform label",
    () => (
      <p>
        <ManagedInHrPlatform detail="absence" /> <ManagedInHrPlatform detail="payRun" />
      </p>
    ),
  ],
];

describe("hazard HZ-133 the linked states are accessible in both themes", () => {
  for (const theme of ["light", "dark"] as const) {
    it.each(states)(`%s (${theme})`, async (_name, view) => {
      document.documentElement.dataset.theme = theme;
      await render(view());
      expect(await violations()).toEqual([]);
    });
  }

  it("dates are in time elements, leaving dates as information with a calendar, not overdue", async () => {
    await render(states[2]?.[1]());
    const leaving = [...host.querySelectorAll("time")].map((e) => e.getAttribute("datetime"));
    expect(leaving).toContain("2026-11-30");
    expect(host.textContent).toContain("Leaving date given");
    expect(host.querySelector(".hb-chip--overdue, [data-status='overdue']")).toBeNull();
    await render(states[6]?.[1]());
    const times = [...host.querySelectorAll("time")].map((e) => e.getAttribute("datetime"));
    expect(times).toEqual(["2026-11-20", "2026-11-24", "2026-11-02"]);
    expect(host.textContent).toContain("Ada Example");
    expect(host.textContent).toContain("A member of staff");
  });

  // HZ-133: no state names the other product (Thapsus-HR) in any spelling, in its text or in what
  // a screen reader reads from attributes. The product's own name (ADR-0127) is removed first.
  it.each(states)("%s never names the other product", async (_name, view) => {
    await render(view());
    const attributes = [...host.querySelectorAll("[aria-label],[title],[alt],[placeholder]")]
      .flatMap((e) =>
        ["aria-label", "title", "alt", "placeholder"].map((a) => e.getAttribute(a) ?? ""),
      )
      .join(" ");
    const read = `${host.textContent ?? ""} ${attributes}`.replaceAll(t("app.name"), "");
    expect(read).not.toMatch(/thapsus/i);
  });
});

describe("hazard HZ-133 the disconnect sheet", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`names the action and says the link can be made again (${theme})`, async () => {
      document.documentElement.dataset.theme = theme;
      await render(<forms.DisconnectForm />);
      await act(async () => {
        host.querySelector("button")?.click();
      });
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain("You can connect again later.");
      const buttons = [...(dialog?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
      expect(buttons).toContain("Disconnect from the HR platform");
      expect(await violations()).toEqual([]);
    });
  }
});

describe("checking and syncing keep focus on the pressed button (WCAG 2.4.3)", () => {
  it("stays focused while working and after, and says the result in the status", async () => {
    let finish: (v: unknown) => void = () => undefined;
    actions.syncHrLink.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render(<forms.CheckButtons />);
    const sync = [...host.querySelectorAll("button")].find((b) => b.textContent === "Sync now");
    sync?.focus();
    await act(async () => {
      sync?.click();
    });
    expect(sync?.hasAttribute("disabled")).toBe(false);
    expect(sync?.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(sync);
    await act(async () => {
      sync?.click();
    });
    expect(actions.syncHrLink).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({
        ok: true,
        data: { linked: 2, review: 1, failed: 0, error: null, absences: null, deliveries: null },
      });
    });
    expect(document.activeElement).toBe(sync);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Sync finished. 2 employees linked, 1 to review.",
    );
  });

  it("says a failed check in whole sentences, never a code", async () => {
    actions.testHrLink.mockResolvedValue({ ok: true, data: { ok: false, code: "not_uk_region" } });
    await render(<forms.CheckButtons />);
    await act(async () => {
      host.querySelector("button")?.click();
    });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "The link does not work, and nothing was sent. The HR platform workspace is not in the UK.",
    );
  });
});

describe("hazard HZ-140 the pay route form keeps what was typed across a step-up", () => {
  it("keeps the route and date on this device, and puts them back on return", async () => {
    window.sessionStorage.clear();
    actions.changePayRoute.mockResolvedValue({
      ok: false,
      code: "step_up_required",
      message: "Confirm it is you",
    });
    await render(<forms.PayRouteForm version={4} current="harbour_export" />);
    const set = (name: string, value: string) => {
      const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (input) input.value = value;
    };
    set("from-day", "30");
    set("from-month", "11");
    set("from-year", "2026");
    await act(async () => {
      host.querySelector("form")?.requestSubmit();
    });
    expect(host.textContent).toContain("What you typed here is kept on this device");
    expect(JSON.parse(window.sessionStorage.getItem("harbour.hr-link.pay-route") ?? "{}")).toEqual({
      route: "thapsus_hr",
      from: "2026-11-30",
    });
    await act(() => root.unmount());
    root = createRoot(host);
    await render(<forms.PayRouteForm version={4} current="harbour_export" />);
    expect(host.querySelector<HTMLInputElement>('input[name="from-day"]')?.value).toBe("30");
    expect(window.sessionStorage.getItem("harbour.hr-link.pay-route")).toBeNull();
  });
});
