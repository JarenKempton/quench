import { expect, test } from "bun:test";
import {
  chartDays,
  chars,
  contributors,
  percent,
  windowDays,
  type HarnessReport,
} from "../src/report.ts";

const agent = (parts: HarnessReport["startParts"]): HarnessReport => ({
  harness: "claude-code",
  sessions: 4,
  subagentSessions: 0,
  runs: 4,
  inferences: 8,
  inferencesWithoutTokens: 0,
  tokensProcessed: 1000,
  startingLoadTokens: 400,
  startingLoad: { n: 4, p10: 90, p50: 100, p90: 110 },
  peakContext: { n: 4, p10: 100, p50: 200, p90: 300 },
  compactions: 0,
  compactedSessions: 0,
  models: [],
  efforts: [],
  days: [],
  startParts: parts,
});

test("contributors average over sessions, mark skills, and fold the tail", () => {
  const kinds = ["system", "tools", "instructions", "deferred_tools", "mcp_instructions"] as const;
  const rows = contributors(
    agent([
      { kind: "skills", server: null, chars: 800, sessions: 4 },
      ...kinds.map((kind, i) => ({ kind, server: null, chars: 400 - i * 50, sessions: 4 })),
      { kind: "mcp_tools", server: "linear", chars: 40, sessions: 2 },
      { kind: "mcp_tools", server: "figma", chars: 20, sessions: 1 },
    ]),
  );
  expect(rows[0]).toEqual({ label: "Skills", chars: 800, perSession: 200, skills: true });
  expect(rows.filter((r) => r.skills)).toHaveLength(1);
  expect(rows.at(-1)).toEqual({ label: "2 more", chars: 60, perSession: 15, skills: false });
  expect(rows).toHaveLength(7);
});

test("percent never rounds a real share to zero", () => {
  expect(percent(1, 1000)).toBe("<1%");
  expect(percent(0, 1000)).toBe("0%");
  expect(percent(1, 0)).toBe("–");
});

test("the window ends today and spans the chosen days", () => {
  const days = windowDays(3, new Date("2026-03-01T15:00:00Z"));
  expect(days).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
});

const today = new Date("2026-03-01T15:00:00Z");
const reportWith = (days: string[]) => ({
  days: 3,
  unreadable: 0,
  harnesses: [{ ...agent([]), days: days.map((day) => ({ day, sessions: 1, startingLoad: 100 })) }],
});

test("the chart spans every day the table lists, including a session that started before the window", () => {
  const report = reportWith(["2026-02-20", "2026-03-01"]);
  const shown = chartDays(report, today);
  expect(shown[0]).toBe("2026-02-20");
  expect(shown.at(-1)).toBe("2026-03-01");
  expect(shown).toHaveLength(10);
  for (const d of report.harnesses[0]!.days) expect(shown).toContain(d.day);
});

test("the chart keeps the chosen window when every session started inside it", () => {
  expect(chartDays(reportWith(["2026-02-28"]), today)).toEqual(windowDays(3, today));
  expect(chartDays(reportWith([]), today)).toEqual(windowDays(3, today));
});

test("contributor sizes read in characters", () => {
  expect(chars(950)).toBe("950 chars");
  expect(chars(19_250)).toBe("19.3k chars");
});
