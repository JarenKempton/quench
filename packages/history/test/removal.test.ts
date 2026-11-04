import { expect, test } from "bun:test";
import { harnessById, Home, quoteArg, withEnv } from "../src/index.ts";

test("command arguments are quoted so a quote or shell syntax cannot escape", () => {
  expect(quoteArg("lint@tools", "posix")).toBe("lint@tools");
  expect(quoteArg("/Users/O'Brien/x", "posix")).toBe(`'/Users/O'\\''Brien/x'`);
  expect(quoteArg("$(touch pwned)", "posix")).toBe(`'$(touch pwned)'`);
  expect(quoteArg("-rf", "posix")).toBe("'-rf'");
  expect(quoteArg("C:\\Users\\O'Brien\\a b", "powershell")).toBe("'C:\\Users\\O''Brien\\a b'");
  expect(quoteArg("C:\\Users\\O\u2019Brien", "powershell")).toBe("'C:\\Users\\O\u2019\u2019Brien'");
  expect(quoteArg("a,b", "powershell")).toBe("'a,b'");
});

test("folders and Claude Code plugins get no command; Codex plugin commands carry the home", () => {
  const plugin = { kind: "plugin", plugin: "lint@tools", installedByDefault: false } as const;
  const folder = {
    kind: "folder",
    scope: "user",
    path: "/home/me/.claude/skills/pr",
    realPath: "/home/me/.claude/skills/pr",
    link: false,
    repo: null,
  } as const;
  const plain = new Home("/home/me");
  const alt = plain.withVar("CODEX_HOME", "/alt/codex");
  const posix = { home: plain, shell: "posix" } as const;
  expect(harnessById["claude-code"].skillCut(folder, posix)).toEqual({
    command: null,
    note: "remove /home/me/.claude/skills/pr",
  });
  expect(harnessById["claude-code"].skillCut(plugin, posix).command).toBeNull();
  expect(harnessById.codex.skillCut(plugin, posix).command).toBe("codex plugin remove lint@tools");
  expect(harnessById.codex.skillCut(plugin, { home: alt, shell: "posix" }).command).toBe(
    "CODEX_HOME=/alt/codex codex plugin remove lint@tools",
  );
  expect(harnessById.codex.skillCut(plugin, { home: alt, shell: "powershell" }).command).toBe(
    "$env:CODEX_HOME='/alt/codex'; codex plugin remove lint@tools",
  );
  expect(withEnv("X", null, "cmd", "posix")).toBe("cmd");
});
