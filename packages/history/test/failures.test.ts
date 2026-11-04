import { expect, test } from "bun:test";
import { failureSummary } from "../src/failure-text.ts";
import { failureOf, type Denial } from "../src/failures.ts";
import { commandSignature } from "../src/shell.ts";

test("failures are classified from the error text", () => {
  const kind = (text: string, isError: boolean | null = true, denial: Denial = null) => {
    const f = failureOf(text, isError, denial);
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
    kind("<tool_use_error>Blocked: sleep 60 followed by: ls</tool_use_error>", true, "rejected"),
  ).toEqual(["rejected", "Blocked: sleep N followed by: ls", null]);
  expect(
    kind(
      "PreToolUse:Bash hook error: [/home/me/hooks/guard.sh]: guard: blocked — force push. Ask first.",
      true,
      { guard: "PreToolUse:Bash hook guard.sh" },
    ),
  ).toEqual(["blocked", "PreToolUse:Bash hook guard.sh", null]);
  expect(kind("Exit code 3\nsomething broke")).toEqual(["exit-code", null, 3]);
  expect(kind("Request timed out after 5000ms")).toEqual([
    "error",
    "Request timed out after Nms",
    null,
  ]);
});

test("a nonzero exit keeps the first line of its output, masked, from either harness", () => {
  const error = (text: string) => failureSummary(failureOf(text, null)?.line ?? "");
  expect(error("Exit code 255\nssh: connect to host box port 22: Connection refused")).toBe(
    "ssh: connect to host box port N: Connection refused",
  );
  expect(
    error('{"chunk_id":"a1","exit_code":1,"output":"\\nfatal: not a git repository\\n"}'),
  ).toBe("fatal: not a git repository");
  expect(error("Exit code 1\nerror: C:\\Users\\me\\app\\main.ts not found")).toBe(
    "error: main.ts not found",
  );
});

test("quoted, spaced and bare paths to the same file give one error line", () => {
  const error = (text: string) => failureOf(text, null)?.line;
  const lines = [
    'Exit code 1\nerror: "C:\\Program Files\\app\\main.ts" not found',
    "Exit code 1\nerror: 'C:\\Program Files\\app\\main.ts' not found",
    "Exit code 1\nerror: C:\\app\\main.ts not found",
    'Exit code 1\nerror: "/home/me/app/main.ts" not found',
    "Exit code 1\nerror: /home/me/app/main.ts: not found",
  ].map((text) => failureSummary(error(text)!));
  expect(new Set(lines)).toEqual(new Set(["error: main.ts not found"]));
});

test("errors are classed from a fixed list, never kept as text", () => {
  const error = (text: string, isError: boolean | null = true) =>
    failureOf(text, isError)?.errorClass;
  expect(error("Exit code 128\nremote: Invalid username or token. Authentication failed")).toBe(
    "auth failed",
  );
  expect(error("Exit code 1\nbash: ./x: Permission denied")).toBe("permission denied");
  expect(error("Request timed out after 5000ms")).toBe("timeout");
  expect(error("Exit code 6\ncurl: (6) Could not resolve host: example.test")).toBe("network");
  expect(error("Exit code 1\ncat: a: No such file or directory")).toBe("not found");
  expect(error("Exit code 1\n! [rejected] main -> main (non-fast-forward)")).toBe("conflict");
  expect(error("Exit code 3\nsomething broke")).toBe("exit code 3");
  expect(error("something broke")).toBe("other");
});

test("a command signature names one program, or none for several", () => {
  expect(commandSignature('"C:\\Program Files\\Git\\bin\\git.exe" push origin main')).toBe(
    "git push",
  );
  expect(commandSignature("C:\\Git\\bin\\git.exe push origin main")).toBe("git push");
  expect(commandSignature(".\\tools\\build.cmd release")).toBe("build");
  expect(commandSignature("git -C some/dir push --force origin main")).toBe("git -C --force");
  expect(commandSignature("gh api repos/o/r --jq .x")).toBe("gh api --jq");
  expect(commandSignature("npm run deadbeef")).toBe("npm run");
  expect(commandSignature("oathtool deadbeef")).toBe("oathtool");
  expect(commandSignature("git deadbeef")).toBe("git");
  expect(commandSignature("ssh box uptime")).toBe("ssh");
  expect(commandSignature("make my\\ target")).toBe("make");
  expect(commandSignature("cd app && FOO=1 bun test --watch 2>&1 | tail -20")).toBe(
    "bun test --watch",
  );
  expect(commandSignature("python3 -c 'print(1)'")).toBe("python3 -c");
  expect(commandSignature("curl -u a:b --header=x https://example.test")).toBe("curl -u --header");
  expect(commandSignature("deploy -uadmin:pw --token=-canary --token z user:pw")).toBe(
    "deploy -u --token",
  );
  expect(commandSignature("env -u GITHUB_TOKEN A=1 gh pr merge 12 --squash")).toBe(
    "gh pr --squash",
  );
  expect(commandSignature("git status && npm test")).toBeNull();
  expect(commandSignature("cd app && git push --force origin main | tail")).toBe(
    "git push --force",
  );
  expect(commandSignature("sleep 5; echo hi")).toBeNull();
});
