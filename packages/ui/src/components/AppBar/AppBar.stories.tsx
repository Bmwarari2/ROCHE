import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { CircleHelp, CircleUserRound } from "lucide-react";
import { useState } from "react";
import { iconProps } from "../../lib/icon";
import { IconButton } from "../Button/Button";
import { AppBar, type AppBarSwitcher } from "./AppBar";

/** Gives the skip link a target, as the app layout would. */
const withPage: Decorator = (Story) => (
  <>
    <Story />
    <div id="main-content" tabIndex={-1} style={{ padding: 22 }}>
      <p style={{ margin: 0 }}>Page content</p>
    </div>
  </>
);

const tenants = [
  { id: "t-1", label: "Harbour Example Care", description: "Residential care" },
  { id: "t-2", label: "Sample Homecare", description: "Domiciliary care" },
];

const locations = [
  { id: "l-1", label: "Rowan House", description: "28 beds" },
  { id: "l-2", label: "Willow Court", description: "40 beds" },
  { id: "l-3", label: "Community team north" },
];

const actions = (
  <>
    <IconButton label="Help" icon={<CircleHelp {...iconProps} size={20} />} />
    <IconButton label="Your account" icon={<CircleUserRound {...iconProps} size={20} />} />
  </>
);

function SwitchingAppBar() {
  const [tenant, setTenant] = useState("t-1");
  const [location, setLocation] = useState("l-1");
  const tenantSwitcher: AppBarSwitcher = {
    label: "Organisation",
    options: tenants,
    value: tenant,
    onValueChange: setTenant,
  };
  const locationSwitcher: AppBarSwitcher = {
    label: "Location",
    options: locations,
    value: location,
    onValueChange: setLocation,
  };
  return <AppBar tenant={tenantSwitcher} location={locationSwitcher} actions={actions} />;
}

const meta = {
  title: "Product shell/App bar",
  component: AppBar,
  decorators: [withPage],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AppBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithSwitchers: Story = {
  render: () => <SwitchingAppBar />,
};

export const SingleOrganisation: Story = {
  args: {
    tenant: {
      label: "Organisation",
      options: [tenants[0] ?? { id: "t-1", label: "Harbour Example Care" }],
      value: "t-1",
      onValueChange: () => {},
    },
    location: {
      label: "Location",
      options: locations,
      value: "l-2",
      onValueChange: () => {},
    },
    actions,
  },
};

export const BrandOnly: Story = {
  args: { actions },
};
