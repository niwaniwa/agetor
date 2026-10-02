import { expect, test } from "bun:test";
import { replayWindowHasGap } from "./replay-window";

test("an overlapping reconnect preserves loaded history", () => {
  expect(replayWindowHasGap(100, [1, 2, 100, 101])).toBe(false);
});

test("a long disconnect replaces the bounded log window so missing events can be paged", () => {
  expect(replayWindowHasGap(5000, [1, 2, 100, 101])).toBe(true);
  expect(replayWindowHasGap(5000, [])).toBe(true);
});

test("an empty replay does not imply a history gap", () => {
  expect(replayWindowHasGap(null, [1, 2])).toBe(false);
});
