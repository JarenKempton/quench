import { expect, test } from "bun:test";
import { settled, type State } from "../src/use-api.ts";

const at = new Date("2026-11-06T06:00:00Z");
const ready: State<{ n: number }> = {
  status: "ready",
  report: { n: 1 },
  computedAt: at,
  refreshing: true,
  error: null,
};

test("a failed refresh keeps the page and shows the error beside it", () => {
  expect(settled(ready, { error: "HTTP 500" })).toEqual({
    ...ready,
    refreshing: false,
    error: "HTTP 500",
  });
});

test("a failed first load has nothing to keep, so it is an error", () => {
  expect(settled({ status: "loading" }, { error: "HTTP 500" })).toEqual({
    status: "error",
    message: "HTTP 500",
  });
});

test("a later success replaces the report and clears the error", () => {
  const later = new Date("2026-11-06T06:10:00Z");
  expect(settled({ ...ready, error: "HTTP 500" }, { report: { n: 2 }, computedAt: later })).toEqual(
    { status: "ready", report: { n: 2 }, computedAt: later, refreshing: false, error: null },
  );
});
