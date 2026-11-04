import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { quoteArg, shellFor } from "@quench/history";

import { lines, quench } from "./run.ts";

const skill = (dir: string) =>
  Bun.write(join(dir, "SKILL.md"), `---\nname: ${basename(dir)}\ndescription: d\n---\n`);

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-cuts-")));
  const work = join(home, "work");
  await mkdir(work, { recursive: true });

  await skill(join(home, ".claude/skills/notes"));
  await skill(join(home, ".claude/skills/keep"));
  await skill(join(work, ".claude/skills/deploy"));
  await Bun.write(
    join(home, ".claude/plugins/installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "acme@tools": [{ scope: "user" }] } }),
  );
  const names = ["notes", "keep", "deploy", "simplify", "acme:lint", "gone"];
  const claude = lines([
    {
      type: "attachment",
      cwd: work,
      attachment: {
        type: "skill_listing",
        names,
        content: names.map((n) => `- ${n}: does ${n}`).join("\n"),
      },
    },
    {
      type: "assistant",
      cwd: work,
      message: {
        content: [{ type: "tool_use", id: "k", name: "Skill", input: { skill: "keep" } }],
      },
    },
  ]);
  await Bun.write(join(home, ".claude/projects/p/one.jsonl"), claude);
  await Bun.write(join(home, ".claude/projects/p/two.jsonl"), claude);

  const codex = join(home, ".codex");
  const cache = join(codex, "plugins/cache");
  await skill(join(codex, "skills/tidy"));
  await skill(join(codex, "skills/.system/plan"));
  const marker = (dir: string, id: string) =>
    Bun.write(
      join(dir, ".codex-remote-plugin-install.json"),
      JSON.stringify({ schema_version: 1, remote_plugin_id: id }),
    );
  await marker(join(cache, "openai-curated-remote/pages"), "p-pages");
  await marker(join(cache, "openai-curated-remote/vercel"), "p-vercel");
  await skill(join(cache, "debug/sample/1.0/skills/hello"));
  await Bun.write(
    join(codex, "cache/remote_plugin_catalog/c.json"),
    JSON.stringify({
      plugins: [
        { id: "p-pages", installation_policy: "INSTALLED_BY_DEFAULT" },
        { id: "p-other", installation_policy: "AVAILABLE" },
      ],
    }),
  );
  const block = [
    "<skills_instructions>",
    "### Skill roots",
    `- \`r0\` = \`${join(codex, "skills")}\``,
    `- \`r1\` = \`${cache}\``,
    "### Available skills",
    "- tidy: Tidy up (file: r0/tidy/SKILL.md)",
    "- plan: Plan (file: r0/.system/plan/SKILL.md)",
    "- pages:write-page: Write a page (file: r1/openai-curated-remote/pages/1.0/skills/write-page/SKILL.md)",
    "- vercel:ai-sdk: Use the AI SDK (file: r1/openai-curated-remote/vercel/1.0/skills/ai-sdk/SKILL.md)",
    "- sample:hello: Say hello (file: r1/debug/sample/1.0/skills/hello/SKILL.md)",
    "- figma:figma-use: Use Figma (file: r1/openai-curated-remote/figma/1.0/skills/figma-use/SKILL.md)",
    "</skills_instructions>",
  ].join("\n");
  await Bun.write(
    join(codex, "sessions/2026/10/20/c.jsonl"),
    lines([
      { type: "session_meta", payload: { id: "c", cwd: work } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: block }],
        },
      },
    ]),
  );
  return home;
}

const rm = (home: string, path: string) =>
  shellFor() === "posix"
    ? `rm -r -- ~/${path}`
    : `Remove-Item -Recurse -LiteralPath ${quoteArg(join(home, path), "powershell")}`;

test("profile skills names each skill's source and ranks a cut list with commands", async () => {
  const home = await fixture();
  const { stdout, code } = await quench(home, "profile", "skills");
  expect(code).toBe(0);
  expect(stdout).toContain(
    "  Claude Code         2       6     131 chars     1         1           4",
  );
  expect(stdout).toContain(
    [
      "  Sources · Claude Code: 2 user folder · 1 plugin · 1 project folder · 1 not on disk now · 1 built-in",
      "  Most used · Claude Code: keep 2",
      "  Built in, can't be removed · Claude Code: simplify",
      "  Sources · Codex: 3 plugin · 1 not on disk now · 1 built-in · 1 user folder",
      "  Built in, can't be removed · Codex: plan",
    ].join("\n"),
  );
  const cut = stdout.slice(stdout.indexOf("▍Cut list"));
  expect(cut).toContain(
    "  Not on disk now, nothing to cut · Claude Code: gone\n  Not on disk now, nothing to cut · Codex: figma:figma-use",
  );
  const rows = cut.split("\n").slice(2, 9);
  expect(rows.map((r) => r.replace(/^\s+/, "").replace(/\s{2,}/g, " | "))).toEqual([
    "102 chars | 1 | Codex | pages@openai-curated-remote | plugin, installed by default | installed by default; Codex refuses to uninstall it. Turn it off in codex → /plugins",
    "98 chars | 1 | Codex | vercel@openai-curated-remote | plugin | codex plugin remove vercel@openai-curated-remote · if Codex refuses with 403 (installed by default), turn it off in codex → /plugins",
    "75 chars | 1 | Codex | sample@debug | plugin | codex plugin remove sample@debug",
    "54 chars | 2 | Claude Code | acme@tools | plugin | claude plugin disable acme@tools",
    `42 chars | 2 | Claude Code | deploy | project folder | ${rm(home, "work/.claude/skills/deploy")}`,
    `40 chars | 1 | Codex | tidy | user folder | ${rm(home, ".codex/skills/tidy")}`,
    `38 chars | 2 | Claude Code | notes | user folder | ${rm(home, ".claude/skills/notes")}`,
  ]);
});

test("profile --json carries each skill's origin and each cut's sessions and size", async () => {
  const home = await fixture();
  const out = JSON.parse((await quench(home, "--json")).stdout);
  const claude = out.recordedSkills.find((u: { harness: string }) => u.harness === "claude-code");
  const origin = Object.fromEntries(
    claude.skills.map((s: { name: string; origin: object }) => [s.name, s.origin]),
  );
  expect(origin.notes).toEqual({
    kind: "folder",
    scope: "user",
    path: join(home, ".claude/skills/notes"),
    realPath: join(home, ".claude/skills/notes"),
    link: false,
  });
  expect(origin.simplify).toEqual({ kind: "built-in" });
  expect(origin["acme:lint"]).toEqual({
    kind: "plugin",
    plugin: "acme@tools",
    installedByDefault: false,
  });
  expect(origin.gone).toEqual({ kind: "not-found", path: null, plugin: null });
  const notes = out.recordedSkillCuts.cuts.find((c: { what: string }) => c.what === "notes");
  expect([notes.sessions, notes.listedChars, notes.unsizedSessions]).toEqual([
    2,
    2 * "- notes: does notes".length,
    0,
  ]);
});
