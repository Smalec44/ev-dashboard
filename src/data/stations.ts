import { distanceKm } from "@/lib/geo";
import type { ChargingStation, LatLon } from "@/lib/types";

type StationSeed = Omit<ChargingStation, "lat" | "lon">;

const BASE_STATIONS: StationSeed[] = [
  {
    id: "zh-ionity-nord",
    name: "IONITY Zürich Nord",
    operator: "IONITY",
    city: "Zürich",
    canton: "ZH",
    address: "Thurgauerstrasse 105, 8152 Glattpark",
    connectorType: "DC",
    maxPowerKw: 350,
    stalls: 6,
    pricePerKwh: 0.69,
    reliabilityPct: 98,
    food: [
      { name: "Gustav", cuisine: "Swiss brasserie", rating: 4.4, walkingMinutes: 4, priceLevel: 3 },
      { name: "Kaisin Poké", cuisine: "Hawaiian", rating: 4.3, walkingMinutes: 6, priceLevel: 2 },
      { name: "Café Alpenblick", cuisine: "Bakery", rating: 4.1, walkingMinutes: 7, priceLevel: 1 },
    ],
  },
  {
    id: "zh-tesla-altstetten",
    name: "Tesla Supercharger Altstetten",
    operator: "Tesla",
    city: "Zürich",
    canton: "ZH",
    address: "Hohlstrasse 481, 8048 Zürich",
    connectorType: "DC",
    maxPowerKw: 250,
    stalls: 12,
    pricePerKwh: 0.55,
    reliabilityPct: 99,
    food: [
      { name: "Bank Bar & Restaurant", cuisine: "Mediterranean", rating: 4.2, walkingMinutes: 5, priceLevel: 2 },
      { name: "Migros Take-away", cuisine: "Self-service", rating: 3.6, walkingMinutes: 3, priceLevel: 1 },
    ],
  },
  {
    id: "zh-e360-sihlcity",
    name: "Energie 360° Sihlcity",
    operator: "Energie 360°",
    city: "Zürich",
    canton: "ZH",
    address: "Kalanderplatz 1, 8045 Zürich",
    connectorType: "AC",
    maxPowerKw: 22,
    stalls: 8,
    pricePerKwh: 0.39,
    reliabilityPct: 95,
    food: [
      { name: "Nooch Asian Kitchen", cuisine: "Pan-Asian", rating: 4.5, walkingMinutes: 2, priceLevel: 2 },
      { name: "Pasta e Pesto", cuisine: "Italian", rating: 4.4, walkingMinutes: 3, priceLevel: 2 },
      { name: "Sihlcity Foodcourt", cuisine: "Mixed", rating: 4.0, walkingMinutes: 2, priceLevel: 1 },
      { name: "Sprüngli", cuisine: "Café / patisserie", rating: 4.6, walkingMinutes: 4, priceLevel: 2 },
    ],
  },
  {
    id: "zh-gofast-hardbruecke",
    name: "Gofast Zürich Hardbrücke",
    operator: "Gofast",
    city: "Zürich",
    canton: "ZH",
    address: "Pfingstweidstrasse 60, 8005 Zürich",
    connectorType: "DC",
    maxPowerKw: 150,
    stalls: 4,
    pricePerKwh: 0.64,
    reliabilityPct: 92,
    food: [
      { name: "Kiosk Hardbrücke", cuisine: "Snacks", rating: 3.1, walkingMinutes: 11, priceLevel: 1 },
    ],
  },
  {
    id: "win-gofast-gruzefeld",
    name: "Gofast Winterthur Grüzefeld",
    operator: "Gofast",
    city: "Winterthur",
    canton: "ZH",
    address: "Grüzefeldstrasse 32, 8400 Winterthur",
    connectorType: "DC",
    maxPowerKw: 150,
    stalls: 4,
    pricePerKwh: 0.62,
    reliabilityPct: 94,
    food: [
      { name: "Coop Restaurant", cuisine: "Self-service", rating: 3.5, walkingMinutes: 8, priceLevel: 1 },
      { name: "Pizzeria Da Franco", cuisine: "Italian", rating: 3.9, walkingMinutes: 10, priceLevel: 2 },
    ],
  },
  {
    id: "win-move-altstadt",
    name: "MOVE Winterthur Altstadt",
    operator: "MOVE",
    city: "Winterthur",
    canton: "ZH",
    address: "Neumarkt 5, 8400 Winterthur",
    connectorType: "AC",
    maxPowerKw: 22,
    stalls: 6,
    pricePerKwh: 0.41,
    reliabilityPct: 96,
    food: [
      { name: "Restaurant Strauss", cuisine: "Swiss", rating: 4.5, walkingMinutes: 3, priceLevel: 2 },
      { name: "Kafi Zoll", cuisine: "Café", rating: 4.4, walkingMinutes: 4, priceLevel: 1 },
      { name: "Bombay Palace", cuisine: "Indian", rating: 4.2, walkingMinutes: 5, priceLevel: 2 },
    ],
  },
  {
    id: "ge-fastned-aeroport",
    name: "Fastned Genève Aéroport",
    operator: "Fastned",
    city: "Genève",
    canton: "GE",
    address: "Route de l'Aéroport 21, 1215 Genève",
    connectorType: "DC",
    maxPowerKw: 300,
    stalls: 8,
    pricePerKwh: 0.67,
    reliabilityPct: 97,
    food: [
      { name: "Le Chef", cuisine: "Brasserie", rating: 4.0, walkingMinutes: 6, priceLevel: 2 },
      { name: "Starbucks Aéroport", cuisine: "Café", rating: 3.7, walkingMinutes: 5, priceLevel: 2 },
    ],
  },
  {
    id: "ge-evpass-plainpalais",
    name: "evpass Genève Plainpalais",
    operator: "evpass",
    city: "Genève",
    canton: "GE",
    address: "Rue de Carouge 20, 1205 Genève",
    connectorType: "AC",
    maxPowerKw: 22,
    stalls: 10,
    pricePerKwh: 0.43,
    reliabilityPct: 93,
    food: [
      { name: "Café des Bains", cuisine: "French", rating: 4.6, walkingMinutes: 3, priceLevel: 3 },
      { name: "Luigia", cuisine: "Neapolitan pizza", rating: 4.5, walkingMinutes: 4, priceLevel: 2 },
      { name: "Boulangerie Pouly", cuisine: "Bakery", rating: 4.2, walkingMinutes: 2, priceLevel: 1 },
      { name: "Chez Ma Cousine", cuisine: "Rotisserie", rating: 4.1, walkingMinutes: 6, priceLevel: 1 },
    ],
  },
  {
    id: "ge-tesla-meyrin",
    name: "Tesla Supercharger Meyrin",
    operator: "Tesla",
    city: "Genève",
    canton: "GE",
    address: "Rue de la Bergère 20, 1217 Meyrin",
    connectorType: "DC",
    maxPowerKw: 250,
    stalls: 16,
    pricePerKwh: 0.56,
    reliabilityPct: 99,
    food: [
      { name: "Snack Bergère", cuisine: "Kebab", rating: 3.2, walkingMinutes: 12, priceLevel: 1 },
    ],
  },
  {
    id: "vd-move-flon",
    name: "MOVE Lausanne Flon",
    operator: "MOVE",
    city: "Lausanne",
    canton: "VD",
    address: "Place de l'Europe 9, 1003 Lausanne",
    connectorType: "DC",
    maxPowerKw: 150,
    stalls: 6,
    pricePerKwh: 0.65,
    reliabilityPct: 95,
    food: [
      { name: "Le Pointu", cuisine: "Brunch", rating: 4.5, walkingMinutes: 3, priceLevel: 2 },
      { name: "Holy Cow!", cuisine: "Burgers", rating: 4.3, walkingMinutes: 2, priceLevel: 1 },
      { name: "Ta Cave", cuisine: "Wine bar", rating: 4.4, walkingMinutes: 5, priceLevel: 2 },
    ],
  },
  {
    id: "vd-evpass-ouchy",
    name: "evpass Lausanne Ouchy",
    operator: "evpass",
    city: "Lausanne",
    canton: "VD",
    address: "Place de la Navigation 6, 1006 Lausanne",
    connectorType: "AC",
    maxPowerKw: 22,
    stalls: 8,
    pricePerKwh: 0.42,
    reliabilityPct: 91,
    food: [
      { name: "Café du Vieux Port", cuisine: "Swiss", rating: 4.2, walkingMinutes: 4, priceLevel: 2 },
      { name: "Gelateria Veneta", cuisine: "Gelato", rating: 4.5, walkingMinutes: 6, priceLevel: 1 },
    ],
  },
  {
    id: "vd-ionity-crissier",
    name: "IONITY Lausanne Crissier",
    operator: "IONITY",
    city: "Lausanne",
    canton: "VD",
    address: "Chemin de Closalet 4, 1023 Crissier",
    connectorType: "DC",
    maxPowerKw: 350,
    stalls: 6,
    pricePerKwh: 0.69,
    reliabilityPct: 98,
    food: [
      { name: "Station Shop Crissier", cuisine: "Convenience", rating: 3.0, walkingMinutes: 9, priceLevel: 1 },
    ],
  },
  {
    id: "be-ewb-wankdorf",
    name: "Energie Wasser Bern Wankdorf",
    operator: "ewb",
    city: "Bern",
    canton: "BE",
    address: "Papiermühlestrasse 71, 3014 Bern",
    connectorType: "DC",
    maxPowerKw: 150,
    stalls: 6,
    pricePerKwh: 0.61,
    reliabilityPct: 96,
    food: [
      { name: "Wankdorf Center Food", cuisine: "Mixed", rating: 3.8, walkingMinutes: 5, priceLevel: 1 },
      { name: "Tibits", cuisine: "Vegetarian", rating: 4.3, walkingMinutes: 8, priceLevel: 2 },
    ],
  },
  {
    id: "be-move-bahnhof",
    name: "MOVE Bern Bahnhof",
    operator: "MOVE",
    city: "Bern",
    canton: "BE",
    address: "Schanzenstrasse 5, 3008 Bern",
    connectorType: "AC",
    maxPowerKw: 22,
    stalls: 12,
    pricePerKwh: 0.4,
    reliabilityPct: 97,
    food: [
      { name: "Kornhauskeller", cuisine: "Swiss fine dining", rating: 4.5, walkingMinutes: 6, priceLevel: 3 },
      { name: "Della Casa", cuisine: "Bernese classic", rating: 4.4, walkingMinutes: 5, priceLevel: 2 },
      { name: "Adriano's Bar", cuisine: "Café", rating: 4.5, walkingMinutes: 4, priceLevel: 1 },
      { name: "Lötschberg AOC", cuisine: "Cheese / raclette", rating: 4.3, walkingMinutes: 7, priceLevel: 2 },
    ],
  },
  {
    id: "be-gofast-buempliz",
    name: "Gofast Bern Bümpliz",
    operator: "Gofast",
    city: "Bern",
    canton: "BE",
    address: "Freiburgstrasse 570, 3018 Bern",
    connectorType: "DC",
    maxPowerKw: 150,
    stalls: 4,
    pricePerKwh: 0.63,
    reliabilityPct: 90,
    food: [
      { name: "Tankstellen-Shop", cuisine: "Convenience", rating: 2.9, walkingMinutes: 10, priceLevel: 1 },
    ],
  },
  {
    id: "bs-ionity-pratteln",
    name: "IONITY Basel Pratteln",
    operator: "IONITY",
    city: "Basel",
    canton: "BS",
    address: "Güterstrasse 92, 4133 Pratteln",
    connectorType: "DC",
    maxPowerKw: 350,
    stalls: 8,
    pricePerKwh: 0.69,
    reliabilityPct: 98,
    food: [
      { name: "Restaurant Rheinblick", cuisine: "Swiss", rating: 3.9, walkingMinutes: 8, priceLevel: 2 },
      { name: "Bäckerei Sutter", cuisine: "Bakery", rating: 4.0, walkingMinutes: 9, priceLevel: 1 },
    ],
  },
  {
    id: "bs-iwb-kleinbasel",
    name: "IWB Basel Kleinbasel",
    operator: "IWB",
    city: "Basel",
    canton: "BS",
    address: "Klybeckstrasse 12, 4057 Basel",
    connectorType: "AC",
    maxPowerKw: 22,
    stalls: 10,
    pricePerKwh: 0.38,
    reliabilityPct: 95,
    food: [
      { name: "Volkshaus Basel", cuisine: "Brasserie", rating: 4.5, walkingMinutes: 4, priceLevel: 3 },
      { name: "Klara Foodhall", cuisine: "Mixed", rating: 4.4, walkingMinutes: 3, priceLevel: 2 },
      { name: "Café Frühling", cuisine: "Café", rating: 4.6, walkingMinutes: 5, priceLevel: 1 },
    ],
  },
  {
    id: "bs-fastned-dreispitz",
    name: "Fastned Basel Dreispitz",
    operator: "Fastned",
    city: "Basel",
    canton: "BS",
    address: "Reinacherstrasse 105, 4053 Basel",
    connectorType: "DC",
    maxPowerKw: 300,
    stalls: 6,
    pricePerKwh: 0.66,
    reliabilityPct: 96,
    food: [
      { name: "Nomad Eatery", cuisine: "Modern European", rating: 4.3, walkingMinutes: 7, priceLevel: 2 },
      { name: "Dreispitzhalle Kiosk", cuisine: "Snacks", rating: 3.4, walkingMinutes: 4, priceLevel: 1 },
    ],
  },
  {
    id: "lu-ionity-neuenkirch",
    name: "IONITY Neuenkirch Raststätte",
    operator: "IONITY",
    city: "Luzern",
    canton: "LU",
    address: "A2 Raststätte, 6206 Neuenkirch",
    connectorType: "DC",
    maxPowerKw: 350,
    stalls: 6,
    pricePerKwh: 0.7,
    reliabilityPct: 97,
    food: [
      { name: "Autogrill Neuenkirch", cuisine: "Motorway restaurant", rating: 3.4, walkingMinutes: 3, priceLevel: 2 },
      { name: "Marché Bistro", cuisine: "Self-service", rating: 3.6, walkingMinutes: 4, priceLevel: 2 },
    ],
  },
  {
    id: "lu-move-bahnhof",
    name: "MOVE Luzern Bahnhof",
    operator: "MOVE",
    city: "Luzern",
    canton: "LU",
    address: "Zentralstrasse 1, 6003 Luzern",
    connectorType: "AC",
    maxPowerKw: 22,
    stalls: 8,
    pricePerKwh: 0.41,
    reliabilityPct: 96,
    food: [
      { name: "Wirtshaus Galliker", cuisine: "Lucerne classic", rating: 4.6, walkingMinutes: 6, priceLevel: 2 },
      { name: "Bam Bou by Thomas", cuisine: "Asian fusion", rating: 4.4, walkingMinutes: 3, priceLevel: 3 },
      { name: "Heini Confiserie", cuisine: "Patisserie", rating: 4.3, walkingMinutes: 4, priceLevel: 1 },
    ],
  },
  {
    id: "lu-gofast-emmen",
    name: "Gofast Luzern Emmen",
    operator: "Gofast",
    city: "Luzern",
    canton: "LU",
    address: "Seetalstrasse 2, 6032 Emmen",
    connectorType: "DC",
    maxPowerKw: 150,
    stalls: 4,
    pricePerKwh: 0.62,
    reliabilityPct: 93,
    food: [
      { name: "Emmen Center Imbiss", cuisine: "Fast food", rating: 3.2, walkingMinutes: 9, priceLevel: 1 },
    ],
  },
  {
    id: "sg-swisscharge-zentrum",
    name: "Swisscharge St. Gallen Zentrum",
    operator: "Swisscharge",
    city: "St. Gallen",
    canton: "SG",
    address: "Marktplatz 24, 9000 St. Gallen",
    connectorType: "AC",
    maxPowerKw: 22,
    stalls: 6,
    pricePerKwh: 0.44,
    reliabilityPct: 92,
    food: [
      { name: "Wirtschaft zur alten Post", cuisine: "Swiss", rating: 4.4, walkingMinutes: 5, priceLevel: 2 },
      { name: "Café Gschwend", cuisine: "Bakery", rating: 4.2, walkingMinutes: 3, priceLevel: 1 },
    ],
  },
  {
    id: "sg-gofast-winkeln",
    name: "Gofast St. Gallen Winkeln",
    operator: "Gofast",
    city: "St. Gallen",
    canton: "SG",
    address: "Zürcherstrasse 462, 9015 St. Gallen",
    connectorType: "DC",
    maxPowerKw: 150,
    stalls: 4,
    pricePerKwh: 0.63,
    reliabilityPct: 94,
    food: [
      { name: "Shell Shop Winkeln", cuisine: "Convenience", rating: 3.0, walkingMinutes: 8, priceLevel: 1 },
    ],
  },
  {
    id: "ti-evpass-centro",
    name: "evpass Lugano Centro",
    operator: "evpass",
    city: "Lugano",
    canton: "TI",
    address: "Via Nassa 5, 6900 Lugano",
    connectorType: "AC",
    maxPowerKw: 22,
    stalls: 8,
    pricePerKwh: 0.45,
    reliabilityPct: 91,
    food: [
      { name: "Grand Café Al Porto", cuisine: "Italian", rating: 4.5, walkingMinutes: 3, priceLevel: 2 },
      { name: "Bottegone del Vino", cuisine: "Ticinese", rating: 4.6, walkingMinutes: 5, priceLevel: 3 },
      { name: "Gelateria Gabbani", cuisine: "Gelato", rating: 4.4, walkingMinutes: 4, priceLevel: 1 },
    ],
  },
  {
    id: "ti-fastned-grancia",
    name: "Fastned Lugano Grancia",
    operator: "Fastned",
    city: "Lugano",
    canton: "TI",
    address: "Via Cantonale 15, 6916 Grancia",
    connectorType: "DC",
    maxPowerKw: 300,
    stalls: 6,
    pricePerKwh: 0.68,
    reliabilityPct: 96,
    food: [
      { name: "Ristorante Grancia", cuisine: "Italian", rating: 4.0, walkingMinutes: 6, priceLevel: 2 },
      { name: "Centro Lugano Sud Food", cuisine: "Mixed", rating: 3.7, walkingMinutes: 4, priceLevel: 1 },
    ],
  },
  {
    id: "zg-tesla-zug",
    name: "Tesla Supercharger Zug",
    operator: "Tesla",
    city: "Zug",
    canton: "ZG",
    address: "Baarerstrasse 133, 6300 Zug",
    connectorType: "DC",
    maxPowerKw: 250,
    stalls: 10,
    pricePerKwh: 0.57,
    reliabilityPct: 99,
    food: [
      { name: "Rathauskeller Zug", cuisine: "Fine dining", rating: 4.5, walkingMinutes: 9, priceLevel: 3 },
      { name: "Sushi Ken", cuisine: "Japanese", rating: 4.1, walkingMinutes: 5, priceLevel: 2 },
    ],
  },
  {
    id: "zg-wwz-altstadt",
    name: "WWZ Zug Altstadt",
    operator: "WWZ",
    city: "Zug",
    canton: "ZG",
    address: "Fischmarkt 3, 6300 Zug",
    connectorType: "AC",
    maxPowerKw: 22,
    stalls: 6,
    pricePerKwh: 0.4,
    reliabilityPct: 95,
    food: [
      { name: "Schiff Zug", cuisine: "Lakeside Swiss", rating: 4.4, walkingMinutes: 3, priceLevel: 2 },
      { name: "Confiserie Speck", cuisine: "Patisserie", rating: 4.6, walkingMinutes: 4, priceLevel: 1 },
      { name: "Hoi Zug", cuisine: "Café", rating: 4.2, walkingMinutes: 2, priceLevel: 1 },
    ],
  },
];

const COORDS: Record<string, [number, number]> = {
  "zh-ionity-nord": [47.4142, 8.5561],
  "zh-tesla-altstetten": [47.3897, 8.4859],
  "zh-e360-sihlcity": [47.3585, 8.5238],
  "zh-gofast-hardbruecke": [47.3888, 8.5158],
  "win-gofast-gruzefeld": [47.4967, 8.7402],
  "win-move-altstadt": [47.5003, 8.729],
  "ge-fastned-aeroport": [46.2311, 6.109],
  "ge-evpass-plainpalais": [46.1969, 6.14],
  "ge-tesla-meyrin": [46.2265, 6.081],
  "vd-move-flon": [46.521, 6.63],
  "vd-evpass-ouchy": [46.5069, 6.6265],
  "vd-ionity-crissier": [46.545, 6.579],
  "be-ewb-wankdorf": [46.9636, 7.4646],
  "be-move-bahnhof": [46.949, 7.439],
  "be-gofast-buempliz": [46.937, 7.382],
  "bs-ionity-pratteln": [47.522, 7.693],
  "bs-iwb-kleinbasel": [47.569, 7.592],
  "bs-fastned-dreispitz": [47.535, 7.598],
  "lu-ionity-neuenkirch": [47.083, 8.214],
  "lu-move-bahnhof": [47.05, 8.31],
  "lu-gofast-emmen": [47.079, 8.299],
  "sg-swisscharge-zentrum": [47.4245, 9.376],
  "sg-gofast-winkeln": [47.426, 9.32],
  "ti-evpass-centro": [46.003, 8.949],
  "ti-fastned-grancia": [45.982, 8.92],
  "zg-tesla-zug": [47.175, 8.518],
  "zg-wwz-altstadt": [47.169, 8.516],
};

/**
 * Hand-curated seed stations. These are the only records carrying food ratings,
 * price levels and uptime, so they are kept as an overlay on the federal feed
 * rather than replaced by it.
 */
export const CURATED_STATIONS: ChargingStation[] = BASE_STATIONS.map((station) => {
  const coords = COORDS[station.id];
  if (!coords) throw new Error(`Missing coordinates for station ${station.id}`);
  return { ...station, lat: coords[0], lon: coords[1] };
});

/** Shape of public/stations.json, written by scripts/build-data.mjs. */
export interface StationFeed {
  foodAvailable: boolean;
  generatedAt: string;
  source: Record<string, string>;
  foodRadiusMetres?: number;
  stations: ChargingStation[];
}

/** A curated entry and a feed entry this close are the same physical site. */
const DEDUPE_METRES = 200;

/**
 * Federal feed plus the curated overlay. Where both describe the same site the
 * curated record wins, because it is the one with food and uptime detail.
 */
export function mergeStations(feed: ChargingStation[]): ChargingStation[] {
  const kept = feed.filter((station) =>
    !CURATED_STATIONS.some(
      (curated) =>
        curated.city === station.city &&
        distanceKm(curated, station) * 1000 <= DEDUPE_METRES,
    ),
  );
  return [...CURATED_STATIONS, ...kept];
}

/**
 * Radius for a region search. Municipal boundaries are not what a driver cares
 * about — a charger 2 km outside Aarau is still "in Aarau" for anyone parking
 * there. 5 km was chosen against the feed: it leaves only 26 of the 1000 towns
 * without a result (exact-name matching leaves 236) while keeping a big-city
 * search local — Zürich picks up its own ~180 sites rather than half the canton.
 */
export const DEFAULT_RADIUS_KM = 5;

export interface NearbyStation {
  station: ChargingStation;
  /** Straight-line km from the searched town centre. */
  distanceKm: number;
}

/**
 * Stations around a town centre, plus every station the feed already labels
 * with that town. The union matters in both directions: large municipalities
 * (Zürich, Bern) sprawl past any sensible radius, and small ones have their
 * nearest chargers in the next village over.
 */
export function stationsNearRegion(
  stations: ChargingStation[],
  centre: LatLon & { city: string },
  radiusKm: number,
): NearbyStation[] {
  const near: NearbyStation[] = [];
  for (const station of stations) {
    const km = distanceKm(centre, station);
    if (km <= radiusKm || station.city === centre.city) {
      near.push({ station, distanceKm: km });
    }
  }
  return near;
}
