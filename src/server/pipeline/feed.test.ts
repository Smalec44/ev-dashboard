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
    // A few metres off, so that only the name decides whether it is a bay.
    record({ ChargingStationId: "C", EvseID: "E3", GeoCoordinates: { Google: "47.37708 8.5417" }, ChargingStationNames: [{ lang: "de", value: "SUVA Neumühlequai 6 PPEinfahrt" }] }),
  ]);
  assert.deepEqual(bays.map((s) => s.stalls).sort(), [1, 2]);
  assert.equal(bays.find((s) => s.stalls === 2)?.name, "SUVA Neumühlequai 6");
  const sides = buildSites([
    record({ ChargingStationId: "A", EvseID: "E1", ChargingStationNames: [{ lang: "de", value: "Raststätte Nord" }] }),
    record({ ChargingStationId: "B", EvseID: "E2", GeoCoordinates: { Google: "47.37735 8.5417" }, ChargingStationNames: [{ lang: "de", value: "Raststätte Süd" }] }),
  ]);
  assert.equal(sides.length, 2);
});

test("same operator at the same spot is one site whatever the bays are called", () => {
  const bays = buildSites([
    record({ ChargingStationId: "B", EvseID: "E2", operator: "eCarUp", ChargingStationNames: [{ lang: "de", value: "Aarwangen Parkfeld 02" }] }),
    record({ ChargingStationId: "A", EvseID: "E1", operator: "eCarUp", ChargingStationNames: [{ lang: "de", value: "Aarwangen Parkfeld 01" }] }),
    record({ ChargingStationId: "C", EvseID: "E3", operator: "eCarUp", GeoCoordinates: { Google: "47.37692 8.54172" }, ChargingStationNames: [{ lang: "de", value: "Aarwangen Parkfeld 03 ." }] }),
  ]);
  assert.equal(bays.length, 1);
  assert.equal(at(bays, 0).id, "A");
  assert.equal(at(bays, 0).stalls, 3);
  assert.equal(at(bays, 0).name, "Aarwangen Parkfeld 01");
  assert.deepEqual(at(bays, 0).evseIds.sort(), ["E1", "E2", "E3"]);

  // The shortest cleaned name wins: the stray dot is not part of the name.
  const dotted = buildSites([
    record({ ChargingStationId: "A", EvseID: "E1", ChargingStationNames: [{ lang: "de", value: "Aarau Nordpark rechts ." }] }),
    record({ ChargingStationId: "B", EvseID: "E2", ChargingStationNames: [{ lang: "de", value: "Aarau Nordpark rechts" }] }),
  ]);
  assert.equal(dotted.length, 1);
  assert.equal(at(dotted, 0).name, "Aarau Nordpark rechts");

  // Another operator at the same spot, or the same operator 50 m away, stays apart.
  const others = buildSites([
    record({ ChargingStationId: "A", EvseID: "E1", operator: "Move", ChargingStationNames: [{ lang: "de", value: "Parkfeld 01" }] }),
    record({ ChargingStationId: "B", EvseID: "E2", operator: "evpass", ChargingStationNames: [{ lang: "de", value: "Parkfeld 02" }] }),
    record({ ChargingStationId: "C", EvseID: "E3", operator: "Move", GeoCoordinates: { Google: "47.37735 8.5417" }, ChargingStationNames: [{ lang: "de", value: "Parkfeld 03" }] }),
  ]);
  assert.equal(others.length, 3);
});

test("a record without a usable power publishes null, and never drags a twin down", () => {
  const unknown = at(buildSites([record({ ChargingFacilities: [{ power: 0, powertype: "AC_3_PHASE" }] })]), 0);
  assert.equal(unknown.maxPowerKw, null);
  assert.equal(unknown.connectorType, "AC");
  const missing = at(buildSites([record({ ChargingFacilities: [] })]), 0);
  assert.equal(missing.maxPowerKw, null);

  // Zero on one stall of a site, or one twin of a pair, is "unknown", not 0 kW.
  const site = at(buildSites([
    record({ EvseID: "E1", ChargingFacilities: [{ power: 0 }] }),
    record({ EvseID: "E2", ChargingFacilities: [{ power: 50, powertype: "DC" }] }),
  ]), 0);
  assert.equal(site.maxPowerKw, 50);
  assert.equal(site.connectorType, "DC");
  const twin = at(buildSites([
    record({ ChargingStationId: "A", EvseID: "E1", ChargingFacilities: [{ power: 22 }] }),
    record({ ChargingStationId: "B", EvseID: "E2", ChargingFacilities: [] }),
  ]), 0);
  assert.equal(twin.maxPowerKw, 22);
});

test("a country name or an address fragment in the city field yields the nearest town", () => {
  for (const City of ["Schweiz", "Suisse", "Svizzera", "Switzerland", "Süd 5a", "-"]) {
    const site = at(buildSites([record({ Address: { Street: "Bahnhofstrasse 1", PostalCode: "8001", City } })]), 0);
    assert.equal(site.city, "Zürich", City);
    assert.equal(site.canton, "ZH", City);
    assert.equal(site.address, "Bahnhofstrasse 1, 8001, Zürich", City);
  }
  // A real place REGIONS does not list keeps the operator's spelling.
  const hamlet = at(buildSites([record({ Address: { City: "Le Lignon" } })]), 0);
  assert.equal(hamlet.city, "Le Lignon");
});

test("a charger over 43 kW is DC whatever power type the operator filed", () => {
  const [site] = buildSites([
    record({ ChargingFacilities: [{ power: 250, powertype: "AC_3_PHASE" }] }),
  ]);
  assert.equal(site?.connectorType, "DC");
  const [slow] = buildSites([
    record({ ChargingFacilities: [{ power: 22, powertype: "AC_3_PHASE" }] }),
  ]);
  assert.equal(slow?.connectorType, "AC");
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
