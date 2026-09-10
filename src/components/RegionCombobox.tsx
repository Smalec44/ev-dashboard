"use client";

import { useId, useMemo, useState } from "react";
import { REGIONS, matchRegions } from "@/data/regions";
import type { Region } from "@/lib/types";

/**
 * A text field with its own suggestion list underneath.
 *
 * This replaced a native <datalist>. The browser owns where a datalist popup
 * goes, and Chrome kept putting it beside the field rather than below it — an
 * inch to the right on a wide window, sometimes off the field entirely — with
 * nothing in CSS to say otherwise. Drawing the list ourselves costs the
 * keyboard handling below, and buys a popup that sits where a popup should.
 */

// Folded the same way findRegion folds, so pairs that differ only by diacritic
// (Brugg AG vs Brügg BE) count as ambiguous too — lowercasing alone misses them.
const foldCity = (value: string) =>
  value.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");

/**
 * Names shared across cantons (Buchs SG/AG, Wohlen AG/BE, …). Picking one of
 * these fills the field with the canton attached, so the choice is
 * unambiguous; findRegion folds the punctuation away and matches the
 * canton-qualified alias.
 */
const AMBIGUOUS_CITIES = new Set(
  REGIONS.map((r) => foldCity(r.city)).filter(
    (city, i, all) => all.indexOf(city) !== i,
  ),
);

export function regionLabel(region: Region): string {
  return AMBIGUOUS_CITIES.has(foldCity(region.city))
    ? `${region.city} (${region.canton})`
    : region.city;
}

export function RegionCombobox({
  id,
  label,
  value,
  onChange,
  placeholder,
  invalid = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Typed text that resolves to no known place; drawn in the warning colour. */
  invalid?: boolean;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  // -1 is "nothing yet": ArrowDown then lands on the first entry rather than
  // skipping past it, while Enter alone still takes the first match.
  const [highlighted, setHighlighted] = useState(-1);
  const options = useMemo(() => matchRegions(value), [value]);

  function pick(region: Region) {
    onChange(regionLabel(region));
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((i) =>
        i < 0
          ? step > 0
            ? 0
            : options.length - 1
          : (i + step + options.length) % options.length,
      );
    } else if (event.key === "Enter") {
      const choice = options[highlighted] ?? options[0];
      if (open && choice) {
        event.preventDefault();
        pick(choice);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  const showList = open && options.length > 0;

  return (
    <div className="relative">
      <label
        htmlFor={id}
        className="text-xs font-medium uppercase tracking-wide text-muted"
      >
        {label}
      </label>
      <input
        id={id}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          showList && options[highlighted]
            ? `${listId}-${options[highlighted].slug}`
            : undefined
        }
        aria-invalid={invalid}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
          // A fresh query gets a fresh cursor: keeping the old index would
          // highlight whichever place happened to land in that slot.
          setHighlighted(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className={`mt-2 w-full rounded-lg border bg-background px-3 py-2 text-base outline-none focus:border-accent ${
          invalid ? "border-warn" : "border-border"
        }`}
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-lg"
        >
          {options.map((region, index) => (
            <li
              key={region.slug}
              id={`${listId}-${region.slug}`}
              role="option"
              aria-selected={index === highlighted}
              // Mouse down, not click: click fires after the input's blur has
              // already closed the list and unmounted this row.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(region);
              }}
              onMouseEnter={() => setHighlighted(index)}
              className={`flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 text-sm ${
                index === highlighted ? "bg-accent-soft text-accent" : ""
              }`}
            >
              <span>{region.city}</span>
              <span className="text-xs text-muted">{region.canton}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
