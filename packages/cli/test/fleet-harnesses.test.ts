import { expect, test } from "bun:test";
import { HARNESSES, type HarnessId as FleetHarness } from "@quench/fleet";
import { harnesses, type HarnessId } from "@quench/history";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same: Same<FleetHarness, HarnessId> = true;

test("fleet contracts name exactly the harnesses history has adapters for", () => {
  expect(same).toBe(true);
  expect([...HARNESSES].sort()).toEqual(harnesses.map((h) => h.id).sort());
});
