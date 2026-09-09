-- Swiss EV dashboard — initial schema.
--
-- Conventions enforced here:
--   * Money is NUMERIC, never float. Household tariffs in Rappen/kWh,
--     public charging tariffs in CHF.
--   * Every table carries `source` and `fetched_at`; four upstream sources
--     disagree and we need to know who said what.
--   * Upstream enums are stored as text with CHECK constraints rather than
--     Postgres ENUMs, because BFE/OICP add values without notice and an
--     unknown value must not fail an ingest run.

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- Provenance: raw payloads for the last N runs (cross-cutting rule 3)
-- ---------------------------------------------------------------------------

CREATE TABLE ingest_run (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source        TEXT        NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT        NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running', 'succeeded', 'failed')),
  rows_ingested INTEGER     NOT NULL DEFAULT 0,
  unmatched_keys INTEGER    NOT NULL DEFAULT 0,
  error         TEXT,
  notes         JSONB
);

CREATE INDEX ingest_run_source_started_idx ON ingest_run (source, started_at DESC);

CREATE TABLE raw_response (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ingest_run_id BIGINT      NOT NULL REFERENCES ingest_run (id) ON DELETE CASCADE,
  url           TEXT        NOT NULL,
  http_status   INTEGER,
  etag          TEXT,
  last_modified TEXT,
  body          BYTEA,
  byte_size     INTEGER,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX raw_response_run_idx ON raw_response (ingest_run_id);

-- ---------------------------------------------------------------------------
-- Source A: ich-tanke-strom / BFE
-- ---------------------------------------------------------------------------

CREATE TABLE charging_location (
  id            TEXT PRIMARY KEY,
  name          TEXT        NOT NULL,
  geom          GEOGRAPHY(Point, 4326) NOT NULL,
  address       TEXT,
  city          TEXT,
  postcode      TEXT,
  operator_name TEXT,
  operator_id   TEXT,
  open_24h      BOOLEAN,
  -- 'Paying publicly accessible' | 'Free publicly accessible' | 'Restricted access'
  accessibility TEXT,
  source        TEXT        NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX charging_location_geom_idx ON charging_location USING GIST (geom);
CREATE INDEX charging_location_city_idx ON charging_location (city);

-- EvseID shape varies (CH*CCI*E22078, CH*SWIEE9973) — treat as opaque text.
CREATE TABLE charging_point (
  evse_id           TEXT PRIMARY KEY,
  location_id       TEXT        NOT NULL REFERENCES charging_location (id) ON DELETE CASCADE,
  power_kw          NUMERIC(8, 2),
  plug_type         TEXT,
  -- AC_1_PHASE | AC_3_PHASE | DC; null when upstream leaves it blank
  current_type      TEXT CHECK (current_type IN ('AC_1_PHASE', 'AC_3_PHASE', 'DC')),
  -- ~9% of the live feed reports Unknown; it is a real state, not missing data
  status            TEXT NOT NULL DEFAULT 'Unknown'
                    CHECK (status IN ('Available', 'Occupied', 'Reserved',
                                      'OutOfService', 'Unknown', 'EvseNotFound')),
  status_updated_at TIMESTAMPTZ,
  source            TEXT        NOT NULL,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX charging_point_location_idx ON charging_point (location_id);
CREATE INDEX charging_point_status_idx ON charging_point (status);
CREATE INDEX charging_point_power_idx ON charging_point (power_kw);

-- ---------------------------------------------------------------------------
-- Source E: OpenStreetMap amenities (ODbL)
-- ---------------------------------------------------------------------------

CREATE TABLE amenity (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  location_id   TEXT        NOT NULL REFERENCES charging_location (id) ON DELETE CASCADE,
  kind          TEXT        NOT NULL,
  name          TEXT,
  cuisine       TEXT,
  opening_hours TEXT,
  wheelchair    TEXT,
  diet          JSONB,
  distance_m    INTEGER     NOT NULL,
  osm_type      TEXT        NOT NULL CHECK (osm_type IN ('node', 'way', 'relation')),
  osm_id        BIGINT      NOT NULL,
  source        TEXT        NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, osm_type, osm_id)
);

CREATE INDEX amenity_location_idx ON amenity (location_id);
CREATE INDEX amenity_kind_idx ON amenity (kind);

-- Derived per-location rollup; what the has_food filter reads.
CREATE TABLE amenity_summary (
  location_id   TEXT PRIMARY KEY REFERENCES charging_location (id) ON DELETE CASCADE,
  payload       JSONB       NOT NULL,
  has_food      BOOLEAN     NOT NULL DEFAULT false,
  nearest_food_m INTEGER,
  source        TEXT        NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX amenity_summary_has_food_idx ON amenity_summary (has_food);

-- ---------------------------------------------------------------------------
-- Sources B/C: ElCom household tariffs
-- ---------------------------------------------------------------------------

CREATE TABLE grid_operator (
  elcom_id   TEXT PRIMARY KEY,
  uid        TEXT,
  name       TEXT        NOT NULL,
  website    TEXT,
  source     TEXT        NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE municipality (
  bfs_nr     INTEGER PRIMARY KEY,
  name       TEXT        NOT NULL,
  canton     TEXT        NOT NULL,
  elcom_id   TEXT        REFERENCES grid_operator (elcom_id),
  source     TEXT        NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX municipality_elcom_idx ON municipality (elcom_id);

-- Rates in Rappen/kWh. Year is part of the key: never overwrite a past year.
CREATE TABLE household_tariff (
  elcom_id     TEXT        NOT NULL REFERENCES grid_operator (elcom_id),
  year         INTEGER     NOT NULL,
  profile      TEXT        NOT NULL CHECK (profile IN ('H1','H2','H3','H4','H5','H6','H7','H8')),
  component    TEXT        NOT NULL CHECK (component IN ('energy', 'grid', 'levies', 'vat', 'total')),
  tariff_band  TEXT        NOT NULL DEFAULT 'flat' CHECK (tariff_band IN ('high', 'low', 'flat')),
  rate_rp_kwh  NUMERIC(10, 4) NOT NULL,
  -- Time windows are what make overnight charging worth scheduling.
  band_starts_at TIME,
  band_ends_at   TIME,
  band_days      TEXT,
  valid_from   DATE,
  valid_to     DATE,
  source       TEXT        NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (elcom_id, year, profile, component, tariff_band)
);

CREATE INDEX household_tariff_year_idx ON household_tariff (year, profile);

-- ---------------------------------------------------------------------------
-- Source D: public charging tariffs (Chargeprice) — CHF
-- ---------------------------------------------------------------------------

CREATE TABLE public_tariff (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cpo_id        TEXT,
  emp_id        TEXT,
  station_id    TEXT REFERENCES charging_location (id) ON DELETE CASCADE,
  power_min     NUMERIC(8, 2),
  power_max     NUMERIC(8, 2),
  plug          TEXT,
  price_per_kwh NUMERIC(10, 4),
  price_per_min NUMERIC(10, 4),
  session_fee   NUMERIC(10, 4),
  blocking_fee  NUMERIC(10, 4),
  monthly_fee   NUMERIC(10, 4),
  currency      TEXT        NOT NULL DEFAULT 'CHF',
  source        TEXT        NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX public_tariff_station_idx ON public_tariff (station_id);
CREATE INDEX public_tariff_cpo_idx ON public_tariff (cpo_id, emp_id);
