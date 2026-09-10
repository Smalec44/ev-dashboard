import { tariffFor } from "@/data/tariffs";
import { routeViaStationUrl, stationMapUrl } from "@/lib/maps";
import { openState } from "@/lib/openingHours";
import { liveFreeStalls, type RankedStation } from "@/lib/ranking";
import type { ChargingStation, FoodSpot, ParkingTerms, Region } from "@/lib/types";

const CRITERION_LABELS: Record<string, string> = {
  speed: "Speed",
  price: "Price",
  availability: "Availability",
  detour: "Detour",
  middle: "Stop point",
  nearby: "Nearby",
  green: "Green",
};

/** Plain-language names for the OSM tag values the greenery pass keeps. */
const GREEN_LABELS: Record<string, string> = {
  park: "park",
  garden: "garden",
  nature_reserve: "nature reserve",
  common: "common",
  forest: "forest",
  wood: "woodland",
  village_green: "village green",
  meadow: "meadow",
  grass: "grass",
  grassland: "grassland",
  scrub: "scrub",
  heath: "heath",
  water: "water",
  beach: "beach",
  orchard: "orchard",
  vineyard: "vineyard",
  allotments: "allotments",
};

const liveTimeFormat = new Intl.DateTimeFormat("en-CH", {
  timeStyle: "short",
  timeZone: "Europe/Zurich",
});

const checkedFormat = new Intl.DateTimeFormat("en-CH", { dateStyle: "medium" });

/** Where the price came from, for the tooltip: the operator's page and when it was read. */
function priceTitle(station: ChargingStation): string {
  const tariff = tariffFor(station.operator);
  if (!tariff || station.priceIsEstimate) {
    return `No published ad-hoc tariff found for ${station.operator} — national default shown`;
  }
  const parts = [
    `${station.operator} ad-hoc tariff, checked ${checkedFormat.format(new Date(tariff.checkedOn))}`,
  ];
  if (tariff.varies) parts.push("varies by site or time of day");
  if (tariff.blockingFee) parts.push(`blocking fee: ${tariff.blockingFee}`);
  if (tariff.note) parts.push(tariff.note);
  parts.push(tariff.source);
  return parts.join(" · ");
}

/** DOM id of a station's card, so a map click can scroll the list to it. */
export function cardElementId(stationId: string): string {
  return `station-${stationId}`;
}

/** "4 h", "90 min", "1.5 h": whatever reads most naturally for the length. */
function formatStay(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

function ParkingTermsText({ parking }: { parking: ParkingTerms }) {
  const parts: string[] = [];
  if (parking.free === true) parts.push("free");
  if (parking.free === false) parts.push("paid");
  if (parking.maxStayMinutes === null) parts.push("no time limit");
  else if (parking.maxStayMinutes !== undefined) {
    parts.push(`max ${formatStay(parking.maxStayMinutes)}`);
  }
  return <>{parts.join(" · ")}</>;
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="tabular-nums text-muted">
      ★ {rating.toFixed(1)}
    </span>
  );
}

function FoodRow({ spot, now }: { spot: FoodSpot; now: Date | null }) {
  // Rating and price level only exist on hand-curated spots; OSM supplies
  // neither, so each is rendered only where the data is actually present.
  const descriptor = spot.cuisine ?? spot.category ?? null;
  // "now" is null until the client mounts. Hours resolve in Swiss time, so the
  // viewer's timezone no longer comes into it, but the server and the browser
  // still read the clock at different moments — a venue closing between the
  // two renders would be a hydration mismatch. Open/closed appears only after
  // hydration, so the first client render still matches the server's.
  const state = now ? openState(spot.openingHours, now) : "unknown";

  return (
    <li className="flex items-baseline justify-between gap-3 py-1">
      <span className="min-w-0">
        <span className="font-medium">{spot.name}</span>
        {descriptor && <span className="text-muted"> · {descriptor}</span>}
        {state === "open" && (
          <span className="ml-1.5 text-xs font-medium text-accent">
            open now
          </span>
        )}
        {state === "closed" && (
          <span className="ml-1.5 text-xs text-muted">closed now</span>
        )}
      </span>
      <span className="shrink-0 text-xs text-muted">
        {spot.rating !== undefined && (
          <>
            <Stars rating={spot.rating} />
            {" · "}
          </>
        )}
        {spot.walkingMinutes} min
        {spot.priceLevel !== undefined && (
          <>
            {" · "}
            <span title={`Price level ${spot.priceLevel} of 3`}>
              {"●".repeat(spot.priceLevel)}
              <span className="opacity-30">
                {"●".repeat(3 - spot.priceLevel)}
              </span>
            </span>
          </>
        )}
        {spot.outdoorSeating && (
          <>
            {" · "}
            <span title="Outdoor seating">outdoor</span>
          </>
        )}
        {spot.takeaway && (
          <>
            {" · "}
            <span title="Takeaway available">takeaway</span>
          </>
        )}
      </span>
    </li>
  );
}

export function StationCard({
  ranked,
  rank,
  threshold,
  detourKm,
  offRouteKm,
  detourBasis,
  routeProgress,
  distanceKm,
  searchedCity,
  route,
  now,
  selected = false,
  onSelect,
}: {
  ranked: RankedStation;
  rank: number;
  threshold: number;
  detourKm?: number | undefined;
  /** Km from the road, when the trip was measured on one. */
  offRouteKm?: number | null | undefined;
  /**
   * Where the detour came from, on a road: the router's own figure, or the
   * estimate of twice the distance off the route. Absent on the straight line.
   */
  detourBasis?: "road" | "est" | undefined;
  routeProgress?: number | undefined;
  /** Km from the searched town centre, in region mode. */
  distanceKm?: number | undefined;
  /** The town that was searched, so results from a neighbour can say so. */
  searchedCity?: string | undefined;
  /** The trip's endpoints, in trip mode: enables the "route via here" link. */
  route?: { from: Region; to: Region } | undefined;
  /** Client clock for "open now", null until mount (see Dashboard). */
  now: Date | null;
  /** Highlighted as the station the route button and the map refer to. */
  selected?: boolean;
  onSelect?: (() => void) | undefined;
}) {
  const { station, score, foodScore, foodKnown, belowFoodThreshold, breakdown } =
    ranked;

  return (
    <article
      id={cardElementId(station.id)}
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={`rounded-xl border bg-surface p-5 transition-colors ${
        selected ? "border-accent ring-1 ring-accent" : "border-border"
      } ${onSelect ? "cursor-pointer" : ""}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted tabular-nums">
              #{rank}
            </span>
            <h3 className="truncate text-base font-semibold">{station.name}</h3>
          </div>
          <p className="mt-0.5 text-sm text-muted">
            {station.operator} ·{" "}
            <a
              href={stationMapUrl(station)}
              target="_blank"
              rel="noreferrer"
              title="Open in Google Maps"
              className="underline decoration-border underline-offset-2 hover:text-foreground"
            >
              {station.address}
            </a>
          </p>
          {distanceKm !== undefined && (
            <p className="mt-1.5 flex flex-wrap gap-1.5">
              <span className="rounded-md bg-surface-muted px-2 py-0.5 text-xs font-medium tabular-nums">
                {distanceKm < 1
                  ? `${Math.round(distanceKm * 1000)} m away`
                  : `${distanceKm.toFixed(1)} km away`}
              </span>
              {/* A radius search crosses municipal boundaries, so a result from
                  the next town along has to name itself to make sense. */}
              {searchedCity !== undefined && station.city !== searchedCity && (
                <span className="rounded-md bg-surface-muted px-2 py-0.5 text-xs text-muted">
                  in {station.city}
                </span>
              )}
            </p>
          )}
          {detourKm !== undefined && (
            <p className="mt-1.5 flex flex-wrap gap-1.5">
              <span className="rounded-md bg-surface-muted px-2 py-0.5 text-xs font-medium tabular-nums">
                +{detourKm.toFixed(1)} km detour
                {detourBasis === "road" && (
                  <span
                    className="font-normal text-muted"
                    title="Measured on the road network: to the station and on to the destination, less the direct drive"
                  >
                    {" "}by road
                  </span>
                )}
                {detourBasis === "est" && (
                  <span
                    className="font-normal text-muted"
                    title="Estimated as twice the distance off the route"
                  >
                    {" "}est.
                  </span>
                )}
              </span>
              {typeof offRouteKm === "number" && (
                <span className="rounded-md bg-surface-muted px-2 py-0.5 text-xs text-muted tabular-nums">
                  {offRouteKm.toFixed(1)} km off route
                </span>
              )}
              {routeProgress !== undefined && (
                <span className="rounded-md bg-surface-muted px-2 py-0.5 text-xs text-muted tabular-nums">
                  {Math.round(routeProgress * 100)}% of the way
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-start gap-2">
          {onSelect && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSelect();
              }}
              aria-pressed={selected}
              title="Show this station on the map and use it for the route"
              className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                selected
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border bg-surface-muted hover:text-accent"
              }`}
            >
              {selected ? "Selected ✓" : "Select"}
            </button>
          )}
          {route && (
            <a
              href={routeViaStationUrl(route.from, station, route.to)}
              target="_blank"
              rel="noreferrer"
              title={`Driving directions ${route.from.city} → ${station.name} → ${route.to.city} in Google Maps`}
              className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-xs font-medium transition-colors hover:text-accent"
            >
              Route via here <span aria-hidden="true">↗</span>
            </a>
          )}
          <div
            className="rounded-lg bg-accent-soft px-3 py-1.5 text-center"
            title={
              Object.keys(breakdown).length > 0
                ? `Average of ${Object.entries(breakdown)
                    .map(([criterion, value]) => `${CRITERION_LABELS[criterion] ?? criterion} ${value}`)
                    .join(", ")}`
                : "Pick a ranking criterion to score this station"
            }
          >
            <div className="text-lg font-semibold tabular-nums text-accent">
              {score}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-muted">
              match
            </div>
          </div>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">Type</dt>
          <dd className="font-medium">
            {station.connectorType} ·{" "}
            {station.maxPowerKw === null ? (
              <span className="font-normal text-muted">power not reported</span>
            ) : (
              `${station.maxPowerKw} kW`
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Price</dt>
          <dd className="font-medium tabular-nums" title={priceTitle(station)}>
            {station.pricePerKwh === 0
              ? "Free"
              : `CHF ${station.pricePerKwh.toFixed(2)}/kWh`}
            {station.priceIsEstimate && (
              <span className="ml-1 text-xs font-normal text-muted">default</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">
            {station.live ? "Stalls · live" : "Stalls"}
          </dt>
          <dd className="font-medium tabular-nums">
            {station.live ? (
              <span
                title={`Federal status feed at ${liveTimeFormat.format(new Date(station.live.at))}`}
              >
                {liveFreeStalls(station)} of {station.stalls} free
                {station.live.outOfService > 0 && (
                  <span className="font-normal text-muted">
                    {" · "}
                    {station.live.outOfService} down
                  </span>
                )}
              </span>
            ) : (
              station.stalls
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Parking</dt>
          <dd className="font-medium">
            {station.parking ? (
              <ParkingTermsText parking={station.parking} />
            ) : (
              <span
                className="text-muted"
                title="Neither the federal feed nor OpenStreetMap records parking terms here"
              >
                —
              </span>
            )}
          </dd>
        </div>
      </dl>

      {Object.keys(breakdown).length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {Object.entries(breakdown).map(([criterion, value]) => (
            <span
              key={criterion}
              className="rounded-md bg-surface-muted px-2 py-0.5 text-xs text-muted tabular-nums"
            >
              {CRITERION_LABELS[criterion]} {value}
            </span>
          ))}
        </div>
      )}

      {station.greenScore !== undefined && station.greenScore !== null && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-medium">Green surroundings</h4>
            <span className="text-xs text-muted tabular-nums">
              score {station.greenScore}/100
            </span>
          </div>
          {station.green && station.green.length > 0 ? (
            <p className="mt-2 flex flex-wrap gap-1.5">
              {station.green.map((space, index) => (
                // Unnamed areas are the norm in OSM, so name alone is not a key.
                <span
                  key={`${space.name ?? space.category}-${index}`}
                  className="rounded-md bg-surface-muted px-2 py-0.5 text-xs"
                >
                  {space.name ?? GREEN_LABELS[space.category] ?? space.category}
                  <span className="text-muted">
                    {" · "}
                    {space.distanceMetres === 0
                      ? "adjacent"
                      : `${space.distanceMetres} m`}
                  </span>
                </span>
              ))}
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted">
              No park, woodland or water within walking distance.
            </p>
          )}
        </div>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-medium">Food nearby</h4>
          {foodKnown && (
            <span className="text-xs text-muted tabular-nums">
              score {foodScore}/100
            </span>
          )}
        </div>

        {belowFoodThreshold && (
          <p className="mt-2 rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">
            Below your food threshold of {threshold} — little food within
            walking distance.
          </p>
        )}

        {station.food.length > 0 ? (
          <>
            <ul className="mt-2 divide-y divide-border text-sm">
              {station.food.map((spot, index) => (
                // Two distinct OSM nodes can share a name and distance, so the
                // index is what actually guarantees a unique key here.
                <FoodRow key={`${spot.name}-${index}`} spot={spot} now={now} />
              ))}
            </ul>
            {station.foodCount != null &&
              station.foodCount > station.food.length && (
                <p className="mt-1.5 text-xs text-muted">
                  {station.foodCount - station.food.length} more within walking
                  distance
                </p>
              )}
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">
            {foodKnown
              ? "No food options recorded nearby."
              : "Nearby food data has not been collected for this station."}
          </p>
        )}
      </div>
    </article>
  );
}
