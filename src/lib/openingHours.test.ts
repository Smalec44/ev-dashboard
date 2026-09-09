import { test } from "node:test";
import assert from "node:assert/strict";
import { openState } from "./openingHours.ts";

// Wednesday, 9 Sept 2026 — a plain midweek weekday to build test times from.
function at(hour: number, minute = 0): Date {
  return new Date(2026, 8, 9, hour, minute);
}

test("24/7 is always open", () => {
  assert.equal(openState("24/7", at(3, 30)), "open");
  assert.equal(openState("24/7", at(23, 59)), "open");
});

test("a normal weekday spec is open inside the window", () => {
  assert.equal(openState("Mo-Fr 09:00-18:00", at(12, 0)), "open");
});

test("a normal weekday spec is closed outside the window", () => {
  assert.equal(openState("Mo-Fr 09:00-18:00", at(20, 0)), "closed");
});

test("a multi-range day is open in the second range and closed in the gap", () => {
  const spec = "Mo-Fr 11:00-14:00,18:00-23:00";
  assert.equal(openState(spec, at(19, 0)), "open");
  assert.equal(openState(spec, at(15, 0)), "closed");
});

test("a midnight-crossing range is open just after midnight the next day", () => {
  // Thursday 10 Sept 2026, 01:00 — the tail of a Wednesday 20:00-02:00 rule.
  const thursdayEarly = new Date(2026, 8, 10, 1, 0);
  assert.equal(openState("We 20:00-02:00", thursdayEarly), "open");
});

test("a midnight-crossing range is closed mid-afternoon", () => {
  assert.equal(openState("Fr-Sa 20:00-02:00", at(15, 0)), "closed");
});

test("day list with comma and range parses correctly", () => {
  assert.equal(openState("Mo-Fr,Su 09:00-22:00", at(12, 0)), "open");
});

test("public holiday syntax is unknown", () => {
  assert.equal(openState("Mo-Fr 09:00-18:00; PH off", at(12, 0)), "unknown");
});

test("sunset/sunrise syntax is unknown", () => {
  assert.equal(openState("Mo-Su sunset-sunrise", at(12, 0)), "unknown");
});

test("month range syntax is unknown", () => {
  assert.equal(openState("Jun-Aug 09:00-20:00", at(12, 0)), "unknown");
});

test("missing spec is unknown", () => {
  assert.equal(openState(undefined, at(12, 0)), "unknown");
});

// --- Gap 1: whitespace around separators ---------------------------------

test("whitespace after a comma in a day list is tolerated", () => {
  assert.equal(openState("Mo-Th 08:00-22:00; Fr, Sa 08:00-24:00; Su 09:00-22:00", at(12, 0)), "open");
  // Saturday 09:00 falls in the "Fr, Sa 08:00-24:00" rule.
  const sat9 = new Date(2026, 8, 12, 9, 0);
  assert.equal(openState("Mo-Th 08:00-22:00; Fr, Sa 08:00-24:00; Su 09:00-22:00", sat9), "open");
});

test("whitespace around a semicolon is tolerated", () => {
  assert.equal(openState("Mo-Fr 09:00-17:00 ; Sa 10:00-14:00", at(12, 0)), "open");
});

// --- Gap 2: 24:00 / 00:00 as an end-of-day marker -------------------------

test("24:00 as an end time means open until midnight", () => {
  const sat23 = new Date(2026, 8, 12, 23, 30);
  assert.equal(openState("Fr,Sa 08:00-24:00", sat23), "open");
});

test("00:00 as an end time means open until midnight, not a zero-length range", () => {
  // Wed 23:30 should be open (06:30-00:00 means "until end of day").
  const wed2330 = new Date(2026, 8, 9, 23, 30);
  assert.equal(openState("Mo-Th 06:30-00:00", wed2330), "open");
  // And it must NOT wrap around to reopen the next day at 00:00.
  const thu0 = new Date(2026, 8, 10, 0, 0);
  assert.equal(openState("Mo-Th 06:30-00:00", thu0), "closed");
});

test("00:00 end-of-day marker composes with a genuine midnight-crossing rule elsewhere", () => {
  const spec = "Mo-Th 06:30-00:00; Fr-Sa 20:00-02:00";
  // Wednesday 23:30 — inside the Mo-Th end-of-day rule.
  assert.equal(openState(spec, new Date(2026, 8, 9, 23, 30)), "open");
  // Saturday 01:00 — the crossing tail of the Friday 20:00-02:00 rule.
  assert.equal(openState(spec, new Date(2026, 8, 12, 1, 0)), "open");
  // Thursday 00:00 must not be reopened by the Mo-Th 00:00 marker.
  assert.equal(openState(spec, new Date(2026, 8, 10, 0, 0)), "closed");
});

// --- Gap 3: weekday off/closed exceptions ---------------------------------

test("a weekday marked off is closed, other days unaffected", () => {
  // Migrated from the adversarial suite: after Gap 3 this is "open", not
  // "unknown" — Wed 14:00 falls inside the Mo-Fr rule and Sa off doesn't
  // touch Wednesday.
  assert.equal(openState("Mo-Fr 09:00-17:00; Sa off", at(14, 0)), "open");
  const sat12 = new Date(2026, 8, 12, 12, 0);
  assert.equal(openState("Mo-Fr 09:00-17:00; Sa off", sat12), "closed");
});

test("a weekday marked closed (instead of off) is closed", () => {
  const mon12 = new Date(2026, 8, 7, 12, 0); // Monday
  assert.equal(openState("Mo closed; Tu-Th 11:30-23:00", mon12), "closed");
  assert.equal(openState("Mo closed; Tu-Th 11:30-23:00", at(12, 0)), "open"); // Wednesday, in Tu-Th
});

test("a later rule overrides an earlier one for the days it names", () => {
  const spec = "Mo-Su 10:00-18:00; Su off";
  assert.equal(openState(spec, at(12, 0)), "open"); // Wednesday, unaffected
  const sun12 = new Date(2026, 8, 13, 12, 0);
  assert.equal(openState(spec, sun12), "closed"); // Sunday, overridden to closed
});

test("PH off still fails closed to unknown even though weekday off is now supported", () => {
  assert.equal(openState("Mo-Fr 09:00-18:00; PH off", at(12, 0)), "unknown");
});

test("SH off still fails closed to unknown", () => {
  assert.equal(openState("Mo-Fr 09:00-18:00; SH off", at(12, 0)), "unknown");
});
