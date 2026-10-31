import "server-only";
import type { Me } from "@harbour/contracts";
import { cache } from "react";
import { problemCode, tenantApi } from "./api";
import {
  alertsTile,
  breakGlassTile,
  chooseTile,
  dashboardLocations,
  dolsTile,
  FAILED,
  FORBIDDEN,
  handoverTile,
  incidentsTile,
  type Load,
  locationHref,
  notificationsTile,
  ok,
  outagesTile,
  PER_LOCATION_TILES,
  reviewsTile,
  type TileId,
  type TileSummary,
  tasksTile,
  visibleTiles,
} from "./dashboard";

/**
 * Reads the home dashboard's tiles (docs/specs/insights.md): every read in parallel, as the
 * signed-in person through the endpoints the lists use, so scope, MFA and audit are the API's.
 * A read never throws here: it is data, a refusal for a missing permission, or a failure the tile
 * shows as a warning.
 */

interface Result<T> {
  readonly data?: T;
  readonly error?: unknown;
}

async function load<T>(call: () => Promise<Result<T>>): Promise<Load<T>> {
  try {
    const { data, error } = await call();
    if (data) return ok(data);
    return problemCode(error) === "missing_permission" ? FORBIDDEN : FAILED;
  } catch {
    return FAILED;
  }
}

/** The reader's notifications, read once per request for the shell's count and the alerts tile. */
export const readNotifications = cache(async () => {
  const api = await tenantApi();
  return load(() => api.GET("/v1/notifications"));
});

export async function loadDashboard(me: Me, locationId: string | null): Promise<TileSummary[]> {
  const api = await tenantApi();
  const shown = new Set<TileId>(visibleTiles(me.permissions));
  const places = dashboardLocations(me.locations, locationId);
  const perLocation = <T>(
    id: TileId | readonly TileId[],
    call: (location: string) => Promise<Result<T>>,
  ): Promise<Load<T>[]> => {
    const ids = typeof id === "string" ? [id] : id;
    if (!ids.some((i) => shown.has(i)) || places.tooMany) return Promise.resolve([]);
    return Promise.all(places.ids.map((location) => load(() => call(location))));
  };
  const once = <T>(id: TileId, call: () => Promise<Result<T>>): Promise<Load<T> | null> =>
    shown.has(id) ? load(call) : Promise.resolve(null);

  const [alerts, rounds, handovers, reviews, incidents, draft, ready, outages, breakGlass] =
    await Promise.all([
      readNotifications(),
      perLocation(["tasks", "dols"], (id) =>
        api.GET("/v1/locations/{id}/round", { params: { path: { id } } }),
      ),
      perLocation("handover", (id) =>
        api.GET("/v1/locations/{id}/handovers", { params: { path: { id } } }),
      ),
      perLocation("reviews", (id) =>
        api.GET("/v1/locations/{id}/reviews", { params: { path: { id } } }),
      ),
      once("incidents", () =>
        api.GET("/v1/incidents", { params: { query: locationId ? { locationId } : {} } }),
      ),
      once("notifications", () =>
        api.GET("/v1/notifications/statutory", {
          params: { query: { ...(locationId ? { locationId } : {}), status: "draft" } },
        }),
      ),
      once("notifications", () =>
        api.GET("/v1/notifications/statutory", {
          params: { query: { ...(locationId ? { locationId } : {}), status: "ready" } },
        }),
      ),
      perLocation("outages", (id) =>
        api.GET("/v1/locations/{id}/outages", { params: { path: { id } } }),
      ),
      once("breakGlass", () => api.GET("/v1/break-glass/weekly-report", { params: { query: {} } })),
    ]);

  const build: Record<TileId, () => TileSummary | null> = {
    alerts: () => alertsTile(alerts),
    tasks: () => tasksTile(rounds, locationHref("/round", places.ids)),
    dols: () => dolsTile(rounds, locationHref("/round", places.ids)),
    handover: () => handoverTile(handovers, locationHref("/handover", places.ids)),
    reviews: () => reviewsTile(reviews),
    incidents: () => (incidents ? incidentsTile(incidents) : null),
    notifications: () => (draft && ready ? notificationsTile([draft, ready]) : null),
    outages: () => outagesTile(outages, locationHref("/downtime", places.ids)),
    breakGlass: () => (breakGlass ? breakGlassTile(breakGlass, locationId) : null),
  };
  const chooseHref: Partial<Record<TileId, string>> = {
    tasks: "/round",
    dols: "/round",
    handover: "/handover",
    reviews: "/people/reviews",
    outages: "/downtime",
  };

  return [...shown].flatMap((id) => {
    if (places.tooMany && PER_LOCATION_TILES.has(id)) {
      return [chooseTile(id, chooseHref[id] ?? "/")];
    }
    const tile = build[id]();
    return tile ? [tile] : [];
  });
}
