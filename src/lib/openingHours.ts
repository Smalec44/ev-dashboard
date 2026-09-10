/**
 * Conservative reader for OSM `opening_hours` strings.
 *
 * The full grammar covers public/school holidays, month and week ranges,
 * sunrise/sunset, and comments — implementing all of that correctly is a
 * project in itself, and getting it subtly wrong sends someone to a locked
 * door. This parses only a whitelisted subset and returns "unknown" for
 * anything else, including syntax it recognises but chooses not to
 * interpret (PH, SH, month names, "week", sunrise/sunset, "+", quoted
 * comments) and any unrecognised trailing tokens.
 *
 * Supported subset:
 *  - 24/7
 *  - weekday lists/ranges ("Mo-Fr", "Fr,Sa", "Mo-Fr,Su"), tolerant of
 *    whitespace around "," and ";"
 *  - multiple time ranges per day ("11:00-14:00,18:00-23:00")
 *  - midnight-crossing ranges ("20:00-02:00"), including "24:00"/"00:00"
 *    used as an end-of-day marker rather than a zero-length range
 *    ("Mo-Th 06:30-00:00" means open until midnight, not "for zero
 *    minutes")
 *  - several rules separated by ";", where a later rule overrides an
 *    earlier one for the days it names (standard OSM semantics — e.g.
 *    "Mo-Su 10:00-18:00; Su off" is closed Sunday)
 *  - a weekday selector followed by "off" or "closed" ("Sa off",
 *    "Mo closed") marking those days closed — but NOT a holiday selector
 *    ("PH off", "SH off" still fail closed to "unknown", since holidays
 *    can't be resolved without a calendar)
 */

export type OpenState = "open" | "closed" | "unknown";

/** Date#getDay() convention: 0 = Sunday. */
type Day = number;

/**
 * Opening hours in the feed are the venue's own local time, and every venue
 * here is in Switzerland. Reading them against the viewer's clock told anyone
 * outside CET the wrong thing: a Zurich cafe genuinely open at 09:00 read as
 * "closed now" to a viewer in New York. Resolve the instant in Swiss time.
 */
const VENUE_TIME_ZONE = "Europe/Zurich";

/** Built once: constructing a formatter per call is the expensive part. */
const venueClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: VENUE_TIME_ZONE,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const WEEKDAY_CODES: Record<string, Day> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** The weekday and wall-clock minute at the venue, for an absolute instant. */
function venueTime(now: Date): { day: Day; minutes: number } | null {
  const parts = venueClock.formatToParts(now);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const day = WEEKDAY_CODES[value("weekday")];
  if (day === undefined) return null;
  return { day, minutes: Number(value("hour")) * 60 + Number(value("minute")) };
}

const DAY_CODES: Record<string, Day> = {
  Su: 0,
  Mo: 1,
  Tu: 2,
  We: 3,
  Th: 4,
  Fr: 5,
  Sa: 6,
};
const ALL_DAYS = Object.values(DAY_CODES);

interface DayInterval {
  day: Day;
  /** Minutes since midnight, inclusive. */
  startMinute: number;
  /** Minutes since midnight, exclusive; up to 1440. */
  endMinute: number;
}

const DAY_RE = "(?:Mo|Tu|We|Th|Fr|Sa|Su)";
const DAY_RANGE_RE = `${DAY_RE}(?:-${DAY_RE})?`;
const DAY_LIST_RE = `${DAY_RANGE_RE}(?:\\s*,\\s*${DAY_RANGE_RE})*`;
const TIME_RE = "(?:[01]\\d|2[0-4]):[0-5]\\d";
const TIME_RANGE_RE = `${TIME_RE}-${TIME_RE}`;
const TIME_LIST_RE = `${TIME_RANGE_RE}(?:\\s*,\\s*${TIME_RANGE_RE})*`;

/** A rule is an optional day list (default: every day) plus a time list. */
const CLAUSE_RE = new RegExp(`^(?:(${DAY_LIST_RE})\\s+)?(${TIME_LIST_RE})$`);

/** A weekday (never a holiday) selector marking those days closed. */
const OFF_CLAUSE_RE = new RegExp(`^(${DAY_LIST_RE})\\s+(?:off|closed)$`);

/**
 * Tokens from the wider grammar that we deliberately do not interpret.
 * Most of these would already fail CLAUSE_RE/OFF_CLAUSE_RE, but checking
 * explicitly documents the boundary and catches them even inside forms
 * we'd otherwise parse (e.g. a day list that also mentions "PH"). Note
 * "off"/"closed" are intentionally NOT listed here — those are handled
 * per-clause so that a weekday selector can use them while a holiday
 * selector (still matched by PH/SH below) keeps failing closed.
 */
const UNSUPPORTED_RE =
  /\b(?:PH|SH|week|sunset|sunrise|dusk|dawn)\b|[+"]|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/;

function expandDays(list: string): Day[] {
  const days = new Set<Day>();
  for (const part of list.split(",")) {
    const [from = "", to] = part.trim().split("-");
    const fromDay = DAY_CODES[from];
    // The clause regexes only admit known codes, so this never fires; the
    // lookup is still typed as possibly missing and the compiler is right.
    if (fromDay === undefined) continue;
    if (to === undefined) {
      days.add(fromDay);
      continue;
    }
    // Walk forward with wraparound so "Fr-Mo" (spanning the week boundary)
    // resolves the same way OSM's range semantics do.
    const toDay = DAY_CODES[to];
    if (toDay === undefined) continue;
    let cursor: Day = fromDay;
    days.add(cursor);
    while (cursor !== toDay) {
      cursor = (cursor + 1) % 7;
      days.add(cursor);
    }
  }
  return [...days];
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Result of parsing one ";"-separated rule.
 *
 * An ordinary time rule is additive: its intervals are unioned with
 * whatever other rules contribute, which matches how real-world specs
 * commonly split a day into multiple clauses (e.g. a separate lunch and
 * dinner rule for the same days). An "off"/"closed" rule is different:
 * it's an explicit exception, so it `clears` whatever was previously
 * recorded for the days it names before contributing its (empty) own
 * hours — which is what gives it override precedence over an earlier
 * rule for those days (e.g. "Su off" after "Mo-Su 10:00-18:00").
 *
 * `spill` is the midnight-crossing tail that lands on the *following*
 * day; it's always additive, since it's not that day's own rule, just
 * the overnight remainder of this one.
 */
interface ClauseResult {
  days: Day[];
  clears: boolean;
  own: DayInterval[];
  spill: DayInterval[];
}

/** Returns null when the clause falls outside the supported subset. */
function parseClause(clause: string): ClauseResult | null {
  if (clause === "24/7") {
    return {
      days: ALL_DAYS,
      clears: false,
      own: ALL_DAYS.map((day) => ({ day, startMinute: 0, endMinute: 1440 })),
      spill: [],
    };
  }

  const offMatch = OFF_CLAUSE_RE.exec(clause);
  if (offMatch) {
    return { days: expandDays(offMatch[1] ?? ""), clears: true, own: [], spill: [] };
  }

  const match = CLAUSE_RE.exec(clause);
  if (!match) return null;

  const [, dayList, timeList = ""] = match;
  const days = dayList ? expandDays(dayList) : ALL_DAYS;

  const own: DayInterval[] = [];
  const spill: DayInterval[] = [];
  for (const day of days) {
    for (const timeRange of timeList.split(",")) {
      const [startStr = "", endStr = ""] = timeRange.trim().split("-");
      const start = toMinutes(startStr);
      const end = toMinutes(endStr);
      if (end > start) {
        own.push({ day, startMinute: start, endMinute: end });
      } else {
        // Crosses midnight (e.g. 20:00-02:00), or the end time is
        // "24:00"/"00:00" used as an end-of-day marker (e.g.
        // "06:30-00:00"). Either way the day's own portion runs to
        // midnight, and only a genuine remainder past midnight (end > 0)
        // spills onto the following day — otherwise "00:00" would
        // wrongly reopen the next day for zero minutes.
        own.push({ day, startMinute: start, endMinute: 1440 });
        if (end > 0) {
          spill.push({ day: (day + 1) % 7, startMinute: 0, endMinute: end });
        }
      }
    }
  }
  return { days, clears: false, own, spill };
}

export function openState(spec: string | undefined, now: Date): OpenState {
  if (!spec) return "unknown";
  const trimmed = spec.trim();
  if (trimmed === "" || UNSUPPORTED_RE.test(trimmed)) return "unknown";

  const clauses = trimmed
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c !== "");
  if (clauses.length === 0) return "unknown";

  const dayIntervals = new Map<Day, DayInterval[]>();
  for (const day of ALL_DAYS) dayIntervals.set(day, []);

  for (const clause of clauses) {
    const parsed = parseClause(clause);
    if (parsed === null) return "unknown";
    // An "off"/"closed" rule overrides earlier rules for the days it
    // names (e.g. "Su off" after "Mo-Su 10:00-18:00"); ordinary time
    // rules are additive, so a day split across multiple clauses (e.g.
    // separate lunch/dinner rules) still unions correctly.
    if (parsed.clears) {
      for (const day of parsed.days) dayIntervals.set(day, []);
    }
    for (const interval of parsed.own) dayIntervals.get(interval.day)?.push(interval);
    for (const interval of parsed.spill) dayIntervals.get(interval.day)?.push(interval);
  }

  const at = venueTime(now);
  if (at === null) return "unknown";
  const { day, minutes } = at;
  const isOpen = (dayIntervals.get(day) ?? []).some(
    (interval) => minutes >= interval.startMinute && minutes < interval.endMinute,
  );
  return isOpen ? "open" : "closed";
}
