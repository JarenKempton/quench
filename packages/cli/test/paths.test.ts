import { expect, test } from "bun:test";
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
  ).toEqual({ root: "/home/me/app", file: "a/b.md" });
});

test("release assets are named per platform, with .exe on Windows", () => {
  expect(assetName("win32", "x64")).toBe("quench-windows-x64.exe");
  expect(assetName("linux", "arm64")).toBe("quench-linux-arm64");
  expect(assetName("darwin", "x64")).toBe("quench-darwin-x64");
});
