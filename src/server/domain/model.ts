/**
 * Domain model mirroring db/migrations/V1__initial_schema.sql.
 *
 * Money is carried as string, not number: NUMERIC columns lose precision
 * through JS floats. Convert at the edge, with a decimal library, never with
 * parseFloat on a rate you are about to multiply.
 */

export type Money = string;

export type ChargingPointStatus =
  | "Available"
  | "Occupied"
  | "Reserved"
  | "OutOfService"
  | "Unknown"
  | "EvseNotFound";

export type CurrentType = "AC_1_PHASE" | "AC_3_PHASE" | "DC";

export type Accessibility =
  | "Paying publicly accessible"
  | "Free publicly accessible"
  | "Restricted access";

export interface ChargingLocation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  address: string | null;
  city: string | null;
  postcode: string | null;
  operatorName: string | null;
  operatorId: string | null;
  open24h: boolean | null;
  accessibility: Accessibility | null;
  source: string;
  fetchedAt: string;
  updatedAt: string;
}

export interface ChargingPoint {
  evseId: string;
  locationId: string;
  powerKw: Money | null;
  plugType: string | null;
  currentType: CurrentType | null;
  status: ChargingPointStatus;
  statusUpdatedAt: string | null;
  source: string;
  fetchedAt: string;
}

export interface Amenity {
  id: number;
  locationId: string;
  kind: string;
  name: string | null;
  cuisine: string | null;
  openingHours: string | null;
  wheelchair: string | null;
  diet: Record<string, string> | null;
  distanceM: number;
  osmType: "node" | "way" | "relation";
  osmId: number;
  source: string;
  fetchedAt: string;
}

/** Counts by amenity kind, plus the derived fields the has_food filter uses. */
export interface AmenitySummaryPayload {
  counts: Record<string, number>;
  toilets: boolean;
  nearestFoodM: number | null;
  radiusM: number;
}

export interface AmenitySummary {
  locationId: string;
  payload: AmenitySummaryPayload;
  hasFood: boolean;
  nearestFoodM: number | null;
  source: string;
  computedAt: string;
}

export interface GridOperator {
  elcomId: string;
  uid: string | null;
  name: string;
  website: string | null;
  source: string;
  fetchedAt: string;
}

export interface Municipality {
  bfsNr: number;
  name: string;
  canton: string;
  elcomId: string | null;
  source: string;
  fetchedAt: string;
}

export type ConsumptionProfile =
  | "H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "H7" | "H8";

export type TariffComponent = "energy" | "grid" | "levies" | "vat" | "total";

export type TariffBand = "high" | "low" | "flat";

/** rateRpKwh is Rappen per kWh, not CHF. */
export interface HouseholdTariff {
  elcomId: string;
  year: number;
  profile: ConsumptionProfile;
  component: TariffComponent;
  tariffBand: TariffBand;
  rateRpKwh: Money;
  bandStartsAt: string | null;
  bandEndsAt: string | null;
  bandDays: string | null;
  validFrom: string | null;
  validTo: string | null;
  source: string;
  fetchedAt: string;
}

/** All amounts CHF. */
export interface PublicTariff {
  id: number;
  cpoId: string | null;
  empId: string | null;
  stationId: string | null;
  powerMin: Money | null;
  powerMax: Money | null;
  plug: string | null;
  pricePerKwh: Money | null;
  pricePerMin: Money | null;
  sessionFee: Money | null;
  blockingFee: Money | null;
  monthlyFee: Money | null;
  currency: string;
  source: string;
  fetchedAt: string;
}

export interface IngestRun {
  id: number;
  source: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "succeeded" | "failed";
  rowsIngested: number;
  unmatchedKeys: number;
  error: string | null;
  notes: Record<string, unknown> | null;
}
