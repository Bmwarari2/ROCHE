import "server-only";
import type { Me } from "@harbour/contracts";
import { redirect } from "next/navigation";
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
import { redirectForProblem } from "./problems";

/**
 * Reads the home dashboard's tiles (docs/specs/insights.md): every read in parallel, as the
 * signed-in person through the endpoints the lists use, so scope, MFA and audit are the API's.
 * A read never throws here: it is data, a refusal for a missing permission, or a failure the tile
 * shows as a warning.
 */

interface Result<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response?: Response;
}

/** A read and, when it was refused, the API's problem code (for a sign-in or MFA redirect). */
interface Read<T> {
  readonly load: Load<T>;
  readonly code: string | undefined;
}

/**
 * One read. A refusal for a missing permission hides the tile; so does `not_found` for a
 * per-location read, since a permission's scope can leave out a location the person works at
 * (ADR-0071) and its list page would not open either. Anything else is a failure, logged by path,
 * status and problem code only (no personal data), and shown as a warning.
 */
async function read<T>(
  path: string,
  call: () => Promise<Result<T>>,
  perLocation = false,
): Promise<Read<T>> {
  try {
    const { data, error, response } = await call();
    if (data) return { load: ok(data), code: undefined };
    const code = problemCode(error);
    if (code === "missing_permission" || (perLocation && code === "not_found")) {
      return { load: FORBIDDEN, code };
    }
    console.warn(
      JSON.stringify({ event: "web.dashboard.read_failed", path, status: response?.status, code }),
    );
    return { load: FAILED, code };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "web.dashboard.read_failed",
        path,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return { load: FAILED, code: undefined };
  }
}

/** The reader's notifications, read once per request for the shell's count and the alerts tile. */
export const readNotifications = cache(async () => {
  const api = await tenantApi();
  return (await read("/v1/notifications", () => api.GET("/v1/notifications"))).load;
});

export async function loadDashboard(me: Me, locationId: string | null): Promise<TileSummary[]> {
  const api = await tenantApi();
  const shown = new Set<TileId>(visibleTiles(me.permissions));
  const places = dashboardLocations(me.locations, locationId);
  const codes: (string | undefined)[] = [];
  const keep = <T>(r: Read<T>): Load<T> => {
    codes.push(r.code);
    return r.load;
  };
  const perLocation = async <T>(
    id: TileId | readonly TileId[],
    path: string,
    call: (location: string) => Promise<Result<T>>,
  ): Promise<Load<T>[]> => {
    const ids = typeof id === "string" ? [id] : id;
    if (!ids.some((i) => shown.has(i)) || places.tooMany) return [];
    const reads = await Promise.all(
      places.ids.map((location) => read(path, () => call(location), true)),
    );
    return reads.map(keep);
  };
  const once = async <T>(
    id: TileId,
    path: string,
    call: () => Promise<Result<T>>,
  ): Promise<Load<T> | null> => (shown.has(id) ? keep(await read(path, call)) : null);

  const [alerts, rounds, handovers, reviews, incidents, draft, ready, outages, breakGlass] =
    await Promise.all([
      readNotifications(),
      perLocation(["tasks", "dols"], "/v1/locations/{id}/round", (id) =>
        api.GET("/v1/locations/{id}/round", { params: { path: { id } } }),
      ),
      perLocation("handover", "/v1/locations/{id}/handovers", (id) =>
        api.GET("/v1/locations/{id}/handovers", { params: { path: { id } } }),
      ),
      perLocation("reviews", "/v1/locations/{id}/reviews", (id) =>
        api.GET("/v1/locations/{id}/reviews", { params: { path: { id } } }),
      ),
      once("incidents", "/v1/incidents", () =>
        api.GET("/v1/incidents", { params: { query: locationId ? { locationId } : {} } }),
      ),
      once("notifications", "/v1/notifications/statutory", () =>
        api.GET("/v1/notifications/statutory", {
          params: { query: { ...(locationId ? { locationId } : {}), status: "draft" } },
        }),
      ),
      once("notifications", "/v1/notifications/statutory", () =>
        api.GET("/v1/notifications/statutory", {
          params: { query: { ...(locationId ? { locationId } : {}), status: "ready" } },
        }),
      ),
      perLocation("outages", "/v1/locations/{id}/outages", (id) =>
        api.GET("/v1/locations/{id}/outages", { params: { path: { id } } }),
      ),
      once("breakGlass", "/v1/break-glass/weekly-report", () =>
        api.GET("/v1/break-glass/weekly-report", { params: { query: {} } }),
      ),
    ]);

  // A sign-in, MFA or step-up refusal is the person's state, not a failure: send them where the
  // list pages would, instead of warning on every tile.
  for (const code of codes) {
    const target = redirectForProblem(code, "/");
    if (target) redirect(target);
  }

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
