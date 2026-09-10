---
date: 2026-09-10T10:31:58+00:00
git_commit: 5e37910
branch: main
topic: "Trip mode measured on real road routes instead of straight lines"
tags: [plan, trip-mode, routing, dashboard, refresh, osrm]
status: ready
---

# Trip Mode Road Routing Implementation Plan

## Overview

Trip mode ("Between two places") measures everything on the straight line between the two towns. That includes where the charging break falls, how far a station sits off the way, and the detour cap. The map draws that line as dashes. On Swiss terrain this is misleading: Zürich → Lugano is 156 km direct but 206 km by road. A station can sit 5 km from the line and still be across a lake or ridge, much further away by car.

This plan puts one real road route per search into trip mode. The route comes from the free OSRM router on the FOSSGIS servers, through a new cached server endpoint. Each station is placed onto that route to find how far along it sits and how far off it is. For the shortlist around the break, one distance-table call replaces the estimate with the true road detour. When the router is unreachable, the app falls back to today's straight-line maths and says so.

The user decided three things when framing this plan:
- The router is called through a cached server endpoint. This is a deliberate exception to the backend spec's rule of "no third-party call in a request path".
- Exact road detours (Phase 4) are in scope.
- The five-phase outline below is approved.

## Current State Analysis

**Trip geometry.**
- All of it is straight-line. `detourKm` and `routeProgress` in `src/lib/geo.ts:23-32` use haversine distances between the two towns.
- The trip memo in `src/components/Dashboard.tsx:227-268` gates stations by `detourKm ≤ maxDetour` and computes `progress`.
- It keeps only stations within `STOP_WINDOW_KM` (20 km, `:69`) of the break, measured along the straight line (`window = STOP_WINDOW_KM / directKm`, `:251`). A trip counts as short when `directKm ≤ 40`.

**Map.**
- `src/components/ResultsMap.tsx:129-146` draws a dashed line, and places the "Planned break" marker by linear interpolation between the endpoints.
- The view fits the endpoints (`:93-100`).
- Station dots are also undashed SVG paths.

**Ranking.** It needs no change. `src/lib/ranking.ts:228-251` already takes `detourKm` and `routeProgress` maps and scores both on fixed scales.

**Live refresh.**
- `inScope` (`src/lib/refresh.ts:40-49`) decides what `/api/refresh` rebuilds (`src/app/api/refresh/route.ts:80-82`).
- It also decides what `applyRefresh` replaces on the client (`:127-136`).
- Client and server must use the same corridor, or refreshed stations vanish or stale ones survive.
- `refresh.test.ts` has five tests.

**Copy that says "straight line":**
- `Dashboard.tsx:594-596` ("Measured as the crow flies")
- `Dashboard.tsx:828-833` (footnote)
- `Dashboard.tsx:698-699` ("km direct … off the line")
- `ResultsMap.tsx:21`, `:132-133`
- `geo.ts:18-21`
- `ranking.ts:48` (hint)
- `StationCard.tsx:231-241` ("+x km detour")

**Conventions to follow.**
- The named user agent in `src/server/market/news.ts:32,104`.
- `fetch` stubbing via `t.mock.method(globalThis, "fetch", …)` (`src/server/market/market.test.ts:79-100`).
- Route handlers under `src/app/api/*/route.ts`, which are knip entry points (`knip.json`). knip also treats `*.test.ts` and `scripts/*.mjs` as entries.
- `react-hooks/set-state-in-effect` is a lint **error** here: `Dashboard.tsx:165-167` shows the pattern the codebase uses instead, which is state keyed by the input it belongs to.

**Gates.**
- The pre-commit hook runs `npm run check` (typecheck, eslint, knip, `node --test`). It must not need the network.
- The pre-push hook runs `npm run build`.
- CI (`.github/workflows/quality.yml`) runs all of these.
- There is no browser test tooling.

**Router facts.**
- `https://routing.openstreetmap.de/routed-car` (FOSSGIS OSRM) needs no key and answers Zürich→Lugano in about 0.15 s: 205.6 km, 159 min.
- `overview=full&geometries=geojson` returns 5,019 points (about 105 KB), in lon,lat order.
- The table endpoint handles a full 100×100 matrix and returns 400 `TooBig` at 101×101.
- The terms allow at most 1 request/second and require a user agent that identifies the app. There is no uptime guarantee.
- The terms also ask for a link to openstreetmap.org/fixthemap. Commercial use is allowed only if routing is not a "substantial part" of the offering and the site is not high-traffic.
- There is no swisstopo car-routing API.

## Desired End State

**With the router reachable, trip mode shows:**
- A header reading `206 km by road · 2 h 39 min · N stops within 20 km of the break, ≤ 25 km detour`.
- The solid road route on the map, with the planned-break marker on the road at the slider's fraction of the road distance.
- A break slider label of `≈ X km after Zürich`, in the same road km as the header. The 20 km stop window is measured along the road.
- On every card, `+D km detour` and `O km off route`:
  - Up to 98 shortlisted stations in the break window show `by road` with the true road detour.
  - The rest show `est.` (2 × off-route).
  - A station whose true road detour exceeds the cap drops out.
- A "Refresh live data" button that rebuilds exactly the corridor the client is using. The client tells the server which basis it used.
- A footer crediting the routing source and linking to openstreetmap.org/fixthemap.

**With the router unreachable, or `ROUTING_URL=off`:**
- Trip mode behaves exactly as today.
- A note says `Road route unavailable — using straight-line distances.`
- Nothing throws, and region mode is unaffected.

## Out of Scope

- Self-hosting OSRM, OpenRouteService, or any keyed or paid router. Production-scale or commercial use would need one; `ROUTING_URL` is the swap point.
- A rate limiter shared across server instances. The 1 req/s spacing holds per instance, which is documented in the README.
- Turn-by-turn directions, route alternatives, and options to avoid tolls, ferries or car trains.
- Battery- or range-aware stop planning.
- Road distances in region mode. The "nearby" criterion and the radius stay straight-line.
- Changing the Google Maps links (`src/lib/maps.ts`).
- Persisting routes or detours in Postgres.
- Playwright or other browser tests in CI. Browser checks are driven through Claude in Chrome during implementation.
- Changing the ranking formula or its fixed scales (`src/lib/ranking.ts`).

## UI Mockups

Trip mode, Zürich → Lugano:

```
BEFORE                                         AFTER (router up)
Zürich → Lugano                                Zürich → Lugano
156 km direct · 34 stops within 20 km of       206 km by road · 2 h 39 min · 34 stops within
the break, 25 km off the line                  20 km of the break, ≤ 25 km detour
┌ map ─────────────────────────────────┐       ┌ map ──────────────────────────────────┐
│ Zürich ●- - - - -◌- - - - -● Lugano  │       │ Zürich ●━━━╮     ╭━━━━● Lugano        │
│   (dashed straight line)             │       │            ┗━━◌━━┛  (solid road line) │
└──────────────────────────────────────┘       └───────────────────────────────────────┘
Charging break  ≈ 78 km after Zürich           Charging break  ≈ 103 km after Zürich
Maximum detour: "How far off the direct        Maximum detour: "Extra driving to reach the
line … as the crow flies"                      station and get back on the route"
card: [+3.2 km detour] [48% of the way]        card: [+4.8 km detour by road] [1.6 km off route]
                                                     [48% of the way]
                                               card (beyond shortlist): [+3.0 km detour est.] …
footnote: "Detours are straight-line …"        footnote: "Road route © OpenStreetMap contributors,
                                               via OSRM (FOSSGIS). Detours marked by road are
                                               measured on the road network; est. are twice
                                               the distance off the route."

AFTER (router down or ROUTING_URL=off): identical to BEFORE, plus one line under the header:
  Road route unavailable — using straight-line distances.
```

## Architecture and Code Reuse

```
Browser (Dashboard, trip mode)                          Server                                  Upstream
─────────────────────────────                           ──────                                  ────────
useRoadRoute(from|null,to|null)                         road-route/route.ts
  state {key, result}; loading derived ─ GET ─────────▶   └ getRouter().route() ─ cache? ────▶  FOSSGIS OSRM /route
                                                             router on globalThis:                overview=full, geojson
                                                             queue ≥1 s apart, ≤8 waiting,
                                                             4 s timeout from dequeue,
                                                             24 h LRU, thin to 150 m
      ◀── RoadRoute {distanceKm,durationMin,line} ──────
indexRoute (scaled to distanceKm) ─▶ measureStations ─▶ selectStops ─▶ mergeDetours ─▶ rankStations (unchanged)
                     (src/lib/route.ts, src/lib/trip.ts — pure, shared with the server)
useRoadDetours(pair, shortlist) ─ POST ───────────────▶  road-detours/route.ts
  one request in flight per pair                          └ getRouter().detours() ─ 1 table ─▶  FOSSGIS OSRM /table
      ◀── {detours: {id: km}} ──────────────────────────     A;s1…sN;B, N ≤ 98, per-stop cache
"Refresh live data": captures {scope incl. basis, index}
  ─ GET /api/refresh?mode=trip&basis=road|straight… ──▶  refresh/route.ts
                                                          ├ basis=road → route() (cache hit) → inScope(…, index)
      ◀── {…, routeBasis:"road"|"straight"} ────────────  └ route fails → straight + "route: …" error
applyRefresh(current, body, scope, captured index iff routeBasis==="road")
```

Touched files:

- `src/lib/`
  - `types.ts` — adds `RoadRoute`.
  - `geo.ts` — gains the exported `inSwitzerland` (moved from `refresh.ts:76-77`). Doc comment notes the straight-line fallback.
  - `route.ts` (new) — the route index and query codec.
    - `indexRoute` — cumulative km, scaled so `totalKm === distanceKm`.
    - `projectOntoRoute` — returns `{alongKm, offKm}`.
    - `pointAlong` — the point at a fraction of the route.
    - `routeQuery` / `parseRouteQuery` — encode and validate the endpoint pair.
  - `route.test.ts` (new)
  - `trip.ts` (new) — stop selection.
    - `measureStations`, `selectStops`, `isStop`, `mergeDetours`.
  - `trip.test.ts` (new)
  - `refresh.ts` — the trip scope gains `basis`; `inScope` takes an optional `RouteIndex`; `RefreshResponse` gains `routeBasis`.
  - `ranking.ts` — hint text only.
- `src/server/`
  - `http.ts` (new) — `USER_AGENT`, moved from `market/news.ts:32`.
  - `market/news.ts` — imports `USER_AGENT`.
  - `routing/osrm.ts` (new) — the router.
    - `createRouter({fetch, baseUrl, intervalMs, timeoutMs, maxWaiting})` returns `{ route, detours }`.
    - `getRouter()` builds the default instance lazily from `process.env.ROUTING_URL`. It is held on `globalThis` so it survives dev hot reloads.
    - Also `parseOsrmRoute`, `thinLine` and `parseOsrmTable`.
  - `routing/osrm.test.ts` (new)
  - `routing/zurich-lugano.test.ts` (new) — projection against the recorded real route.
  - `routing/fixtures/zurich-lugano.osrm.json` (new) — the recorded raw OSRM body.
  - `domain/attribution.ts` — an `osrm` entry, always active.
- `src/app/api/`
  - `road-route/route.ts` (new)
  - `road-detours/route.ts` (new)
  - `refresh/route.ts` — resolves the route for `basis=road` and reports `routeBasis`.
- `src/components/`
  - `useRoadRoute.ts` (new)
  - `useRoadDetours.ts` (new)
  - `Dashboard.tsx` — wires in the hooks and `trip.ts`; copy updates.
  - `ResultsMap.tsx` — the `road-route` and `direct-line` polylines; the break marker on the road.
  - `StationCard.tsx` — off-route chip and `by road` / `est.` labels.
- `scripts/record-route-fixture.mjs` (new) — records the fixture once.
- `README.md` — a new "Configuration" section covering `ROUTING_URL`, the per-instance rate limit and `OVERPASS_ENDPOINTS`.

**Reused:**
- The `t.mock.method` fetch stubs.
- The `Response.json` error shape from `refresh/route.ts`.
- `distanceKm` in `geo.ts`.
- The `{search, page}` keyed-state pattern (`Dashboard.tsx:165-167`), reused for hook state.

## Performance Considerations

**Payload.** The route is thinned server-side to one point per ≥150 m, which is about 1,400 points for 206 km. Coordinates are rounded to 5 decimals, so the payload is about 30 KB, down from about 105 KB upstream.

**Projection.**
- `measureStations` runs once for each change of road or station set, not on slider moves.
- It pre-filters by the route's bounding box, widened by 30 km (half the slider maximum). It then tests at most about 5,800 stations × 1,400 segments, well under 50 ms.
- `selectStops` handles slider moves as a cheap filter.

**Upstream calls.**
- A search makes one route call per new pair. Routes are cached for 24 h, up to 200 pairs, least recently used first out.
- Exact detours make one table call per new shortlist. It is debounced 400 ms, and there is never more than one in flight per pair. A per-stop cache means only unmeasured stops are sent.
- A refresh reuses the cached route.

**Back-pressure.**
- Every router call goes through one queue per server instance, spaced ≥1 s apart. When more than 8 calls are waiting, new ones fail fast with `router busy`: the endpoints answer 503 and the client falls back.
- The 4 s timeout starts when a call leaves the queue, so waiting time does not use it up.
- The router instance lives on `globalThis`, so dev hot reloads don't reset the spacing.
- The limit is per instance, not global. This is documented, and cross-instance limiting is out of scope.

## Migration Notes

**No stored state.** Nothing persistent changes and there is no schema change.

**New environment variable: `ROUTING_URL`.**
- The default is `https://routing.openstreetmap.de/routed-car`.
- `ROUTING_URL=off` is a kill switch. The endpoints answer 503 immediately and the client uses the straight-line fallback.

**Rollback.** Either `ROUTING_URL=off`, which needs no code change, or a plain revert.

**Wire compatibility.** A missing `basis` parameter parses as `straight`, and a missing `routeBasis` field counts as `straight`. Old clients paired with new servers, and new clients with old servers, both stay consistent on the straight-line corridor.

## Phase 1 — The map shows the road route

A trip search fetches the real road route through `/api/road-route`, draws it on the map and shows road km and driving time in the header. If the router fails, the dashed line and the "km direct" header stay exactly as today. Stop selection and scoring stay straight-line in this phase.

**Tasks**:

- [x] Add `RoadRoute { distanceKm: number; durationMin: number; line: LatLon[] }` at `src/lib/types.ts`.
- [x] Move `inSwitzerland` from `src/lib/refresh.ts:76-77` to `src/lib/geo.ts`, exported, and import it in `refresh.ts`. This avoids a `route → refresh → trip → route` import cycle later.
- [x] Add `routeQuery(from, to): URLSearchParams` and `parseRouteQuery(params): { from; to } | null` at `src/lib/route.ts`.
  - The query parameters are `fromLat`, `fromLon`, `toLat` and `toLon`.
  - `parseRouteQuery` rejects non-finite values, points outside Switzerland and identical endpoints.
- [x] Create `src/server/http.ts` exporting `USER_AGENT` (moved from `src/server/market/news.ts:32`), and import it in `news.ts`.
- [x] Add `thinLine(points, minGapKm = 0.15)` at `src/server/routing/osrm.ts`. It keeps the first point, every point ≥150 m from the last kept one, and always the last point, rounded to 5 decimals.
- [x] Add `parseOsrmRoute(json): RoadRoute` at `src/server/routing/osrm.ts`.
  - It requires `code === "Ok"` and a `routes[0]`.
  - It maps `[lon, lat]` to `{lat, lon}`, converts metres to km and seconds to minutes, and thins the line.
  - Anything else throws a descriptive `Error`.
- [x] Add `createRouter({ fetch, baseUrl, intervalMs = 1000, timeoutMs = 4000, maxWaiting = 8 })` at `src/server/routing/osrm.ts`. It returns `{ route(from, to) }`, and each instance owns its own queue and caches.
  - `baseUrl === "off"` makes every call reject with `Error("routing disabled")` without fetching.
  - The queue spaces upstream calls ≥ `intervalMs` apart and rejects with `Error("router busy")` when more than `maxWaiting` are waiting.
  - `AbortSignal.timeout(timeoutMs)` is created when a call leaves the queue.
  - `route` checks an LRU cache first: 200 pairs, 24 h, keyed by coordinates rounded to 4 decimals.
  - A cache miss sends `GET {baseUrl}/route/v1/driving/{fromLon},{fromLat};{toLon},{toLat}?overview=full&geometries=geojson` with a `User-Agent: USER_AGENT` header, then parses the response.
  - Only successes are cached.
- [x] Add `getRouter()` at `src/server/routing/osrm.ts`. It lazily builds the default instance from `process.env.ROUTING_URL`, or the FOSSGIS default, using global `fetch`, and keeps it on `globalThis`.
- [x] Add a `GET` handler at `src/app/api/road-route/route.ts`.
  - Parameters are parsed with `parseRouteQuery`; a bad request gets 400 `{error}`.
  - Success returns the `RoadRoute` with `Cache-Control: public, max-age=3600`.
  - Failure returns `{error}`: 503 for "routing disabled" or "router busy", 502 for anything else.
- [x] Add `useRoadRoute(from: LatLon | null, to: LatLon | null)` at `src/components/useRoadRoute.ts`.
  - It keeps state as `{ key, result }`, where `key` is the endpoint pair.
  - It returns `{ state: "idle" | "loading" } | { state: "ready"; route } | { state: "failed"; message }`.
  - `idle` means an endpoint is null. `loading` is derived whenever the stored key differs from the current pair, so an old route is never returned for a new pair.
  - Its effect fetches with an `AbortController`, aborts on change, and calls setState only inside the async callbacks, because `react-hooks/set-state-in-effect` is an error.
- [x] Extend `MapRoute` with `road?: LatLon[]` at `src/components/ResultsMap.tsx:18-23`.
  - When present, draw the road as a solid polyline (`--foreground`, weight 4, `className: "road-route"`) and fit the bounds to it (`:93-100`).
  - Keep the dashed direct line, now `className: "direct-line"`, and the break marker on it.
  - Update the comment at `:132-133` and the `aria-label`.
- [x] Wire the route into `src/components/Dashboard.tsx`.
  - Call `useRoadRoute(mode === "trip" && !sameEndpoints ? from : null, mode === "trip" && !sameEndpoints ? to : null)` unconditionally, right after `:217`.
  - Pass `road` into `mapRoute` (`:400-403`).
  - The header at `:698-699` shows `{km} km by road · {h} h {mm} min` when the route is ready, and `{km} km direct` otherwise.
  - On failure, render `Road route unavailable — using straight-line distances.` under the header.
- [x] Add an `osrm` attribution at `src/server/domain/attribution.ts` and list it in `ALWAYS_ACTIVE` (`:84-92`).
  - text: `Road routes: OSRM on FOSSGIS servers, © OpenStreetMap contributors — report a map error`
  - url: `https://www.openstreetmap.org/fixthemap`
  - licence: `ODbL`
  - `commercialUseRestricted: true`
- [x] Add a "Configuration" section at `README.md`. It documents `ROUTING_URL` (the default, `off`, the FOSSGIS terms, and that the 1 req/s spacing holds per server instance) and the existing `OVERPASS_ENDPOINTS`.

**Automated Verification**:

- [x] Unit tests in `src/lib/route.test.ts` pass. `routeQuery` → `parseRouteQuery` round-trips, and parsing rejects a missing parameter, `NaN`, a point outside Switzerland and identical endpoints.
- [x] Unit tests in `src/server/routing/osrm.test.ts` pass. Each test builds a fresh `createRouter` with a stub `fetch`, `intervalMs: 0` and `timeoutMs: 50`, and the stubs reject when `init.signal` aborts. The cases:
  - `parseOsrmRoute` maps a 3-point inline body with lat and lon swapped.
  - `parseOsrmRoute` throws on `code: "NoRoute"` and on a missing `routes`.
  - `thinLine` keeps both ends and drops points closer than 150 m.
  - `route` sends the `User-Agent` header and a lon,lat URL with `overview=full&geometries=geojson`.
  - A repeated pair does not refetch.
  - A 503 and a stub that never resolves both reject, the latter via the 50 ms timeout. Neither result is cached, so a retry fetches again.
  - `baseUrl: "off"` rejects with no fetch.
  - With `maxWaiting: 1` and a held first call, a third concurrent call rejects with `router busy`. The test then releases the stub and awaits the rest, so no timers are left behind.
  - With `intervalMs: 30`, two uncached calls start ≥30 ms apart.
- [x] Existing market tests still pass after the `USER_AGENT` move: `npm test`.
- [x] Type checks pass: `npm run typecheck`.
- [x] Lints pass: `npm run lint`.
- [x] Dead-code check passes: `npm run analyze`.
- [x] Production build passes: `npm run build`.
- [x] Endpoint smoke tests pass with `npm run dev` running and live network:
  - `curl -s 'http://localhost:3000/api/road-route?fromLat=47.3769&fromLon=8.5417&toLat=46.0037&toLon=8.9511' | node -e 'const r=JSON.parse(require("fs").readFileSync(0));process.exit(r.distanceKm>195&&r.distanceKm<215&&r.line.length>500?0:1)'` exits 0.
  - `curl -s -o /dev/null -w '%{http_code}' 'http://localhost:3000/api/road-route?fromLat=0&fromLon=0&toLat=46&toLon=9'` prints `400`.
- [x] Browser check (Claude in Chrome) passes with `npm run dev`:
  - Open `http://localhost:3000`, click "Between two places", and keep Zürich → Lugano.
  - Within 10 s, the header subtitle matches `/^\d+ km by road · \d h \d{2} min/`.
  - The map contains a `path.road-route` and a `path.direct-line`.
  - The footer contains "report a map error".
  - Screenshot `phase1-road-route.png`.
- [x] Fallback browser check passes. Restart with `ROUTING_URL=off npm run dev`; in the same flow:
  - The note `Road route unavailable — using straight-line distances.` is visible.
  - The header matches `/^\d+ km direct/`.
  - There is no `path.road-route`.
  - Screenshot `phase1-fallback.png`.

---

## Phase 2 — Stops are measured against the road

[Dependencies: **Phase 1**]

When the road route is available, every trip number is measured on the road:
- the corridor gate, with estimated detour = 2 × off-route distance;
- progress along the route;
- the 20 km break window and the short-trip rule;
- the slider's km label;
- the break marker.

All of these use the same km as the header. The straight-line path stays verbatim as the fallback. Cards show the off-route distance and label detours `est.`.

**Tasks**:

- [x] Add `scripts/record-route-fixture.mjs`. It fetches Zürich (47.3769, 8.5417) → Lugano (46.0037, 8.9511) from the FOSSGIS router with `overview=full&geometries=geojson` and `USER_AGENT`. It writes `{ code, routes: [{ distance, duration, geometry }] }` to `src/server/routing/fixtures/zurich-lugano.osrm.json`, with coordinates rounded to 5 decimals. Run it once and commit the fixture.
- [x] Add `indexRoute(route): RouteIndex` at `src/lib/route.ts`.
  - It holds the line, the cumulative km per vertex and a bounding box.
  - Cumulative km are scaled by `route.distanceKm / geometricLength`, so `totalKm === route.distanceKm` and the header, progress and slider all use one number.
- [x] Add `projectOntoRoute(index, point): { alongKm; offKm }` at `src/lib/route.ts`. It uses the nearest segment, measured in a local equirectangular projection, with the segment parameter clamped to [0, 1]. `offKm` is unscaled; `alongKm` is in scaled km.
- [x] Add `pointAlong(index, fraction): LatLon` at `src/lib/route.ts`, interpolating at `fraction × totalKm` with the fraction clamped to [0, 1].
- [x] Add `measureStations(stations, basis)` at `src/lib/trip.ts`.
  - `basis` is `{ kind: "road"; index } | { kind: "straight"; from; to }`.
  - It returns `{ routeKm, byId: Map<id, { detourKm, offRouteKm: number | null, progress }> }`.
  - For road, it pre-filters by the bounding box widened by 30 km, then sets `detourKm = 2 × offKm` and `progress = alongKm / totalKm`.
  - For straight, it uses `detourKm` and `routeProgress` from `geo.ts`, with `offRouteKm: null`.
- [x] Add `isStop(measure, routeKm, { maxDetourKm, stopAt, windowKm })` and `selectStops(stations, measured, opts)` at `src/lib/trip.ts`.
  - This moves the logic of `Dashboard.tsx:234-266`: the detour gate, `shortTrip = routeKm ≤ 2 × windowKm`, and a window of `windowKm / routeKm`.
  - `selectStops` returns `{ candidates, detours, progress, offRoute, shortTrip, corridorCount, routeKm }`.
- [x] Replace the trip memo at `src/components/Dashboard.tsx:227-268` with two memos.
  - `measured` is keyed on `(roadRoute.state === "ready" ? route : null, from, to, byConnector)`.
  - `trip` is keyed on `(measured, maxDetour, stopAt)` and calls `selectStops`.
  - `trip.basis` is `"road"` or `"straight"`, and `directKm` is renamed `routeKm` wherever it is used (`:250-251`, `:298`, `:542`, `:699`).
- [x] Update the trip copy at `src/components/Dashboard.tsx`.
  - The slider label (`:541-543`) uses `routeKm`.
  - On road basis, the detour help (`:594-596`) reads `Extra driving to reach the station and get back on the route, estimated as twice its distance off the road.`
  - On road basis, the results line (`:698-699`) reads `≤ {maxDetour} km detour`.
  - On road basis, the footnote (`:828-833`) reads `Road route © OpenStreetMap contributors, via OSRM (FOSSGIS). Detours marked est. are twice the distance off the route.`
  - On straight basis, all of these keep today's text.
- [x] Update the map drawing at `src/components/ResultsMap.tsx:129-146`.
  - With `road`, place the break marker at `pointAlong(indexRoute(...), stopAt)` and skip `direct-line`.
  - Without `road`, draw as today.
  - Update the `MapRoute.stopAt` doc (`:21`).
- [x] Add an `offRouteKm?: number | null` prop at `src/components/StationCard.tsx:157-181`. When it is a number, render an `{x} km off route` chip after the detour chip (`:231-241`), and render the detour as `+{d} km detour est.`.
- [x] Change the hint at `src/lib/ranking.ts:48` to `Less extra driving to reach the station ranks first`.
- [x] Update the doc at `src/lib/geo.ts:18-21` to say it is the fallback when no road route is available.

**Automated Verification**:

- [x] Unit tests in `src/lib/route.test.ts` pass:
  - On a synthetic 2-segment line, a point beside a segment's midpoint gets the expected `alongKm`/`offKm` (±0.05 km).
  - A point beyond either end clamps to 0 or `totalKm`.
  - `pointAlong(index, 0.5)` sits at half the cumulative length.
  - Scaling makes `totalKm` equal `distanceKm` exactly.
- [x] Unit tests in `src/server/routing/zurich-lugano.test.ts` pass. They parse the fixture with `parseOsrmRoute` and index it:
  - `distanceKm` is within 205.6 ± 1.
  - The unscaled geometric length is within 3% of `distanceKm`.
  - Göschenen (46.667, 8.586) has `offKm < 2` and `0.35 < progress < 0.65`.
  - Bellinzona (46.193, 9.017) has `progress > 0.8`.
  - Zürich HB (47.378, 8.540) has `progress < 0.05`.
- [x] Unit tests in `src/lib/trip.test.ts` pass:
  - On an L-shaped synthetic road, a station near the straight chord but 20 km from the road is excluded on road basis and included on straight basis. A station beside the road is included on both.
  - On a 100 km road with the break at 0.5 and a 20 km window, `progress` 0.3 is in and 0.29 is out.
  - `shortTrip` flips at `routeKm = 40`.
  - Straight basis reproduces today's Dashboard results exactly, checked against golden values computed with `geo.ts`, for Zürich → Lugano and a fixed station set.
- [x] Existing ranking and refresh tests pass unchanged: `npm test`.
- [x] Type checks, lints, the dead-code check and the build pass: `npm run typecheck && npm run lint && npm run analyze && npm run build`.
- [x] Browser check (Claude in Chrome) passes with Zürich → Lugano and the router up:
  - The break label reads `≈ 103 km after Zürich` (±3).
  - The first card contains `km off route` and `detour est.`.
  - A `path.road-route` exists and no `path.direct-line` does.
  - Dragging the break slider to 20% changes the label to `≈ 41 km` (±2) and changes the result count.
  - Screenshot `phase2-road-measured.png`.
- [x] Fallback browser check passes with `ROUTING_URL=off`:
  - Cards contain `km detour` but not `off route`.
  - The footnote contains `straight-line`.
  - The break label at 50% reads `≈ 78 km` (±2).
  - Screenshot `phase2-fallback.png`.

---

## Phase 3 — Live refresh follows the road corridor

[Dependencies: **Phase 2**]

In trip mode, "Refresh live data" rebuilds exactly the corridor the client is using. The client sends its basis. The server uses the road only when asked, and reports what it actually used. The client merges using the route index it captured when the button was clicked.

**Tasks**:

- [x] Add `basis: "road" | "straight"` to the trip `RefreshScope` at `src/lib/refresh.ts:10-21`.
  - `scopeToParams` writes it and `scopeFromParams` reads it. A missing or unknown value parses as `"straight"`.
  - Add `routeBasis?: "road" | "straight"` to `RefreshResponse` (`:23-32`).
- [x] Change `inScope(scope, station, index?: RouteIndex)` at `src/lib/refresh.ts:40-49`.
  - For trip scopes with an `index`, measure with `projectOntoRoute` and delegate to `isStop` from `trip.ts`.
  - Without an index, keep the current logic.
  - Update the doc at `:34-39`.
- [x] Change `applyRefresh(current, response, scope, index?)` at `src/lib/refresh.ts:127-136`. Pass `index` to `inScope` only when `response.routeBasis === "road"`.
- [x] Update the trip scope handling at `src/app/api/refresh/route.ts:80-82`.
  - When `scope.basis === "road"`, call `getRouter().route(scope.from, scope.to)` and `indexRoute`.
  - If that fails, push `route: {message}` to `errors` and use the straight scope.
  - Set `routeBasis` in the body (`:110-117`).
- [x] Update the trip scope in `src/components/Dashboard.tsx:289-301` to set `basis: trip.basis`.
  - In `refresh()` (`:304-330`), capture the road `RouteIndex` together with `scope.scope` before the `await`, and pass that captured index to `applyRefresh`.
  - A `route: …` error flows through `liveGaps` (`:83-88`) like the other facets.

**Automated Verification**:

- [x] Unit tests in `src/lib/refresh.test.ts` pass:
  - The scope round-trips with `basis`, and a missing `basis` parses as `"straight"`.
  - With a synthetic road index, a station near the chord but off the road is out of scope, and one near the road but off the chord is in.
  - With `routeBasis: "road"` and an index, `applyRefresh` keeps a current station outside the road corridor and replaces one inside it. A current in-corridor station missing from the response is dropped.
  - With `routeBasis` missing or `"straight"`, the index is ignored and the result equals today's behaviour.
  - All five existing tests still pass.
- [x] Type checks, lints, the dead-code check and the build pass: `npm run typecheck && npm run lint && npm run analyze && npm run build`.
- [x] Browser check (Claude in Chrome) passes with Zürich → Lugano, connector "All" and the router up:
  - Click "Refresh live data" and wait up to 90 s for `Live for Zürich → Lugano since`.
  - The status line's `({n} stations` equals the result count shown in the header.
  - Screenshot `phase3-refresh.png`.

---

## Phase 4 — Exact road detours for the shortlist

[Dependencies: **Phase 2**. It also changes the Phase 3 browser check: stations dropped for an exact detour over the cap are still rebuilt by the refresh, which uses the estimate corridor. So after this phase the status count can exceed the list count.]

For the stations in the break window, up to 98 with the smallest estimated detour get their true road detour, `d(A,s) + d(s,B) − d(A,B)`. All three distances come from one OSRM table call through `/api/road-detours`. Cards say `by road` for these stations and `est.` for the rest. A station whose true detour exceeds the cap leaves the list. If the call fails, the estimates stay silently.

**Tasks**:

- [x] Add `parseOsrmTable(json): (number | null)[][]` at `src/server/routing/osrm.ts`. It requires `code === "Ok"` and returns `distances` in metres, keeping `null` for unreachable cells.
- [x] Add `detours(from, to, stops: {id, lat, lon}[]): Promise<Map<string, number>>` to the `createRouter` instance at `src/server/routing/osrm.ts`.
  - It rejects more than 98 stops.
  - It serves already-measured stops from a per-pair cache (24 h, up to 5,000 entries) and requests only the rest.
  - The request is `table/v1/driving/{A};{s1…sN};{B}?sources=0;1;…;N&destinations=1;…;N+1&annotations=distance`. That is N + 2 ≤ 100 coordinates and an (N+1) × (N+1) matrix.
  - It reads `d(A,sᵢ)` from row 0, `d(sᵢ,B)` from the last column, and `d(A,B)` from row 0's last column.
  - The detour is clamped to ≥ 0, and a stop is omitted when either of its legs is `null`.
  - The call uses the same queue, user agent and timeout as `route`.
- [x] Add a `POST` handler at `src/app/api/road-detours/route.ts`.
  - The body is `{ from, to, stops }`. Endpoints follow the `parseRouteQuery` rules; there must be 1–98 stops, each inside Switzerland with finite coordinates and an id that is a non-empty string of at most 200 characters. Anything else gets 400.
  - It returns `{ detours: Record<id, km> }`, with errors as in Phase 1.
- [x] Add `useRoadDetours(pairKey: string | null, shortlist)` at `src/components/useRoadDetours.ts`.
  - It runs only on road basis, debounced 400 ms after the shortlist changes.
  - It keeps at most one request in flight: a newer shortlist waits for the current request and is then sent without the ids already measured.
  - Results accumulate in state keyed by `pairKey`, so another pair's values are never returned.
  - It calls setState only in async callbacks.
  - The shortlist is the up to 98 candidates with the smallest estimated detour.
- [x] Add `mergeDetours(selection, exact, maxDetourKm)` at `src/lib/trip.ts`.
  - Exact values replace the estimates in `detours`, and a `detourBasis: Map<id, "road" | "est">` records which is which.
  - Candidates whose exact detour exceeds `maxDetourKm` are dropped from every map.
  - Document that a service area on the opposite carriageway legitimately gets a large detour, because you cannot cross a motorway.
- [x] Apply `mergeDetours` after `selectStops` in the `trip` memo at `src/components/Dashboard.tsx`, and pass `detourBasis` to the cards.
- [x] Add a `detourBasis?: "road" | "est"` prop at `src/components/StationCard.tsx`. It renders `+{d} km detour by road` or `+{d} km detour est.`.
- [x] Change the road-basis footnote at `src/components/Dashboard.tsx` (the Phase 2 copy) to `… Detours marked by road are measured on the road network; est. are twice the distance off the route.`

**Automated Verification**:

- [x] Unit tests in `src/server/routing/osrm.test.ts` pass, each on a fresh `createRouter`:
  - `detours` issues exactly one table request, with N+2 coordinates in lon,lat order, `sources=0;…;N` and `destinations=1;…;N+1`.
  - The arithmetic is correct against a stubbed 3×3 matrix.
  - A `null` leg is omitted and a negative result clamps to 0.
  - 99 stops reject without fetching.
  - A repeat call with 3 new stops out of 10 sends only those 3.
  - A failure is not cached.
- [x] Unit tests in `src/lib/trip.test.ts` pass. `mergeDetours` replaces estimates for measured ids and marks them `road`, leaves the others as `est`, and drops a station whose exact detour exceeds the cap from every map.
- [x] Endpoint validation smoke test passes with the dev server running: `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"from":{"lat":47.3769,"lon":8.5417},"to":{"lat":46.0037,"lon":8.9511},"stops":[]}' http://localhost:3000/api/road-detours` prints `400`.
- [x] Type checks, lints, the dead-code check and the build pass: `npm run typecheck && npm run lint && npm run analyze && npm run build`.
- [x] Browser check (Claude in Chrome) passes with Zürich → Lugano and the router up:
  - Polling for up to 15 s, at least one of the first 5 cards contains `detour by road`.
  - After dragging the detour slider to 5 km, every remaining `by road` value is ≤ 5.0.
  - Screenshot `phase4-exact-detours.png`.
- [x] Phase 3 browser check, re-run: the status count is ≥ the header result count.

---

## Phase 5 — Manual Acceptance (human verification gate)

There are no implementation tasks: every build phase above was verified automatically. This is the one human pass.

**Manual Verification**:

- [ ] The road line reads well on the map.
   1. Open trip mode for Zürich → Lugano and for Genève → St. Gallen.
   2. Judge whether the road's weight and colour stand out from the tiles without hiding the station dots, and whether the break marker is easy to spot on the road.
- [ ] Moving the charging break feels right on a winding route.
   1. Open Chur → Bellinzona, which goes via San Bernardino.
   2. Drag the break slider end to end. The marker should follow the road smoothly, and the list should update without noticeable lag.
- [ ] The station cards are not cluttered.
   1. Look at the first page of cards on desktop and at about 390 px wide.
   2. Judge whether the detour, off-route and "% of the way" chips read as one clear line.
- [ ] Motorway service areas get the right detours.
   1. In Zürich → Lugano, find a motorway service-area station on the A2 in the results.
   2. The one on your side of the motorway should show a small `by road` detour.
   3. The one on the opposite carriageway should show a large detour, or drop out under a tight cap. If it shows a large detour even on the right side, the station's coordinates are snapping to the wrong carriageway. Note that for follow-up.
- [ ] Stops make sense on routes far from the straight line.
   1. Try Bern → Brig, where the route may use the Lötschberg car train, and Lugano → St. Moritz.
   2. Judge whether the suggested stops are places you would actually drive to.
- [ ] The wording is clear when routing is down.
   1. Run with `ROUTING_URL=off`.
   2. Read the fallback note and footnote as a first-time user would. It should be clear why the numbers are straight-line.

---

## References

- Research document: none in `docs/agents/research/`. Router research was done in-session on 2026-09-10.
  - FOSSGIS OSRM `https://routing.openstreetmap.de/routed-car`:
    - Terms: at most 1 request/second, a user agent that identifies the app, no uptime guarantee, and commercial use only if not a "substantial part" of the offering.
    - Sources: https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/ and https://routing.openstreetmap.de/about.html
  - OSRM HTTP API, for the route and table parameters and the response fields: https://github.com/Project-OSRM/osrm-backend/blob/master/docs/http.md
  - Measured results:
    - A full 100×100 table works; 101×101 returns `TooBig`.
    - Zürich→Lugano is 205.6 km and 159 min, with 5,019 points at `overview=full`.
  - swisstopo / geo.admin.ch: no car-routing API (https://docs.geo.admin.ch/).
- PRD: none.
- Plan review: an independent red-team pass on 2026-09-10. Its findings are folded in:
  - state keyed by pair in the hooks;
  - a refresh basis carried on the wire, with the route index captured at click time;
  - a testable router factory;
  - the hook placed outside the `trip` memo;
  - a single road-km figure;
  - a single table call;
  - the `inSwitzerland` move;
  - the fixture recorded in Phase 2;
  - queue depth and `globalThis`;
  - polling timeouts in the browser checks.
- Related code:
  - `src/lib/geo.ts:18-32`
  - `src/components/Dashboard.tsx`: `:60-74`, `:83-88`, `:165-167`, `:213-217`, `:227-268`, `:281-330`, `:400-403`, `:531-598`, `:697-703`, `:828-833`
  - `src/components/ResultsMap.tsx`: `:18-23`, `:88-146`
  - `src/lib/refresh.ts`: `:10-49`, `:73-77`, `:127-158`
  - `src/lib/refresh.test.ts`
  - `src/app/api/refresh/route.ts:80-117`
  - `src/lib/ranking.ts`: `:39-52`, `:228-251`
  - `src/components/StationCard.tsx`: `:157-181`, `:231-241`
  - `src/server/market/news.ts`: `:32`, `:101-109`
  - `src/server/market/market.test.ts:79-100`
  - `src/server/domain/attribution.ts:84-92`
  - Next.js route handler caching: `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`. `GET` handlers are uncached by default.
