import { expect, test } from "bun:test";
import { evidenceOf } from "../src/tasks.ts";

test("evidence ids become GitHub links, ticket and branch names, or a session turn", () => {
  expect(evidenceOf("github:acme/widget#42")).toEqual({
    label: "acme/widget#42",
    href: "https://github.com/acme/widget/issues/42",
  });
  expect(evidenceOf("jira:CSU-12")).toEqual({ label: "CSU-12", href: null });
  expect(evidenceOf("branch:t3/tasks")).toEqual({ label: "t3/tasks", href: null });
  expect(evidenceOf("claude-code:0a1b2c3d-4e5f#3")).toEqual({
    label: "Claude Code 0a1b2c3d turn 4",
    href: null,
  });
  expect(evidenceOf("codex:rollout-x#0").href).toBeNull();
});
