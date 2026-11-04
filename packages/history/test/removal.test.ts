import { expect, test } from "bun:test";
import { harnessById, Home, quoteArg, removeLink, withEnv } from "../src/index.ts";

test("link removal quotes paths so a quote or shell syntax cannot escape", () => {
  expect(removeLink("/home/me/.claude/skills/pr", "posix")).toBe(
    "rm -- /home/me/.claude/skills/pr",
  );
  expect(removeLink("/Users/O'Brien/skills/pr", "posix")).toBe(
    `rm -- '/Users/O'\\''Brien/skills/pr'`,
  );
  expect(removeLink("/tmp/$(touch pwned)/x", "posix")).toBe(`rm -- '/tmp/$(touch pwned)/x'`);
  expect(removeLink("-rf", "posix")).toBe("rm -- '-rf'");
  expect(removeLink("C:\\Users\\O'Brien\\a b\\$x", "powershell")).toBe(
    "(Get-Item -LiteralPath 'C:\\Users\\O''Brien\\a b\\$x').Delete()",
  );
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
