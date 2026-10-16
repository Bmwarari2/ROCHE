import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { type ResidentFixture, residents } from "../../fixtures/residents";
import { DataTable, type DataTableColumn } from "./DataTable";

const columns: DataTableColumn<ResidentFixture>[] = [
  {
    id: "name",
    header: "Name",
    rowHeader: true,
    cell: (row) => row.name,
    sortValue: (row) => row.name,
  },
  {
    id: "room",
    header: "Room",
    align: "end",
    cell: (row) => row.room,
    sortValue: (row) => row.room,
  },
  { id: "keyWorker", header: "Key worker", cell: (row) => row.keyWorker },
];

function renderTable(props: Partial<Parameters<typeof DataTable<ResidentFixture>>[0]> = {}) {
  return render(
    <DataTable
      caption="People living at Rowan House"
      columns={columns}
      rows={residents}
      getRowId={(row) => row.id}
      {...props}
    />,
  );
}

function bodyRows(): HTMLElement[] {
  const table = screen.getByRole("table", { name: "People living at Rowan House" });
  const [, body] = within(table).getAllByRole("rowgroup");
  if (!body) throw new Error("No table body");
  return within(body).getAllByRole("row");
}

function names(): string[] {
  return bodyRows().map((row) => within(row).getByRole("rowheader").textContent ?? "");
}

describe("DataTable keyboard navigation", () => {
  it("uses a roving tabindex: one row is tabbable and arrow keys move focus", async () => {
    const user = userEvent.setup();
    renderTable({ showDensityToggle: false });
    const rows = bodyRows();
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);

    // Tab past the scroll region and the sortable column headers to the first row.
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(rows[0]);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[1]?.tabIndex).toBe(0);
    expect(rows[0]?.tabIndex).toBe(-1);

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(rows[3]);

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows[2]);

    await user.keyboard("{End}");
    expect(document.activeElement).toBe(rows[5]);

    // Stops at the last row rather than wrapping.
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows[5]);

    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(rows[0]);
  });

  it("activates the focused row with Enter", async () => {
    const user = userEvent.setup();
    const onRowActivate = vi.fn();
    renderTable({ onRowActivate });
    const rows = bodyRows();
    rows[0]?.focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onRowActivate).toHaveBeenCalledWith(residents[1]);
  });
});

describe("DataTable sorting", () => {
  it("sorts by a column and exposes the direction with aria-sort", async () => {
    const user = userEvent.setup();
    renderTable();
    const nameHeader = screen.getByRole("columnheader", { name: "Name" });
    const roomHeader = screen.getByRole("columnheader", { name: "Room" });
    expect(nameHeader).not.toHaveAttribute("aria-sort");

    await user.click(within(nameHeader).getByRole("button", { name: "Name" }));
    expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    expect(names()).toEqual([...residents.map((r) => r.name)].sort((a, b) => a.localeCompare(b)));

    await user.click(within(nameHeader).getByRole("button", { name: "Name" }));
    expect(nameHeader).toHaveAttribute("aria-sort", "descending");
    expect(names()).toEqual([...residents.map((r) => r.name)].sort((a, b) => b.localeCompare(a)));

    await user.click(within(roomHeader).getByRole("button", { name: "Room" }));
    expect(roomHeader).toHaveAttribute("aria-sort", "ascending");
    expect(nameHeader).not.toHaveAttribute("aria-sort");
    const rooms = bodyRows().map((row) =>
      Number((row as HTMLTableRowElement).cells[1]?.textContent),
    );
    expect(rooms).toEqual([3, 8, 12, 15, 21, 27]);
  });

  it("does not offer sorting on columns without a sort value", () => {
    renderTable();
    const keyWorker = screen.getByRole("columnheader", { name: "Key worker" });
    expect(within(keyWorker).queryByRole("button")).toBeNull();
  });

  it("keeps the roving focus on the same record after sorting", async () => {
    const user = userEvent.setup();
    renderTable();
    bodyRows()[0]?.focus();
    await user.keyboard("{ArrowDown}");
    const focusedName = within(document.activeElement as HTMLElement).getByRole(
      "rowheader",
    ).textContent;
    await user.click(screen.getByRole("button", { name: "Room" }));
    const tabbable = bodyRows().filter((row) => row.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(within(tabbable[0] as HTMLElement).getByRole("rowheader").textContent).toBe(focusedName);
  });
});

describe("DataTable density", () => {
  it("switches between comfortable and compact", async () => {
    const user = userEvent.setup();
    const onDensityChange = vi.fn();
    const { container } = renderTable({ onDensityChange });
    const wrapper = container.querySelector(".hb-table");
    expect(wrapper).toHaveAttribute("data-density", "comfortable");
    const group = screen.getByRole("radiogroup", { name: "Row density" });
    await user.click(within(group).getByRole("radio", { name: "Compact" }));
    expect(wrapper).toHaveAttribute("data-density", "compact");
    expect(onDensityChange).toHaveBeenCalledWith("compact");
  });
});

describe("DataTable on a narrow screen", () => {
  it("scrolls inside a named, focusable region rather than the page", async () => {
    const { container } = renderTable();
    const region = screen.getByRole("region", { name: "People living at Rowan House" });
    expect(region).toHaveClass("hb-table__scroll");
    expect(region.tabIndex).toBe(0);
    expect(within(region).getByRole("table")).toBeInTheDocument();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
