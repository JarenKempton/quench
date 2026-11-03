import { expect, test } from "bun:test";
import { launchOf, piPackageSpec, pluginSourceSpec } from "@quench/history";
import { unpinned } from "../src/pins.ts";

const verdict = (command: string, args: string[]) => {
  const launch = launchOf(command, args);
  return launch && (unpinned(launch.ecosystem, launch.spec)?.reason ?? "pinned");
};

test("runner commands resolve to the package they fetch and whether it is pinned", () => {
  expect(verdict("npx", ["-y", "@playwright/mcp@latest"])).toBe("@latest");
  expect(verdict("npx", ["-y", "@playwright/mcp@0.0.41", "--headless"])).toBe("pinned");
  expect(verdict("C:\\nodejs\\npx.cmd", ["--yes", "server-memory"])).toBe("no version");
  expect(verdict("npx", ["-p", "mcp-remote@^0.1", "mcp-remote", "https://x"])).toBe("range ^0.1");
  expect(verdict("bunx", ["github:owner/repo#main"])).toBe("branch main");
  expect(verdict("npx", ["owner/repo#" + "a".repeat(40)])).toBe("pinned");
  expect(verdict("pnpm", ["dlx", "tool@next"])).toBe("tag next");
  expect(verdict("uvx", ["mcp-server-fetch"])).toBe("no version");
  expect(verdict("uvx", ["mcp-server-fetch==1.2.3"])).toBe("pinned");
  expect(verdict("uvx", ["--from", "git+https://github.com/o/r.git@dev", "r"])).toBe("branch dev");
  expect(verdict("uv", ["tool", "run", "mcp-server-git>=1"])).toBe("range >=1");
  expect(verdict("docker", ["run", "-i", "--rm", "-e", "TOKEN", "ghcr.io/o/server"])).toBe(
    "no tag",
  );
  expect(verdict("docker", ["run", "-i", "mcp/fetch:latest"])).toBe("tag latest");
  expect(verdict("docker", ["run", "mcp/fetch@sha256:" + "b".repeat(64)])).toBe("pinned");
  expect(verdict("node", ["server.js"])).toBeNull();
  expect(verdict("npx", ["./local-server"])).toBeNull();
});

test("credentials in a source URL are dropped before it is reported", () => {
  expect(launchOf("uvx", ["--from", "git+https://user:pw@host/o/r.git", "r"])?.spec).toBe(
    "git+https://host/o/r.git",
  );
});

test("marketplace, plugin and Pi package sources map to pinnable specs", () => {
  const github = pluginSourceSpec({ source: "github", repo: "o/r" })!;
  expect(unpinned(github.ecosystem, github.spec)).toEqual({
    reason: "default branch",
    pinTo: "github:o/r#<commit-sha>",
  });
  const sha = pluginSourceSpec({
    source: "git-subdir",
    url: "https://h/o/r.git",
    ref: "main",
    sha: "c".repeat(40),
  })!;
  expect(unpinned(sha.ecosystem, sha.spec)).toBeNull();
  expect(pluginSourceSpec({ source: "directory", path: "/x" })).toBeNull();
  const pi = piPackageSpec("git:github.com/o/r@v1.2.0")!;
  expect(pi.spec).toBe("git+https://github.com/o/r#v1.2.0");
  expect(unpinned(pi.ecosystem, pi.spec)).toBeNull();
  const npm = piPackageSpec({ source: "npm:@o/skills" })!;
  expect(unpinned(npm.ecosystem, npm.spec)?.pinTo).toBe("@o/skills@<version>");
  expect(piPackageSpec("./local")).toBeNull();
});
