import assert from "node:assert/strict";
import { test } from "node:test";
import { STALE_AFTER_DAYS, TARIFFS, tariffAgeDays } from "./tariffs.ts";

test("every tariff is a positive price with a source and a parseable date", () => {
  for (const tariff of TARIFFS) {
    assert.ok(/^https?:\/\//.test(tariff.source), `${tariff.operator}: source is not a URL`);
    assert.ok(Number.isFinite(Date.parse(tariff.checkedOn)), `${tariff.operator}: bad checkedOn`);
    for (const key of ["ac", "dc"] as const) {
      const value = tariff[key];
      if (value === null) continue;
      assert.ok(value > 0.1 && value < 2, `${tariff.operator}: ${key} ${value} CHF/kWh is implausible`);
    }
    assert.ok(tariff.ac !== null || tariff.dc !== null, `${tariff.operator}: no price at all`);
  }
});

test(`no tariff is older than ${STALE_AFTER_DAYS} days — re-check it and update the date`, () => {
  const today = new Date();
  const stale = TARIFFS.filter((tariff) => tariffAgeDays(tariff, today) > STALE_AFTER_DAYS).map(
    (tariff) =>
      `${tariff.operator}: checked ${tariff.checkedOn} (${tariffAgeDays(tariff, today)} days ago) — verify at ${tariff.source}`,
  );
  assert.deepEqual(stale, []);
});
