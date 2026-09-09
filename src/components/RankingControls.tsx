"use client";

import {
  CRITERIA,
  REGION_CRITERIA,
  TRIP_CRITERIA,
  type Criterion,
} from "@/lib/ranking";
import type { ConnectorType } from "@/lib/types";

export type ConnectorFilter = ConnectorType | "ALL";

const CONNECTOR_FILTERS: { id: ConnectorFilter; label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "DC", label: "DC fast" },
  { id: "AC", label: "AC" },
];

function Chip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
        active
          ? "border-accent bg-accent-soft text-accent"
          : "border-border bg-surface-muted text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

export function RankingControls({
  criteria,
  onToggleCriterion,
  connector,
  onConnectorChange,
  threshold,
  onThresholdChange,
  mode,
}: {
  criteria: Criterion[];
  onToggleCriterion: (id: Criterion) => void;
  connector: ConnectorFilter;
  onConnectorChange: (id: ConnectorFilter) => void;
  threshold: number;
  onThresholdChange: (value: number) => void;
  mode: "region" | "trip";
}) {
  const available =
    mode === "trip"
      ? [...CRITERIA, ...TRIP_CRITERIA]
      : [...CRITERIA, ...REGION_CRITERIA];

  return (
    <>
      <div className="grid gap-5 sm:grid-cols-2">
        <fieldset>
          <legend className="text-xs font-medium uppercase tracking-wide text-muted">
            Rank by
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {available.map(({ id, label, hint }) => (
              <Chip
                key={id}
                active={criteria.includes(id)}
                onClick={() => onToggleCriterion(id)}
                title={hint}
              >
                {label}
              </Chip>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-xs font-medium uppercase tracking-wide text-muted">
            Connector
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {CONNECTOR_FILTERS.map(({ id, label }) => (
              <Chip
                key={id}
                active={connector === id}
                onClick={() => onConnectorChange(id)}
              >
                {label}
              </Chip>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor="threshold"
            className="text-xs font-medium uppercase tracking-wide text-muted"
          >
            Food nearby threshold
          </label>
          <span className="text-sm font-medium tabular-nums">{threshold}</span>
        </div>
        <input
          id="threshold"
          type="range"
          min={0}
          max={100}
          step={5}
          value={threshold}
          onChange={(event) => onThresholdChange(Number(event.target.value))}
          className="mt-2 w-full accent-accent"
        />
        <p className="mt-1 text-xs text-muted">
          Scores how much food is within walking distance, not how good it
          is — most of the data carries no ratings. Food never reorders
          results — spots scoring below this are flagged.
        </p>
      </div>
    </>
  );
}
