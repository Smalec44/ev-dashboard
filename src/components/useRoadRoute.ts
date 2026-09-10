import { useEffect, useState } from "react";
import { routeQuery } from "@/lib/route";
import type { LatLon, RoadRoute } from "@/lib/types";

export type RoadRouteState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; route: RoadRoute }
  | { state: "failed"; message: string };

type Settled = Extract<RoadRouteState, { state: "ready" | "failed" }>;

/**
 * The road route between two places, from /api/road-route; "idle" while
 * either end is missing.
 *
 * The answer is stored with the pair it belongs to, and "loading" is derived
 * whenever that pair is not the current one. So a new pair never shows the
 * previous pair's road for the moment its own is in flight, and nothing has
 * to be reset by a setState in the effect body — state only ever changes when
 * a response arrives.
 */
export function useRoadRoute(from: LatLon | null, to: LatLon | null): RoadRouteState {
  const key = from && to ? routeQuery(from, to).toString() : null;
  const [settled, setSettled] = useState<{ key: string; result: Settled } | null>(null);

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    void fetch(`/api/road-route?${key}`, { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json()) as RoadRoute | { error: string };
        if (!res.ok || "error" in body) {
          throw new Error("error" in body ? body.error : `road route returned ${res.status}`);
        }
        setSettled({ key, result: { state: "ready", route: body } });
      })
      .catch((error: unknown) => {
        // Superseded by a newer pair, or unmounted: nobody is waiting for this.
        if (controller.signal.aborted) return;
        setSettled({
          key,
          result: { state: "failed", message: error instanceof Error ? error.message : String(error) },
        });
      });
    return () => {
      controller.abort();
    };
  }, [key]);

  if (key === null) return { state: "idle" };
  if (settled?.key !== key) return { state: "loading" };
  return settled.result;
}
