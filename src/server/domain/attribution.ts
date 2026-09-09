import type { Attribution } from "./sources";

/**
 * Attribution is a licence obligation, not decoration (cross-cutting rule 5).
 * Rendered in the page footer.
 *
 * BFE data is O-By-Ask: commercial use requires written permission from
 * geoinformation@bfe.admin.ch. That is a human step — flag it, do not assume it.
 */
export const ATTRIBUTIONS: Record<string, Attribution> = {
  bfe: {
    source: "bfe",
    text: "Charging infrastructure: Swiss Federal Office of Energy (BFE) / ich-tanke-strom",
    url: "https://opendata.swiss/en/dataset/ladestationen-fuer-elektroautos",
    licence: "O-By-Ask",
    commercialUseRestricted: true,
  },
  osm: {
    source: "osm",
    text: "Amenity data © OpenStreetMap contributors",
    url: "https://www.openstreetmap.org/copyright",
    licence: "ODbL",
    commercialUseRestricted: false,
  },
  geonames: {
    source: "geonames",
    text: "Place names, coordinates and population: GeoNames",
    url: "https://www.geonames.org/",
    licence: "CC BY 4.0",
    commercialUseRestricted: false,
  },
  elcom: {
    source: "elcom",
    text: "Household electricity tariffs: ElCom / LINDAS",
    url: "https://www.elcom.admin.ch/de/tarifdaten-und-visualisierungen",
    licence: "Open Government Data",
    commercialUseRestricted: false,
  },
  chargeprice: {
    source: "chargeprice",
    text: "Public charging tariffs: Chargeprice",
    url: "https://chargeprice.github.io/chargeprice-api-docs/",
    licence: "Commercial — requires contract",
    commercialUseRestricted: true,
  },
};

/**
 * The three sources every render depends on: the federal feed for stations,
 * OpenStreetMap for the food and greenery around them, and GeoNames for the
 * town centres the search resolves against. Credit the ones actually in use —
 * naming a source the page does not draw on is its own kind of wrong, and
 * ElCom and Chargeprice are still only schema, so they stay behind a flag.
 */
const ALWAYS_ACTIVE = [
  ATTRIBUTIONS.bfe,
  ATTRIBUTIONS.osm,
  ATTRIBUTIONS.geonames,
];

export function activeAttributions(
  enabled: { elcom?: boolean; chargeprice?: boolean } = {},
): Attribution[] {
  const active = [...ALWAYS_ACTIVE];
  if (enabled.elcom) active.push(ATTRIBUTIONS.elcom);
  if (enabled.chargeprice) active.push(ATTRIBUTIONS.chargeprice);
  return active;
}
