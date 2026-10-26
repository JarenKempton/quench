import { expect, test } from "bun:test";
import { failureOf } from "../src/failures.ts";
import { commandSignature } from "../src/shell.ts";

test("failures are classified from the error text", () => {
  const kind = (text: string, isError: boolean | null = true, rejected = false) => {
    const f = failureOf(text, isError, rejected);
    return f && [f.kind, f.detail, f.exitCode];
  };
  expect(kind("ok", false)).toBeNull();
  expect(kind('{"exit_code":0,"output":"fine"}', null)).toBeNull();
  expect(kind("Exit code 1\ncat: docs/setup.md: No such file or directory")).toEqual([
    "missing-path",
    "docs/setup.md",
    1,
  ]);
  expect(
    kind("Exit code 1\nls: cannot access 'x': error reading: No such file or directory"),
  ).toEqual(["missing-path", null, 1]);
  expect(kind("File does not exist.")).toEqual(["missing-path", null, null]);
  expect(kind('{"exit_code":127,"output":"zsh:1: command not found: pytest"}', null)).toEqual([
    "missing-program",
    "pytest",
    127,
  ]);
  expect(kind("Exit code 2\nbash: line 1: tsc: command not found")).toEqual([
    "missing-program",
    "tsc",
    2,
  ]);
  expect(kind("Invalid arguments for search: limit expected number")).toEqual([
    "invalid-input",
    "Invalid arguments for search: limit expected number",
    null,
  ]);
  expect(
    kind("<tool_use_error>Blocked: sleep 60 followed by: ls</tool_use_error>", true, true),
  ).toEqual(["rejected", "Blocked: sleep N followed by: ls", null]);
  expect(
    kind(
      "PreToolUse:Bash hook error: [/home/me/hooks/guard.sh]: guard: blocked — force push. Ask first.",
      true,
      true,
    ),
  ).toEqual(["rejected", "guard: blocked — force push", null]);
  expect(kind("Exit code 3\nsomething broke")).toEqual(["exit-code", null, 3]);
  expect(kind("Request timed out after 5000ms")).toEqual([
    "error",
    "Request timed out after Nms",
    null,
  ]);
});

test("a command signature names one program, or none for several", () => {
  expect(commandSignature("cd app && FOO=1 bun test --watch 2>&1 | tail -20")).toBe("bun test");
  expect(commandSignature("python3 -c 'print(1)'")).toBe("python3");
  expect(commandSignature("git status && npm test")).toBeNull();
  expect(commandSignature("sleep 5; echo hi")).toBeNull();
});
