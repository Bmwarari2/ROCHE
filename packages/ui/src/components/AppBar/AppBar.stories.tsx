import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { CircleHelp, CircleUserRound, LogOut, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { iconProps } from "../../lib/icon";
import { AccountMenu } from "../AccountMenu/AccountMenu";
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

const accountMenu = (
  <AccountMenu
    userName="Ben Sample"
    userDetail="ben.sample@example.invalid"
    organisationName="Harbour Example Care and Support Services"
    locationName="Willow Court Nursing and Residential Home"
    items={[
      {
        id: "security",
        label: "Sign-in and security",
        href: "#security",
        icon: <ShieldCheck {...iconProps} size={16} />,
      },
      {
        id: "sign-out",
        label: "Sign out",
        onSelect: () => {},
        icon: <LogOut {...iconProps} size={16} />,
      },
    ]}
  />
);

/** The account menu as the app bar's action, as the web shell uses it. */
export const WithAccountMenu: Story = {
  args: {
    tenant: {
      label: "Organisation",
      options: tenants,
      value: "t-1",
      onValueChange: () => {},
    },
    location: {
      label: "Location",
      options: locations,
      value: "l-1",
      onValueChange: () => {},
    },
    actions: accountMenu,
  },
};

/**
 * Long names on a small phone: the organisation and location names shorten with an ellipsis so
 * the account menu stays on screen. Switch the viewport back to see them in full.
 */
export const LongNamesOnAPhone: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  args: {
    tenant: {
      label: "Organisation",
      options: [
        { id: "t-1", label: "Harbour Example Care and Support Services" },
        { id: "t-2", label: "Sample Homecare" },
      ],
      value: "t-1",
      onValueChange: () => {},
    },
    location: {
      label: "Location",
      options: [{ id: "l-1", label: "Willow Court Nursing and Residential Home" }],
      value: "l-1",
      onValueChange: () => {},
    },
    actions: accountMenu,
  },
};
