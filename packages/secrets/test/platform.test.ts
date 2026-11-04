import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Home } from "@quench/history";
import { credentialFiles } from "../src/harvest.ts";
import { masker, toolConfigFiles } from "../src/index.ts";
import { pathKey } from "../src/path-key.ts";

const TOKEN = "ghp_" + "FakeQuenchPlatformValue0123456789ab";

test("GitHub CLI and gcloud configs resolve on macOS like other Unix homes", () => {
  expect(toolConfigFiles("/Users/a", "darwin", {}).map(([path]) => path)).toEqual([
    join("/Users/a", ".config", "gh", "hosts.yml"),
    join("/Users/a", ".config", "gcloud", "application_default_credentials.json"),
  ]);
  expect(
    toolConfigFiles("/Users/a", "darwin", { XDG_CONFIG_HOME: "/x" }).map(([path]) => path),
  ).toEqual([
    join("/x", "gh", "hosts.yml"),
    join("/Users/a", ".config", "gcloud", "application_default_credentials.json"),
  ]);
  expect(toolConfigFiles("/Users/a", "darwin", { CLOUDSDK_CONFIG: "/g" })[1]![0]).toBe(
    join("/g", "application_default_credentials.json"),
  );
});

test("paths match regardless of case on macOS and Windows only", () => {
  expect(pathKey("/Users/A/.NPMRC", "darwin")).toBe(pathKey("/Users/a/.npmrc", "darwin"));
  expect(pathKey("C:\\Users\\A\\.npmrc", "win32")).toBe(pathKey("c:\\users\\a\\.npmrc", "win32"));
  expect(pathKey("/home/A/.npmrc", "linux")).not.toBe(pathKey("/home/a/.npmrc", "linux"));
});

test("credential files report their mode, macOS zsh session history and reads in any case", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "quench-platform-")));
  const aws = join(dir, ".aws", "credentials");
  const zsh = join(dir, ".zsh_sessions", "8FE05490.history");
  const pending = join(dir, ".zsh_sessions", "8FE05490.historynew");
  await Bun.write(aws, `aws_secret_access_key = ${TOKEN}\n`);
  await chmod(aws, 0o600);
  await Bun.write(zsh, `export GITHUB_TOKEN=${TOKEN}\n`);
  await Bun.write(pending, `export GITHUB_TOKEN=${TOKEN}\n`);
  await Bun.write(join(dir, ".zsh_sessions", "8FE05490.session"), "echo restored\n");
  const reads = new Map([[pathKey(aws.toUpperCase()), new Set(["claude-code:s1"])]]);
  const files = await credentialFiles(new Home(dir), [], [], {
    reads,
    printed: new Set(),
    mask: masker(randomBytes(32)),
  });
  const file = (path: string) => files.find((f) => f.path === path);
  expect(file(aws)).toMatchObject({
    present: true,
    readInSessions: process.platform === "linux" ? 0 : 1,
    ...(process.platform === "win32" ? {} : { mode: "600", othersCanRead: false }),
  });
  for (const path of [zsh, pending])
    expect(file(path)).toMatchObject({ label: "shell history", plaintext: true, secrets: 1 });
  expect(files.filter((f) => f.path.endsWith(".session"))).toEqual([]);
});
