import type { ChargingStation, Region } from "./types";

/**
 * Links into Google Maps, built on its documented URL scheme
 * (https://developers.google.com/maps/documentation/urls) — plain links, no
 * API key, and they open the native app on a phone.
 */

/**
 * The pin goes on the coordinates, not the address text. Feed addresses are
 * whatever the operator typed — "Parkplatz Bahnhof", a street without a number,
 * a village name — and a text search on those lands on the wrong place often
 * enough to matter, while the coordinates are exactly where the charger is.
 * Google labels the pin with the address it reverse-geocodes, so the reader
 * still sees a street name.
 */
export function stationMapUrl(station: ChargingStation): string {
  const params = new URLSearchParams({
    api: "1",
    query: latLon(station),
  });
  return `https://www.google.com/maps/search/?${params}`;
}

/**
 * Driving directions from the origin to the destination, calling at the
 * station on the way. The endpoints are given by name so the route header
 * reads "Basel → Lugano" rather than two pairs of coordinates; the canton is
 * included because Swiss town names repeat (Buchs, Wil, Muri…).
 */
export function routeViaStationUrl(
  from: Region,
  station: ChargingStation,
  to: Region,
): string {
  const params = new URLSearchParams({
    api: "1",
    origin: placeName(from),
    destination: placeName(to),
    waypoints: latLon(station),
    travelmode: "driving",
  });
  return `https://www.google.com/maps/dir/?${params}`;
}

function placeName(region: Region): string {
  return `${region.city} ${region.canton}, Switzerland`;
}

function latLon(point: { lat: number; lon: number }): string {
  return `${point.lat},${point.lon}`;
}
