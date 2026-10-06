import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults } from "../src/lib/types";
import { estimatedSlots, withinWindow, nextWindow } from "../src/lib/schedule";
test("Prague window opens at 07:00 and closes at 21:00", () => {
  assert.equal(withinWindow(new Date("2026-10-06T04:59:59Z"), defaults), false);
  assert.equal(withinWindow(new Date("2026-10-06T05:00:00Z"), defaults), true);
  assert.equal(withinWindow(new Date("2026-10-06T19:00:00Z"), defaults), false);
});
test("Estimates respect the last confirmed publication and carry over overnight", () => {
  const slots = estimatedSlots(
    { ...defaults, last_publication_at: "2026-10-06T18:20:00Z" },
    2,
    new Date("2026-10-06T18:25:00Z"),
  );
  assert.equal(slots[0].toISOString(), "2026-10-07T05:00:00.000Z");
  assert.equal(slots[1].toISOString(), "2026-10-07T06:00:00.000Z");
});
test("DST changes keep the local 07:00 start", () => {
  assert.equal(
    nextWindow(new Date("2026-10-24T23:00:00Z"), defaults).toISOString(),
    "2026-10-25T06:00:00.000Z",
  );
  assert.equal(
    nextWindow(new Date("2026-03-28T23:00:00Z"), defaults).toISOString(),
    "2026-03-29T05:00:00.000Z",
  );
});
