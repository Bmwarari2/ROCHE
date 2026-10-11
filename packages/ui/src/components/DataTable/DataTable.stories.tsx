import type { Meta, StoryObj } from "@storybook/react-vite";
import { Users } from "lucide-react";
import { useState } from "react";
import { type ResidentFixture, residents } from "../../fixtures/residents";
import { iconProps } from "../../lib/icon";
import { Button } from "../Button/Button";
import { EmptyState } from "../EmptyState/EmptyState";
import { StatusChip } from "../StatusChip/StatusChip";
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
  {
    id: "dob",
    header: "Date of birth",
    cell: (row) => <time dateTime={row.dateOfBirth}>{row.dateOfBirthLabel}</time>,
    sortValue: (row) => row.dateOfBirth,
  },
  { id: "nhs", header: "NHS number", cell: (row) => row.nhsNumber },
  {
    id: "medicines",
    header: "Next medicines",
    cell: (row) => (
      <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        <StatusChip status={row.medicinesStatus} />
        <span>{row.nextMedicines}</span>
      </span>
    ),
  },
  {
    id: "keyWorker",
    header: "Key worker",
    cell: (row) => row.keyWorker,
    sortValue: (row) => row.keyWorker,
  },
];

const meta = {
  title: "Product shell/Data table",
  component: DataTable<ResidentFixture>,
  args: {
    caption: "People living at Rowan House",
    columns,
    rows: residents,
    getRowId: (row: ResidentFixture) => row.id,
  },
} satisfies Meta<typeof DataTable<ResidentFixture>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SortedByRoom: Story = {
  args: { defaultSort: { columnId: "room", direction: "ascending" } },
};

export const Compact: Story = {
  args: { defaultDensity: "compact" },
};

export const HiddenCaption: Story = {
  args: { hideCaption: true, showDensityToggle: false },
};

export const Empty: Story = {
  args: {
    rows: [],
    emptyState: (
      <EmptyState
        title="No one lives here yet"
        description="Add the first person to start their record."
        icon={<Users {...iconProps} />}
        headingLevel={3}
        action={<Button>Add a person</Button>}
      />
    ),
  },
};

function SelectableTable() {
  const [selected, setSelected] = useState<string | undefined>("res-03");
  return (
    <DataTable
      caption="People living at Rowan House"
      columns={columns}
      rows={residents}
      getRowId={(row) => row.id}
      selectedRowId={selected}
      onRowActivate={(row) => setSelected(row.id)}
    />
  );
}

export const WithRowActivation: Story = {
  render: () => <SelectableTable />,
};
