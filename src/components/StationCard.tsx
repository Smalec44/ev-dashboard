import { routeViaStationUrl, stationMapUrl } from "@/lib/maps";
import { openState } from "@/lib/openingHours";
import type { RankedStation } from "@/lib/ranking";
import type { FoodSpot, ParkingTerms, Region } from "@/lib/types";

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
  routeProgress,
  distanceKm,
  searchedCity,
  route,
  now,
}: {
  ranked: RankedStation;
  rank: number;
  threshold: number;
  detourKm?: number;
  routeProgress?: number;
  /** Km from the searched town centre, in region mode. */
  distanceKm?: number;
  /** The town that was searched, so results from a neighbour can say so. */
  searchedCity?: string;
  /** The trip's endpoints, in trip mode: enables the "route via here" link. */
  route?: { from: Region; to: Region };
  /** Client clock for "open now", null until mount (see Dashboard). */
  now: Date | null;
}) {
  const { station, score, foodScore, foodKnown, belowFoodThreshold, breakdown } =
    ranked;

  return (
    <article className="rounded-xl border border-border bg-surface p-5">
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
              </span>
              {routeProgress !== undefined && (
                <span className="rounded-md bg-surface-muted px-2 py-0.5 text-xs text-muted tabular-nums">
                  {Math.round(routeProgress * 100)}% of the way
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-start gap-2">
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
          <div className="rounded-lg bg-accent-soft px-3 py-1.5 text-center">
            <div className="text-lg font-semibold tabular-nums text-accent">
              {score}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-muted">
              match
            </div>
          </div>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-5">
        <div>
          <dt className="text-xs text-muted">Type</dt>
          <dd className="font-medium">
            {station.connectorType} · {station.maxPowerKw} kW
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Price</dt>
          <dd className="font-medium tabular-nums">
            {station.pricePerKwh === 0 ? (
              "Free"
            ) : (
              <>
                CHF {station.pricePerKwh.toFixed(2)}/kWh
                {station.priceIsEstimate && (
                  <span
                    className="ml-1 text-xs font-normal text-muted"
                    title="Per-operator estimate — the federal feed carries no tariffs"
                  >
                    est.
                  </span>
                )}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Stalls</dt>
          <dd className="font-medium tabular-nums">{station.stalls}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Uptime</dt>
          <dd className="font-medium tabular-nums">
            {station.reliabilityPct === undefined ? (
              <span
                className="text-muted"
                title="Not published in the federal charging feed"
              >
                —
              </span>
            ) : (
              `${station.reliabilityPct}%`
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
