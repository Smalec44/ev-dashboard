import assert from "node:assert/strict";
import { test } from "node:test";
import { attachLiveStatus, buildSites, publishSite, type FeedRecord } from "./feed.ts";
import { parseMaxStay } from "./overpass.ts";

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
  assert.equal(sites[0].stalls, 2);
  assert.equal(sites[0].connectorType, "DC");
  assert.equal(sites[0].maxPowerKw, 150);
  assert.deepEqual(sites[0].evseIds, ["CH*XXX*E1", "CH*XXX*E2"]);
  // The feed's spelling is canonicalised to the searchable region name.
  assert.equal(sites[0].city, "Zürich");
  assert.equal(sites[0].canton, "ZH");
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
  assert.deepEqual(sites[0].live, {
    available: 1,
    busy: 1,
    outOfService: 1,
    unknown: 1,
    at: "2026-09-09T10:00:00Z",
  });
});

test("the published shape carries no charge point ids", () => {
  const [site] = buildSites([record({})]);
  const published = publishSite(site);
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
