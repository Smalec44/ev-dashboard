import { useEffect, useRef, useState } from "react";
import { parseRouteQuery } from "@/lib/route";
import type { LatLon } from "@/lib/types";

export type DetourStop = LatLon & { id: string };

/** Quiet time after the shortlist last changed: one slider drag is many changes. */
const DEBOUNCE_MS = 400;

const NONE: ReadonlyMap<string, number> = new Map();

/**
 * True road detours, in km by station id, for the stops on a shortlist, from
 * /api/road-detours. `pairKey` is the route's query string (see routeQuery),
 * or null when the trip is not on a road and nothing should be asked.
 *
 * Every answer is a distance-table call on a shared community router, so the
 * hook asks sparingly: only once the shortlist has settled for a moment, only
 * for stops not yet measured on this pair, and never while a request for the
 * pair is in flight — a newer shortlist waits for it, then asks for whatever
 * is still missing. A failure leaves those stops on their estimates.
 *
 * Answers are stored with the pair they belong to, as useRoadRoute keeps its
 * route, so a new pair never shows the last one's detours; and state changes
 * only when a response arrives, never in the effect body.
 */
export function useRoadDetours(
  pairKey: string | null,
  shortlist: readonly DetourStop[],
): ReadonlyMap<string, number> {
  const [settled, setSettled] = useState<{
    key: string;
    detours: ReadonlyMap<string, number>;
  } | null>(null);
  // Bookkeeping for the async callbacks; none of it is read during render.
  const currentPair = useRef<string | null>(null);
  const asked = useRef<{ key: string; ids: Set<string> } | null>(null);
  const inFlight = useRef<{ key: string; done: Promise<void> } | null>(null);

  useEffect(() => {
    currentPair.current = pairKey;
    if (pairKey === null || shortlist.length === 0) return;
    const ends = parseRouteQuery(new URLSearchParams(pairKey));
    if (!ends) return;
    let superseded = false;

    const timer = setTimeout(() => {
      const previous =
        inFlight.current?.key === pairKey ? inFlight.current.done : Promise.resolve();
      const done = previous
        .then(async () => {
          // A newer shortlist arrived while this one waited its turn; it asks instead.
          if (superseded) return;
          const seen = asked.current?.key === pairKey ? asked.current.ids : new Set<string>();
          asked.current = { key: pairKey, ids: seen };
          const stops = shortlist.filter((stop) => !seen.has(stop.id));
          if (stops.length === 0) return;

          const res = await fetch("/api/road-detours", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from: ends.from,
              to: ends.to,
              stops: stops.map(({ id, lat, lon }) => ({ id, lat, lon })),
            }),
          });
          const body = (await res.json()) as { detours?: Record<string, unknown> };
          if (!res.ok || !body.detours) return;
          // The search moved to another pair meanwhile: this answer is dropped,
          // so its stops stay unasked and are measured if the pair comes back.
          if (currentPair.current !== pairKey) return;
          // Marked only once answered, so a batch that failed is asked again later.
          // A stop the router could not reach is left out of the answer, and
          // stays on its estimate rather than being asked about forever.
          for (const stop of stops) seen.add(stop.id);
          const answered = Object.entries(body.detours).filter(
            (entry): entry is [string, number] =>
              typeof entry[1] === "number" && Number.isFinite(entry[1]),
          );
          setSettled((current) => {
            const next = new Map(current?.key === pairKey ? current.detours : NONE);
            for (const [id, km] of answered) next.set(id, km);
            return { key: pairKey, detours: next };
          });
        })
        .catch(() => undefined);
      inFlight.current = { key: pairKey, done };
    }, DEBOUNCE_MS);

    return () => {
      superseded = true;
      clearTimeout(timer);
    };
  }, [pairKey, shortlist]);

  return settled?.key === pairKey ? settled.detours : NONE;
}
