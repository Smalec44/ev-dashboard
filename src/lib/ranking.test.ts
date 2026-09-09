import { test } from "node:test";
import assert from "node:assert/strict";
import { rankStations } from "./ranking.ts";
import type { ChargingStation } from "./types.ts";

function station(
  id: string,
  overrides: Partial<ChargingStation> = {},
): ChargingStation {
  return {
    id,
    lat: 47,
    lon: 8,
    name: id,
    operator: "Someone",
    city: "Somewhere",
    canton: "ZH",
    address: "Somewhere",
    connectorType: "AC",
    maxPowerKw: 22,
    stalls: 2,
    pricePerKwh: 0.45,
    food: [],
    ...overrides,
  };
}

const dc = station("dc", { connectorType: "DC", maxPowerKw: 150, pricePerKwh: 0.6 });
const ac = station("ac", { maxPowerKw: 22, pricePerKwh: 0.4 });
const slow = station("slow", { maxPowerKw: 11, pricePerKwh: 0.38 });

const scoreOf = (id: string, pool: ChargingStation[]) =>
  rankStations(pool, { criteria: ["speed", "price"], foodThreshold: 0 }).find(
    (r) => r.station.id === id,
  )!.score;

test("a station's score does not depend on which other stations are listed", () => {
  // The regression this guards: scores were normalised over the visible pool,
  // so a DC site's score changed when the connector filter let AC sites in.
  assert.equal(scoreOf("dc", [dc]), scoreOf("dc", [dc, ac, slow]));
  assert.equal(scoreOf("ac", [ac, slow]), scoreOf("ac", [dc, ac, slow]));
});

test("speed is scored on a log scale, capped at 350 kW", () => {
  const [top, fast, mid, wall, dead] = rankStations(
    [
      station("top", { maxPowerKw: 600 }),
      station("fast", { maxPowerKw: 350 }),
      station("mid", { maxPowerKw: 50 }),
      station("wall", { maxPowerKw: 11 }),
      station("dead", { maxPowerKw: 0 }),
    ],
    { criteria: ["speed"], foodThreshold: 0 },
  ).map((r) => r.score);
  assert.equal(top, 100);
  assert.equal(fast, 100);
  assert.equal(dead, 0);
  assert.ok(wall > 0 && wall < mid && mid < fast);
  // Doubling the power is worth the same step wherever it happens.
  const step = (kw: number) =>
    rankStations([station("x", { maxPowerKw: kw })], {
      criteria: ["speed"],
      foodThreshold: 0,
    })[0].score;
  assert.ok(Math.abs(step(22) - step(11) - (step(88) - step(44))) <= 1);
});

test("nearby falls to zero at the search radius, and stays there beyond it", () => {
  const ranked = rankStations([station("near"), station("edge"), station("far")], {
    criteria: ["nearby"],
    foodThreshold: 0,
    distanceKm: new Map([
      ["near", 0],
      ["edge", 5],
      ["far", 40],
    ]),
    radiusKm: 5,
  });
  const by = Object.fromEntries(ranked.map((r) => [r.station.id, r.score]));
  assert.deepEqual(by, { near: 100, edge: 0, far: 0 });
});

test("the stop point slider moves which station counts as 'in the middle'", () => {
  const early = station("early");
  const late = station("late");
  const progress = new Map([
    ["early", 0.25],
    ["late", 0.75],
  ]);
  const middleScore = (stopAt: number, id: string) =>
    rankStations([early, late], {
      criteria: ["middle"],
      foodThreshold: 0,
      routeProgress: progress,
      stopAt,
    }).find((r) => r.station.id === id)!.breakdown.middle;

  assert.equal(middleScore(0.25, "early"), 100);
  assert.equal(middleScore(0.25, "late"), 0);
  assert.equal(middleScore(0.75, "late"), 100);
  // Left alone, the target is halfway: both sit a quarter off and tie.
  assert.equal(middleScore(0.5, "early"), middleScore(0.5, "late"));
});

test("live status replaces the stall count in the availability score", () => {
  const eight = station("eight", { stalls: 8 });
  const full = station("full", {
    stalls: 8,
    live: { available: 0, busy: 7, outOfService: 1, unknown: 0, at: "t" },
  });
  const half = station("half", {
    stalls: 8,
    live: { available: 3, busy: 4, outOfService: 0, unknown: 1, at: "t" },
  });
  const availability = (id: string) =>
    rankStations([eight, full, half], { criteria: ["availability"], foodThreshold: 0 }).find(
      (r) => r.station.id === id,
    )!.breakdown.availability;
  assert.equal(availability("eight"), 100);
  assert.equal(availability("full"), 0);
  // Unknown counts as free: 8 − 4 busy − 0 down = 4 of the 8 that mean "plenty".
  assert.equal(availability("half"), 50);
});
