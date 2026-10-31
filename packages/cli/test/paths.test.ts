import { expect, test } from "bun:test";
import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName } from "../src/commands/update.ts";
import { projectName, shortPath } from "../src/format.ts";
import { autoMemory } from "../src/profile/recorded-instructions.ts";

test("Windows paths shorten under the home directory and name their project", () => {
  expect(shortPath("C:\\Users\\me\\code\\app", "C:\\Users\\me")).toBe("~\\code\\app");
  expect(shortPath("C:\\Users\\meg\\app", "C:\\Users\\me")).toBe("C:\\Users\\meg\\app");
  expect(projectName("C:\\Users\\me\\code\\app", "C:\\Users\\me")).toBe("app");
  expect(projectName("C:\\Users\\me", "C:\\Users\\me")).toBe("~");
});

test("Claude Code auto memory matches a Windows project slug", () => {
  const root = "C:\\Users\\me\\code\\app";
  const file = "C:\\Users\\me\\.claude\\projects\\C--Users-me-code-app\\memory\\MEMORY.md";
  expect(autoMemory(file, "C:\\Users\\me\\.claude", [root])).toEqual({ root, file: "MEMORY.md" });
  expect(autoMemory(file, "C:\\Users\\me\\.claude", ["C:\\Users\\me\\code\\other"])).toBeNull();
  expect(
    autoMemory("/home/me/.claude/projects/-home-me-app/memory/a/b.md", "/home/me/.claude", [
      "/home/me/app",
    ]),
  ).toEqual({ root: "/home/me/app", file: join("a", "b.md") });
});

test("release assets are named per platform, with .exe on Windows", () => {
  expect(assetName("win32", "x64")).toBe("quench-windows-x64.exe");
  expect(assetName("linux", "arm64")).toBe("quench-linux-arm64");
  expect(assetName("darwin", "x64")).toBe("quench-darwin-x64");
});

test("runs finds a session when HOME is reached through a link", async () => {
  const real = await realpath(await mkdtemp(join(tmpdir(), "quench-runs-")));
  const home = `${real}-link`;
  await symlink(real, home, "junction");
  const file = join(home, ".claude/projects/p/s.jsonl");
  await Bun.write(
    file,
    [
      {
        type: "user",
        timestamp: "2026-10-22T10:00:00Z",
        promptSource: "typed",
        message: { role: "user", content: "hi" },
      },
      {
        type: "assistant",
        timestamp: "2026-10-22T10:00:01Z",
        message: {
          id: "a",
          model: "m",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "runs", file, "--json"], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PI_CODING_AGENT_DIR: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)[0].prompt).toBe("hi");
});
