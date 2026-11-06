import { expect, test } from "bun:test";
import { settled, type State } from "../src/use-api.ts";

const ready: State<{ n: number }> = {
  status: "ready",
  report: { n: 1 },
  computedAt: "2026-11-06T06:00:00.000Z",
  refreshing: true,
  refreshError: null,
};

test("a failed refresh keeps the page and shows the error beside it", () => {
  expect(settled(ready, { error: "HTTP 500" })).toEqual({
    ...ready,
    refreshing: false,
    refreshError: "HTTP 500",
  });
});

test("a failed first load has nothing to keep, so it is an error", () => {
  expect(settled({ status: "loading" }, { error: "HTTP 500" })).toEqual({
    status: "error",
    message: "HTTP 500",
  });
});

test("a later answer replaces the report and carries the server's refresh state", () => {
  const later = {
    report: { n: 2 },
    computedAt: "2026-11-06T06:10:00.000Z",
    refreshing: false,
    refreshError: "scan failed",
  };
  expect(settled({ ...ready, refreshError: "HTTP 500" }, later)).toEqual({
    status: "ready",
    ...later,
  });
});
