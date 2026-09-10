import assert from "node:assert/strict";
import { test } from "node:test";
import { REAL_WORLD_SHARE, rangeKm } from "./range.ts";

test("the range is the WLTP figure scaled by the charge and by real driving", () => {
  assert.equal(rangeKm(400, 100), 400 * REAL_WORLD_SHARE);
  assert.equal(rangeKm(400, 50), 200 * REAL_WORLD_SHARE);
});

test("nonsense in gives no range rather than a negative or NaN one", () => {
  assert.equal(rangeKm(400, 0), 0);
  assert.equal(rangeKm(-100, 80), 0);
  assert.equal(rangeKm(Number.NaN, 80), 0);
  // A battery cannot be fuller than full.
  assert.equal(rangeKm(400, 150), 400 * REAL_WORLD_SHARE);
});
