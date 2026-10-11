import { CreateObservation } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import { readChartValues } from "./chart-entry";

const t = createTranslator("en-GB");

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

const vitals = {
  respirationRate: "22",
  spo2: "95",
  systolic: "105",
  pulse: "95",
  temperature: "38.2",
};

const noLevels = { food: null, drink: null };

describe("chart entries read from the form", () => {
  it("hazard HZ-012 hazard HZ-014 refuses vital signs until air or oxygen and consciousness are chosen", () => {
    const refused = readChartValues("vitals", form(vitals), t, noLevels);
    expect(refused).toMatchObject({
      ok: false,
      fields: {
        oxygen: "Choose air or oxygen",
        consciousness: "Choose the level of consciousness",
      },
    });
    const read = readChartValues(
      "vitals",
      form({ ...vitals, oxygen: "air", consciousness: "alert" }),
      t,
      noLevels,
    );
    expect(read).toMatchObject({ chart: "vitals", onOxygen: false, consciousness: "alert" });
    expect(
      CreateObservation.safeParse({ occurredAt: "2026-10-11T10:00:00.000Z", values: read }).success,
    ).toBe(true);
  });

  it("says which vital signs are missing, each at its own field", () => {
    const refused = readChartValues(
      "vitals",
      form({ oxygen: "oxygen", consciousness: "new_confusion" }),
      t,
      noLevels,
    );
    const fields = "ok" in refused && !refused.ok ? (refused.fields ?? {}) : {};
    expect(Object.keys(fields)).toEqual([
      "respirationRate",
      "spo2",
      "systolic",
      "pulse",
      "temperature",
    ]);
  });

  it("hazard HZ-016 needs the texture given for food, and for a drink when a level is prescribed", () => {
    expect(
      readChartValues("food", form({ meal: "lunch", portion: "half" }), t, noLevels),
    ).toMatchObject({ ok: false, fields: { iddsiLevel: "Choose the texture given" } });
    expect(
      readChartValues("fluid_intake", form({ ml: "200" }), t, { food: null, drink: "2" }),
    ).toMatchObject({
      ok: false,
      fields: { iddsiLevel: "Choose the drink level given: a drink level is prescribed" },
    });
    expect(readChartValues("fluid_intake", form({ ml: "200" }), t, noLevels)).toMatchObject({
      chart: "fluid_intake",
      ml: 200,
    });
    expect(
      readChartValues("fluid_intake", form({ ml: "200", iddsiLevel: "2" }), t, {
        food: null,
        drink: "2",
      }),
    ).toMatchObject({ chart: "fluid_intake", iddsiLevel: "2" });
  });

  it("refuses amounts the API would refuse, at the field", () => {
    expect(readChartValues("fluid_output", form({ ml: "6000" }), t, noLevels)).toMatchObject({
      ok: false,
      fields: { ml: t("care.charts.amountRequired") },
    });
    expect(readChartValues("weight", form({ kg: "19" }), t, noLevels)).toMatchObject({
      ok: false,
      fields: { kg: t("care.charts.weightRequired") },
    });
  });
});
