/**
 * Source interfaces (cross-cutting rule 2). Every external source sits behind
 * one of these so tests run offline against a stub.
 */
import type {
  Amenity,
  ChargingLocation,
  ChargingPoint,
  ChargingPointStatus,
  GridOperator,
  HouseholdTariff,
  Municipality,
  PublicTariff,
} from "./model";

export interface RawFetch {
  url: string;
  httpStatus: number;
  etag: string | null;
  lastModified: string | null;
  body: Buffer;
}

/** Reported after every ingest step, per the spec's per-deliverable report. */
export interface IngestReport {
  source: string;
  rowsIngested: number;
  unmatchedKeys: string[];
  unmappedFields: string[];
  notes?: Record<string, unknown>;
}

export interface ChargerSnapshot {
  locations: ChargingLocation[];
  points: ChargingPoint[];
  report: IngestReport;
}

export interface ChargerSource {
  readonly id: string;
  /** Full master-data pull. Expensive; daily at most. */
  fetchStatic(): Promise<ChargerSnapshot>;
  /**
   * Availability only, keyed by EvseID. Conditional GET: returns null when
   * upstream reports Not Modified, so the caller skips the write entirely.
   */
  fetchStatus(previous?: {
    etag: string | null;
    lastModified: string | null;
  }): Promise<{
    statuses: Map<string, ChargingPointStatus>;
    etag: string | null;
    lastModified: string | null;
    report: IngestReport;
  } | null>;
}

export interface AmenitySource {
  readonly id: string;
  /**
   * Amenities around one point. Implementations must respect the upstream
   * fair-use policy (serialised calls, backoff on 429/504) — callers batch
   * offline and never invoke this from a request path.
   */
  fetchAround(
    lat: number,
    lon: number,
    radiusM: number,
  ): Promise<Omit<Amenity, "id" | "locationId">[]>;
}

export interface HouseholdTariffSource {
  readonly id: string;
  fetchOperators(): Promise<GridOperator[]>;
  fetchMunicipalities(): Promise<Municipality[]>;
  fetchTariffs(year: number): Promise<HouseholdTariff[]>;
}

export interface PublicTariffSource {
  readonly id: string;
  readonly enabled: boolean;
  /** Batched: callers must chunk station ids to the provider's per-call cap. */
  fetchTariffs(stationIds: string[]): Promise<PublicTariff[]>;
}

export interface Attribution {
  source: string;
  text: string;
  url: string;
  licence: string;
  /** True where the licence needs written permission for commercial use. */
  commercialUseRestricted: boolean;
}
