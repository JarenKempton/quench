import { expect, test } from "bun:test";
import { harnessById, Home, quoteArg, removeFolder, withEnv } from "../src/index.ts";

test("folder removal quotes paths so a quote or shell syntax cannot escape", () => {
  expect(removeFolder("/home/me/.claude/skills/pr", "posix")).toBe(
    "rm -r -- /home/me/.claude/skills/pr",
  );
  expect(removeFolder("/Users/O'Brien/skills/pr", "posix")).toBe(
    `rm -r -- '/Users/O'\\''Brien/skills/pr'`,
  );
  expect(removeFolder("/tmp/$(touch pwned)/x", "posix")).toBe(`rm -r -- '/tmp/$(touch pwned)/x'`);
  expect(removeFolder("-rf", "posix")).toBe("rm -r -- '-rf'");
  expect(removeFolder("C:\\Users\\me\\skills\\pr", "powershell")).toBe(
    "Remove-Item -Recurse -LiteralPath C:\\Users\\me\\skills\\pr",
  );
  expect(removeFolder("C:\\Users\\O'Brien\\a b\\$x", "powershell")).toBe(
    "Remove-Item -Recurse -LiteralPath 'C:\\Users\\O''Brien\\a b\\$x'",
  );
  expect(quoteArg("C:\\Users\\O\u2019Brien", "powershell")).toBe("'C:\\Users\\O\u2019\u2019Brien'");
  expect(quoteArg("a,b", "powershell")).toBe("'a,b'");
});

test("plugin commands carry an overridden agent home", () => {
  const plugin = { kind: "plugin", plugin: "lint@tools", installedByDefault: false } as const;
  const plain = new Home("/home/me");
  const alt = plain.withVar("CODEX_HOME", "/alt/codex").withVar("CLAUDE_CONFIG_DIR", "/alt/it's");
  expect(harnessById.codex.skillCut(plugin, { home: plain, shell: "posix" }).command).toBe(
    "codex plugin remove lint@tools",
  );
  expect(harnessById.codex.skillCut(plugin, { home: alt, shell: "posix" }).command).toBe(
    "CODEX_HOME=/alt/codex codex plugin remove lint@tools",
  );
  expect(harnessById.codex.skillCut(plugin, { home: alt, shell: "powershell" }).command).toBe(
    "$env:CODEX_HOME='/alt/codex'; codex plugin remove lint@tools",
  );
  expect(harnessById["claude-code"].skillCut(plugin, { home: alt, shell: "posix" }).command).toBe(
    `CLAUDE_CONFIG_DIR='/alt/it'\\''s' claude plugin disable lint@tools`,
  );
  expect(withEnv("X", null, "cmd", "posix")).toBe("cmd");
});
