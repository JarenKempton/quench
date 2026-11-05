import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleSkill, treeHash, treeHashOf } from "@quench/fleet";
import { buildBundle, loadFleet } from "@quench/fleet/disk";

const S = "a".repeat(64);
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (error: Error) => error.message,
  );

async function repo(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-repo-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

test("a source that resolves outside the repo is rejected with a warning, never bundled", async () => {
  const outside = await repo({ "a/SKILL.md": "outside" });
  const dir = await repo({
    "registry.yaml": "skills:\n  a: { path: skills/a }\n",
    "hosts/claude-global.manifest": "alias/a\n",
  });
  await mkdir(join(dir, "skills"));
  await mkdir(join(dir, "alias"));
  const linked = await symlink(join(outside, "a"), join(dir, "skills/a"), "junction")
    .then(() => symlink(join(outside, "a"), join(dir, "alias/a"), "junction"))
    .then(
      () => true,
      () => false,
    );
  if (!linked) return;
  const aliased = await loadFleet(dir);
  const viaAlias = await buildBundle(dir, aliased.fleet, "box");
  expect(viaAlias.bundle.skills).toEqual({});
  expect(viaAlias.bundle.placements).toEqual([]);
  expect(aliased.warnings.join("\n")).toContain("not substituted");
  await writeFile(join(dir, "hosts/claude-global.manifest"), "skills/a\n");
  const direct = await loadFleet(dir);
  const viaRegistry = await buildBundle(dir, direct.fleet, "box");
  expect(viaRegistry.bundle.skills).toEqual({});
  expect(viaRegistry.bundle.placements).toEqual([]);
  expect(viaRegistry.bundle.unavailable.map((u) => u.reason)).toEqual([
    "skills/a resolves outside the source repo, rejected",
  ]);
  expect(viaRegistry.warnings.join("\n")).toContain("outside");
});

test("an unreadable manifest fails the plan instead of dropping its skills", async () => {
  const dir = await repo({ "registry.yaml": "skills:\n  a: { path: skills/a }\n" });
  await mkdir(join(dir, "hosts/claude-global.manifest"), { recursive: true });
  expect(await failure(loadFleet(dir))).toContain("claude-global.manifest");
});

test("an unreadable override folder fails the plan", async () => {
  const dir = await repo({
    "registry.yaml": "skills:\n  a: { path: skills/a }\n",
    "hosts/claude-global.manifest": "skills/a\n",
    "hosts/overrides": "not a folder",
  });
  expect(await failure(loadFleet(dir))).toContain("overrides");
});

test("an unreadable fleet file fails instead of falling back to the registry", async () => {
  const dir = await repo({
    "registry.yaml": "skills:\n  a: { path: skills/a }\n",
    "hosts/claude-global.manifest": "skills/a\n",
  });
  await mkdir(join(dir, "quench-fleet.yaml"));
  expect(await failure(loadFleet(dir))).toContain("quench-fleet.yaml");
});

test("an unparseable registry fails the plan", async () => {
  const dir = await repo({ "registry.yaml": "skills: [unclosed\n" });
  expect(await failure(loadFleet(dir))).toBeString();
});

test("a file and a folder that fold to the same name collide", () => {
  const files = [
    { path: "Docs", mode: "100644" as const, size: 1, sha256: S },
    { path: "docs/two.md", mode: "100644" as const, size: 1, sha256: S },
  ];
  expect(BundleSkill.safeParse({ treeHash: treeHashOf(files), files }).success).toBe(false);
  const same = [files[0]!, { ...files[1]!, path: "Docs/two.md" }];
  expect(BundleSkill.safeParse({ treeHash: treeHashOf(same), files: same }).success).toBe(false);
  const bytes = new Uint8Array();
  expect(() =>
    treeHash([
      { path: "Docs", mode: "100644", bytes },
      { path: "docs/two.md", mode: "100644", bytes },
    ]),
  ).toThrow("duplicate");
  const fine = [
    { path: "docs/one.md", mode: "100644" as const, size: 1, sha256: S },
    { path: "docs/two.md", mode: "100644" as const, size: 1, sha256: S },
  ];
  expect(BundleSkill.safeParse({ treeHash: treeHashOf(fine), files: fine }).success).toBe(true);
});
