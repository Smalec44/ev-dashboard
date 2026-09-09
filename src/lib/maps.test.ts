import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeViaStationUrl, stationMapUrl } from "./maps.ts";
import type { ChargingStation, Region } from "./types.ts";

const station = {
  id: "s1",
  name: "Test",
  lat: 46.5,
  lon: 7.25,
} as ChargingStation;

const basel: Region = {
  slug: "basel",
  city: "Basel",
  canton: "BS",
  aliases: [],
  lat: 47.56,
  lon: 7.59,
};
const lugano: Region = {
  slug: "lugano",
  city: "Lugano",
  canton: "TI",
  aliases: [],
  lat: 46.0,
  lon: 8.95,
};

describe("Google Maps links", () => {
  it("pins the station by coordinates", () => {
    const url = new URL(stationMapUrl(station));
    assert.equal(url.origin + url.pathname, "https://www.google.com/maps/search/");
    assert.equal(url.searchParams.get("api"), "1");
    assert.equal(url.searchParams.get("query"), "46.5,7.25");
  });

  it("routes origin → station → destination by car", () => {
    const url = new URL(routeViaStationUrl(basel, station, lugano));
    assert.equal(url.origin + url.pathname, "https://www.google.com/maps/dir/");
    assert.equal(url.searchParams.get("origin"), "Basel BS, Switzerland");
    assert.equal(url.searchParams.get("destination"), "Lugano TI, Switzerland");
    assert.equal(url.searchParams.get("waypoints"), "46.5,7.25");
    assert.equal(url.searchParams.get("travelmode"), "driving");
  });
});
