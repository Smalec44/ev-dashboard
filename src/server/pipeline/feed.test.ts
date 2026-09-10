import assert from "node:assert/strict";
import { test } from "node:test";
import { attachLiveStatus, buildSites, publishSite, type FeedRecord } from "./feed.ts";
import { parseMaxStay } from "./overpass.ts";

/** Element at `index`, failing the test loudly rather than typing as undefined. */
function at<T>(list: T[], index: number): T {
  const item = list[index];
  assert.ok(item !== undefined, `no element at ${index}`);
  return item;
}

function record(overrides: Partial<FeedRecord>): FeedRecord {
  return {
    EvseID: "CH*XXX*E1",
    ChargingStationId: "CH*XXX*P1",
    Accessibility: "Free publicly accessible",
    GeoCoordinates: { Google: "47.3769 8.5417" },
    Address: { Street: "Bahnhofstrasse 1", PostalCode: "8001", City: "Zurich" },
    ChargingStationNames: [{ lang: "de", value: "Bahnhof" }],
    ChargingFacilities: [{ power: 22, powertype: "AC_3_PHASE" }],
    operator: "Move",
    ...overrides,
  };
}

test("charge points sharing a station id become one site with that many stalls", () => {
  const sites = buildSites([
    record({ EvseID: "CH*XXX*E1" }),
    record({ EvseID: "CH*XXX*E2", ChargingFacilities: [{ power: 150, powertype: "DC" }] }),
  ]);
  assert.equal(sites.length, 1);
  assert.equal(at(sites, 0).stalls, 2);
  assert.equal(at(sites, 0).connectorType, "DC");
  assert.equal(at(sites, 0).maxPowerKw, 150);
  assert.deepEqual(at(sites, 0).evseIds, ["CH*XXX*E1", "CH*XXX*E2"]);
  // The feed's spelling is canonicalised to the searchable region name.
  assert.equal(at(sites, 0).city, "Zürich");
  assert.equal(at(sites, 0).canton, "ZH");
});

test("same-named records a few metres apart are one site, further apart two", () => {
  const twins = buildSites([
    record({ ChargingStationId: "CH*XXX*P9", EvseID: "E9", GeoCoordinates: { Google: "47.37690 8.54170" } }),
    record({ ChargingStationId: "CH*XXX*P8", EvseID: "E8", GeoCoordinates: { Google: "47.37700 8.54180" } }),
  ]);
  assert.equal(twins.length, 1);
  assert.equal(at(twins, 0).stalls, 2);
  assert.equal(at(twins, 0).id, "CH*XXX*P8");
  assert.deepEqual(at(twins, 0).evseIds.sort(), ["E8", "E9"]);

  const apart = buildSites([
    record({ ChargingStationId: "CH*XXX*P9", EvseID: "E9" }),
    record({ ChargingStationId: "CH*XXX*P8", EvseID: "E8", GeoCoordinates: { Google: "47.3820 8.5417" } }),
  ]);
  assert.equal(apart.length, 2);
});

test("parking-bay numbers in the name do not keep bays of one car park apart", () => {
  const bays = buildSites([
    record({ ChargingStationId: "A", EvseID: "E1", ChargingStationNames: [{ lang: "de", value: "SUVA Neumühlequai 6 PP202" }] }),
    record({ ChargingStationId: "B", EvseID: "E2", ChargingStationNames: [{ lang: "de", value: "SUVA Neumühlequai 6 PP204" }] }),
    record({ ChargingStationId: "C", EvseID: "E3", ChargingStationNames: [{ lang: "de", value: "SUVA Neumühlequai 6 PPEinfahrt" }] }),
  ]);
  assert.deepEqual(bays.map((s) => s.stalls).sort(), [1, 2]);
  assert.equal(bays.find((s) => s.stalls === 2)?.name, "SUVA Neumühlequai 6");
  const sides = buildSites([
    record({ ChargingStationId: "A", EvseID: "E1", ChargingStationNames: [{ lang: "de", value: "Raststätte Nord" }] }),
    record({ ChargingStationId: "B", EvseID: "E2", ChargingStationNames: [{ lang: "de", value: "Raststätte Süd" }] }),
  ]);
  assert.equal(sides.length, 2);
});

test("restricted-access and off-map records are dropped", () => {
  const sites = buildSites([
    record({ Accessibility: "Restricted access" }),
    record({ ChargingStationId: "CH*XXX*P2", GeoCoordinates: { Google: "50 -15" } }),
  ]);
  assert.equal(sites.length, 0);
});

test("live status is folded into per-site counts, unknown included", () => {
  const sites = buildSites([
    record({ EvseID: "E1" }),
    record({ EvseID: "E2" }),
    record({ EvseID: "E3" }),
    record({ EvseID: "E4" }),
  ]);
  const statuses = new Map([
    ["E1", "Available"],
    ["E2", "Occupied"],
    ["E3", "OutOfService"],
    // E4 absent from the status feed entirely.
  ]);
  attachLiveStatus(sites, statuses, "2026-09-09T10:00:00Z");
  assert.deepEqual(at(sites, 0).live, {
    available: 1,
    busy: 1,
    outOfService: 1,
    unknown: 1,
    at: "2026-09-09T10:00:00Z",
  });
});

test("the published shape carries no charge point ids", () => {
  const published = publishSite(at(buildSites([record({})]), 0));
  assert.equal("evseIds" in published, false);
  assert.equal(published.id, "CH*XXX*P1");
});

test("maxstay free text parses to minutes, unlimited to null, junk to undefined", () => {
  assert.equal(parseMaxStay("4 hours"), 240);
  assert.equal(parseMaxStay("90 min"), 90);
  assert.equal(parseMaxStay("1.5h"), 90);
  assert.equal(parseMaxStay("unlimited"), null);
  assert.equal(parseMaxStay("while charging"), undefined);
  assert.equal(parseMaxStay(undefined), undefined);
});
