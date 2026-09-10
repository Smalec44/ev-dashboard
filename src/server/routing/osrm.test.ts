import assert from "node:assert/strict";
import { test } from "node:test";
import type { LatLon } from "../../lib/types.ts";
import { USER_AGENT } from "../http.ts";
import {
  RoutingUnavailableError,
  createRouter,
  parseOsrmRoute,
  parseOsrmTable,
  thinLine,
} from "./osrm.ts";

const zurich = { lat: 47.3769, lon: 8.5417 };
const lugano = { lat: 46.0037, lon: 8.9511 };
const bern = { lat: 46.948, lon: 7.4474 };

/** Three points about 1.1 km apart, north along one meridian. */
const LINE: LatLon[] = [
  { lat: 47, lon: 8 },
  { lat: 47.01, lon: 8 },
  { lat: 47.02, lon: 8 },
];

/** An OSRM route answer; `points` are written back in GeoJSON's [lon, lat] order. */
function osrmBody(points: LatLon[], distance = 2500, duration = 180) {
  return {
    code: "Ok",
    routes: [
      {
        distance,
        duration,
        geometry: { type: "LineString", coordinates: points.map((p) => [p.lon, p.lat]) },
      },
    ],
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Three stops down the Reuss valley. */
const STOPS = [
  { id: "a", lat: 46.8, lon: 8.6 },
  { id: "b", lat: 46.7, lon: 8.6 },
  { id: "c", lat: 46.6, lon: 8.6 },
];

/** `count` stops from `first` on, a kilometre or so apart. */
const stopsAt = (count: number, first = 0) =>
  Array.from({ length: count }, (_, i) => ({ id: `s${first + i}`, lat: 46.5 + (first + i) / 100, lon: 8.6 }));

/**
 * An OSRM table answer: sources are the start and the stops, destinations the
 * stops and the end. `toStop` is start → each stop, `onward` each stop → end,
 * in metres; the stop-to-stop cells no detour reads are 0.
 */
function tableBody(direct: number, toStop: (number | null)[], onward: (number | null)[]) {
  const others = new Array<number>(toStop.length).fill(0);
  return { code: "Ok", distances: [[...toStop, direct], ...onward.map((metres) => [...others, metres])] };
}

/** The coordinates of a table request, start and end included. */
const coordinatesOf = (url: string) => new URL(url).pathname.split("/").at(-1)?.split(";") ?? [];

/**
 * A fetch stand-in that answers from `respond`, records every call, and gives
 * up when the signal aborts — as the real fetch does, and as a timeout test
 * needs, since a stub that ignores the signal would hang the test for good.
 */
function stubFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined; at: number }[] = [];
  const fetchStub = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init, at: Date.now() });
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      });
      Promise.resolve(url).then(respond).then(resolve, reject);
    });
  };
  return { calls, fetch: fetchStub };
}

/** A router of its own per test: queues and caches must not leak between tests. */
function router(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof createRouter>[0]> = {}) {
  return createRouter({
    fetch: fetchImpl,
    baseUrl: "https://router.test/routed-car",
    intervalMs: 0,
    timeoutMs: 50,
    ...overrides,
  });
}

test("an OSRM answer becomes a RoadRoute, lat and lon swapped back", () => {
  assert.deepEqual(parseOsrmRoute(osrmBody(LINE, 2500, 180)), {
    distanceKm: 2.5,
    durationMin: 3,
    line: LINE,
  });
});

test("an OSRM refusal or a body without a route is an error, not an empty route", () => {
  assert.throws(
    () => parseOsrmRoute({ code: "NoRoute", message: "Impossible route between points" }),
    /NoRoute: Impossible route/,
  );
  assert.throws(() => parseOsrmRoute({ code: "Ok" }), /without a route/);
  assert.throws(() => parseOsrmRoute(null), /JSON object/);
});

test("thinning drops points within 150 m of the last one kept, but never the ends", () => {
  // 0.0009° of latitude is 100 m; 0.0018° is 200 m.
  const thinned = thinLine([
    { lat: 47, lon: 8 },
    { lat: 47.00045, lon: 8 },
    { lat: 47.0009, lon: 8 },
    { lat: 47.0018, lon: 8 },
    { lat: 47.00189, lon: 8 },
  ]);
  assert.deepEqual(
    thinned.map((p) => p.lat),
    [47, 47.0018, 47.00189],
  );
});

test("a route request names the app and asks for the full line, lon before lat", async () => {
  const { calls, fetch } = stubFetch(() => json(osrmBody(LINE)));
  await router(fetch).route(zurich, lugano);
  const [call] = calls;
  assert.ok(call);
  const url = new URL(call.url);
  assert.equal(url.origin, "https://router.test");
  assert.equal(url.pathname, "/routed-car/route/v1/driving/8.5417,47.3769;8.9511,46.0037");
  assert.equal(url.searchParams.get("overview"), "full");
  assert.equal(url.searchParams.get("geometries"), "geojson");
  assert.equal(new Headers(call.init?.headers).get("user-agent"), USER_AGENT);
});

test("the same pair is fetched once, whether asked in turn or at the same time", async () => {
  const { calls, fetch } = stubFetch(() => json(osrmBody(LINE)));
  const routing = router(fetch);
  await Promise.all([routing.route(zurich, lugano), routing.route(zurich, lugano)]);
  await routing.route(zurich, lugano);
  assert.equal(calls.length, 1);
});

test("an upstream error or a timeout rejects, and is not cached", async () => {
  let answer: () => Response | Promise<Response> = () => json({ code: "Busy" }, 503);
  const { calls, fetch } = stubFetch(() => answer());
  const routing = router(fetch);

  await assert.rejects(routing.route(zurich, lugano), /503 \(Busy\)/);
  answer = () => new Promise<Response>(() => undefined);
  await assert.rejects(routing.route(zurich, lugano), /within 50 ms/);
  answer = () => json(osrmBody(LINE));
  const route = await routing.route(zurich, lugano);
  assert.equal(route.distanceKm, 2.5);
  assert.equal(calls.length, 3);
});

test("routing switched off refuses without calling out", async () => {
  const { calls, fetch } = stubFetch(() => json(osrmBody(LINE)));
  await assert.rejects(router(fetch, { baseUrl: "off" }).route(zurich, lugano), RoutingUnavailableError);
  await assert.rejects(
    router(fetch, { baseUrl: "off" }).detours(zurich, lugano, STOPS),
    RoutingUnavailableError,
  );
  assert.equal(calls.length, 0);
});

test("beyond the waiting limit a call fails fast instead of queueing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { fetch } = stubFetch(() => json(osrmBody(LINE)));
  const routing = router(fetch, { intervalMs: 10_000, maxWaiting: 1 });

  await routing.route(zurich, lugano); // Nothing ran before it, so it starts at once.
  const waiting = routing.route(zurich, bern); // Must wait out the interval.
  await assert.rejects(routing.route(bern, lugano), /router busy/);
  t.mock.timers.tick(10_000);
  assert.equal((await waiting).distanceKm, 2.5);
});

test("upstream calls start at least the interval apart", async () => {
  const { calls, fetch } = stubFetch(() => json(osrmBody(LINE)));
  const routing = router(fetch, { intervalMs: 40 });
  await Promise.all([routing.route(zurich, lugano), routing.route(zurich, bern)]);
  const [first, second] = calls;
  assert.ok(first && second);
  // A few ms of slack for timer granularity, not for the queue.
  assert.ok(second.at - first.at >= 35, `started ${second.at - first.at} ms apart`);
});

test("an OSRM table keeps unreachable cells as null, and a refusal is an error", () => {
  assert.deepEqual(parseOsrmTable({ code: "Ok", distances: [[1200, null], [0, 5.5]] }), [
    [1200, null],
    [0, 5.5],
  ]);
  assert.throws(() => parseOsrmTable({ code: "TooBig", message: "Too many table coordinates" }), /TooBig/);
  assert.throws(() => parseOsrmTable({ code: "Ok" }), /without distances/);
});

test("a detour table is one request: start, every stop, end, lon before lat", async () => {
  const { calls, fetch } = stubFetch(() => json(tableBody(100_000, [1, 1, 1], [1, 1, 1])));
  await router(fetch).detours(zurich, lugano, STOPS);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call);
  const url = new URL(call.url);
  assert.equal(
    url.pathname,
    "/routed-car/table/v1/driving/8.5417,47.3769;8.6,46.8;8.6,46.7;8.6,46.6;8.9511,46.0037",
  );
  assert.equal(url.searchParams.get("sources"), "0;1;2;3");
  assert.equal(url.searchParams.get("destinations"), "1;2;3;4");
  assert.equal(url.searchParams.get("annotations"), "distance");
  assert.equal(new Headers(call.init?.headers).get("user-agent"), USER_AGENT);
});

test("a detour is the two legs through the stop less the direct drive", async () => {
  const { fetch } = stubFetch(() =>
    json(tableBody(100_000, [10_000, 20_000, 30_000], [95_000, 90_000, 72_500])),
  );
  const detours = await router(fetch).detours(zurich, lugano, STOPS);
  assert.deepEqual([...detours], [["a", 5], ["b", 10], ["c", 2.5]]);
});

test("a stop with no road to it is left out, and a detour never goes below zero", async () => {
  const { fetch } = stubFetch(() =>
    json(tableBody(100_000, [null, 20_000, 30_000], [95_000, null, 60_000])),
  );
  const detours = await router(fetch).detours(zurich, lugano, STOPS);
  assert.deepEqual([...detours], [["c", 0]]);
});

test("more stops than one table holds are refused without asking", async () => {
  const { calls, fetch } = stubFetch(() => json(tableBody(1, [], [])));
  await assert.rejects(router(fetch).detours(zurich, lugano, stopsAt(99)), /at most 98/);
  assert.equal(calls.length, 0);
});

test("stops measured before are not asked again", async () => {
  const { calls, fetch } = stubFetch((url) => {
    const stops = coordinatesOf(url).length - 2;
    return json(tableBody(1500, new Array<number>(stops).fill(1000), new Array<number>(stops).fill(1000)));
  });
  const routing = router(fetch);
  await routing.detours(zurich, lugano, stopsAt(7));
  const all = await routing.detours(zurich, lugano, stopsAt(10));
  assert.equal(all.size, 10);
  assert.equal(all.get("s9"), 0.5);
  const second = calls[1];
  assert.ok(second);
  assert.deepEqual(
    coordinatesOf(second.url).slice(1, -1),
    stopsAt(3, 7).map((s) => `${s.lon},${s.lat}`),
  );
  // Everything known by now: answered without a request at all.
  await routing.detours(zurich, lugano, stopsAt(10));
  assert.equal(calls.length, 2);
});

test("a failed detour table is not remembered", async () => {
  let answer = () => json({ code: "Busy" }, 503);
  const { calls, fetch } = stubFetch(() => answer());
  const routing = router(fetch);
  await assert.rejects(routing.detours(zurich, lugano, STOPS), /503 \(Busy\)/);
  answer = () => json(tableBody(100_000, [10_000, 20_000, 30_000], [95_000, 90_000, 72_500]));
  assert.equal((await routing.detours(zurich, lugano, STOPS)).size, 3);
  assert.equal(calls.length, 2);
});
