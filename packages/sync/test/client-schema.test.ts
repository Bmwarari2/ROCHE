import { describe, expect, it } from "vitest";
import { AppSchema } from "../src/client/schema";
import { readSyncConfig } from "../src/streams/index";
import { compile, ids, syncFor } from "./support/simulator";

/** The device schema and the stream outputs must agree, or synced columns are silently dropped. */
describe("client schema matches stream output", () => {
  it("declares every column the streams send", async () => {
    const { hydrated } = compile(readSyncConfig());
    const row = {
      id: "p1",
      tenant_id: "t1",
      location_id: "l1",
      status: "active",
      given_name: "Ada",
      family_name: "Example",
      preferred_name: null,
      date_of_birth: "1938-02-01",
      nhs_number: "9990000018",
      room_label: "12",
      photo_document_id: null,
      communication_needs: "[]",
      allergy_status: "unknown",
      updated_at: "2026-10-01T09:00:00Z",
      version: 1,
    };
    const device = await syncFor(
      hydrated,
      {
        person: [row],
        location: [
          {
            id: "l1",
            tenant_id: "t1",
            name: "North",
            regulator_location_id: "1-1",
            nation: "england",
          },
        ],
        allergy: [
          {
            id: "a1",
            tenant_id: "t1",
            person_id: "p1",
            substance: "Latex",
            reaction: null,
            severity: "mild",
            status: "active",
            recorded_at: "2026-10-01T09:00:00Z",
          },
        ],
      },
      { sub: "u1", tenant_id: "t1", location_ids: ["l1"], people_location_ids: ["l1"] },
    );
    expect(ids(device, "person")).toEqual(["p1"]);
    for (const tableName of ["person", "location", "allergy"]) {
      const declared = new Set(
        AppSchema.tables.find((t) => t.name === tableName)?.columns.map((c) => c.name) ?? [],
      );
      const sent = [...(device.tables[tableName]?.values() ?? [])].flatMap((r) => Object.keys(r));
      for (const column of sent) {
        if (column === "id") continue;
        expect(declared.has(column), `${tableName}.${column}`).toBe(true);
      }
    }
  });
});
