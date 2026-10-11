import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Meter } from "./Meter";

describe("Meter", () => {
  it("is a named meter that says its value in words", () => {
    render(
      <Meter
        label="Fluid intake today"
        value={900}
        max={1500}
        valueText="900 ml of a 1,500 ml target"
      />,
    );
    const meter = screen.getByRole("meter", { name: "Fluid intake today" });
    expect(meter).toHaveAttribute("value", "900");
    expect(meter).toHaveAttribute("max", "1500");
    expect(meter).toHaveAttribute("aria-valuetext", "900 ml of a 1,500 ml target");
    expect(screen.getByText("900 ml of a 1,500 ml target")).toBeVisible();
  });

  it("keeps the bar within its track for values beyond the limit or a missing limit", () => {
    const { rerender, container } = render(
      <Meter label="Intake" value={2000} max={1500} valueText="2,000 ml" />,
    );
    const fill = () => container.querySelector(".hb-meter__fill") as HTMLElement;
    expect(fill().style.width).toBe("100%");
    expect(screen.getByRole("meter")).toHaveAttribute("value", "1500");
    rerender(<Meter label="Intake" value={300} max={0} valueText="300 ml" />);
    expect(fill().style.width).toBe("100%");
    rerender(<Meter label="Intake" value={-5} max={100} valueText="0 ml" />);
    expect(fill().style.width).toBe("0%");
  });
});
