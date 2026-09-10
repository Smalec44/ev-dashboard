import type { NextRequest } from "next/server";
import { inSwitzerland } from "@/lib/geo";
import { routeEnds } from "@/lib/route";
import type { LatLon } from "@/lib/types";
import {
  MAX_DETOUR_STOPS,
  RoutingUnavailableError,
  getRouter,
  type DetourStop,
} from "@/server/routing/osrm";

/** Longest stop id taken. The feed's are far shorter; this only bounds the request. */
const MAX_ID_LENGTH = 200;

const NO_STORE = { "Cache-Control": "no-store" };

function point(value: unknown): LatLon | null {
  if (typeof value !== "object" || value === null) return null;
  const { lat, lon } = value as { lat?: unknown; lon?: unknown };
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function stop(value: unknown): DetourStop | null {
  const at = point(value);
  if (!at || !inSwitzerland(at)) return null;
  const { id } = value as { id?: unknown };
  if (typeof id !== "string" || id === "" || id.length > MAX_ID_LENGTH) return null;
  return { id, ...at };
}

/** The request, or null for anything the router should not be asked. */
function parseRequest(body: unknown) {
  if (typeof body !== "object" || body === null) return null;
  const { from, to, stops } = body as { from?: unknown; to?: unknown; stops?: unknown };
  const start = point(from);
  const end = point(to);
  const ends = start && end ? routeEnds(start, end) : null;
  if (!ends || !Array.isArray(stops)) return null;
  if (stops.length === 0 || stops.length > MAX_DETOUR_STOPS) return null;
  const parsed = stops.map(stop).filter((entry): entry is DetourStop => entry !== null);
  return parsed.length === stops.length ? { ...ends, stops: parsed } : null;
}

/**
 * The true road detour through each stop on a trip's shortlist, from one
 * table call to the router. A POST because the shortlist does not fit in a
 * query string. Failure is an answer here too: the page keeps its estimates.
 */
export async function POST(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  const ask = parseRequest(body);
  if (!ask) {
    return Response.json(
      { error: `Missing or malformed route endpoints, or not 1–${MAX_DETOUR_STOPS} valid stops.` },
      { status: 400, headers: NO_STORE },
    );
  }
  try {
    const detours = await getRouter().detours(ask.from, ask.to, ask.stops);
    return Response.json({ detours: Object.fromEntries(detours) }, { headers: NO_STORE });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      {
        // 503: we declined to ask (switched off, or too busy); 502: we asked and it failed.
        status: error instanceof RoutingUnavailableError ? 503 : 502,
        headers: NO_STORE,
      },
    );
  }
}
