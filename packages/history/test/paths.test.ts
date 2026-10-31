import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessById, isInside, pathParts } from "../src/index.ts";
import { sessionRef } from "../src/harness.ts";
import { describeServer } from "../src/mcp.ts";

test("path parts split on either separator", () => {
  expect(pathParts("C:\\Users\\me\\code\\app")).toEqual(["C:", "Users", "me", "code", "app"]);
  expect(pathParts("C:/Users/me/code/app/")).toEqual(["C:", "Users", "me", "code", "app"]);
  expect(pathParts("/home/me/app")).toEqual(["home", "me", "app"]);
});

test("a path is inside a directory with either separator, never a sibling prefix", () => {
  expect(isInside("C:\\Users\\me\\app", "C:\\Users\\me")).toBe(true);
  expect(isInside("/home/me/app", "/home/me")).toBe(true);
  expect(isInside("C:\\Users\\meg\\app", "C:\\Users\\me")).toBe(false);
  expect(isInside("C:\\Users\\me", "C:\\Users\\me")).toBe(false);
});

test("an MCP command on Windows shows its program name", () => {
  expect(describeServer({ command: "C:\\Program Files\\nodejs\\npx.cmd" }).target).toBe("npx.cmd");
  expect(describeServer({ command: "/usr/local/bin/uvx" }).target).toBe("uvx");
});

test("Codex skill listings resolve Windows roots and either separator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quench-paths-"));
  const base = "C:\\Users\\me\\.codex\\skills";
  const block = [
    "<skills_instructions>",
    `- \`r0\` = \`${base}\``,
    "- notes: Take notes (file: r0\\notes\\SKILL.md)",
    "- plan: Plan (file: r0/plan/SKILL.md)",
    "</skills_instructions>",
  ].join("\n");
  const file = join(dir, "rollout.jsonl");
  await Bun.write(
    file,
    [
      { type: "session_meta", payload: { id: "w", cwd: "C:\\Users\\me\\app" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: block }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  const session = await harnessById.codex.read(await sessionRef("codex", file));
  const listing = session.events.find((e) => e.type === "skills");
  expect(listing?.type === "skills" && listing.listed).toEqual([
    { name: "notes", path: join(base, "notes", "SKILL.md") },
    { name: "plan", path: join(base, "plan", "SKILL.md") },
  ]);
  await rm(dir, { recursive: true });
});
