import type { NextRequest } from "next/server";
import { parseRouteQuery } from "@/lib/route";
import { RoutingUnavailableError, getRouter } from "@/server/routing/osrm";

/**
 * One driving route between two Swiss places, for trip mode.
 *
 * The router is a shared community service, so its answers are cached on the
 * server (see getRouter) and for an hour in the browser. A failure is an
 * answer too — the page falls back to straight-line distances — so it is
 * reported straight away, never retried here.
 */
export async function GET(request: NextRequest) {
  const ends = parseRouteQuery(request.nextUrl.searchParams);
  if (!ends) {
    return Response.json({ error: "Missing or malformed route endpoints." }, { status: 400 });
  }
  try {
    const route = await getRouter().route(ends.from, ends.to);
    return Response.json(route, { headers: { "Cache-Control": "public, max-age=3600" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      {
        // 503: we declined to ask (switched off, or too busy); 502: we asked and it failed.
        status: error instanceof RoutingUnavailableError ? 503 : 502,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
