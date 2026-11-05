import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BundleFile,
  installations,
  owned,
  resolve,
  SkillName,
  treeHash,
  type LedgerEntry,
} from "@quench/fleet";
import { loadFleet } from "@quench/fleet/disk";

const S = "a".repeat(64);
const H = `sha256:${S}`;
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (error: Error) => error.message,
  );

async function repoWithLinkedOverride(target: (dir: string) => Promise<string>) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-ov-"));
  await mkdir(join(dir, "hosts/overrides"), { recursive: true });
  await writeFile(join(dir, "registry.yaml"), "skills:\n  a: { path: skills/a }\n");
  await writeFile(join(dir, "hosts/claude-global.manifest"), "skills/a\n");
  const real = await target(dir);
  await writeFile(join(real, "claude-global.manifest"), "-skills/a\n");
  const linked = await symlink(real, join(dir, "hosts/overrides/box"), "junction").then(
    () => true,
    () => false,
  );
  return linked ? dir : null;
}

test("an override folder that is a symlink inside the repo is followed", async () => {
  const dir = await repoWithLinkedOverride(async (d) => {
    await mkdir(join(d, "machines/box"), { recursive: true });
    return join(d, "machines/box");
  });
  if (!dir) return;
  const { fleet } = await loadFleet(dir);
  expect(resolve(fleet, "box").placements).toEqual([]);
  expect(resolve(fleet, "other").placements.map((p) => p.skill)).toEqual(["a"]);
});

test("an override folder that links outside the repo fails the plan", async () => {
  const dir = await repoWithLinkedOverride(() => mkdtemp(join(tmpdir(), "fleet-elsewhere-")));
  if (!dir) return;
  expect(await failure(loadFleet(dir))).toContain("hosts/overrides/box");
});

const entry = (kind: LedgerEntry["kind"], sequence: number, appliedAt: string): LedgerEntry => ({
  path: "~/.claude/skills/a",
  skill: "a",
  treeHash: H,
  executables: [],
  harness: "claude-code",
  location: { scope: "global" },
  kind,
  sequence,
  appliedAt,
  gitExclude: null,
});

test("ledger order follows the sequence, not the clock", () => {
  const ledger = [
    entry("install", 1, "2026-11-05T10:00:00Z"),
    entry("remove", 2, "2026-11-05T09:00:00Z"),
  ];
  expect([...owned(ledger).keys()]).toEqual([]);
  expect(installations(ledger).map((i) => [i.from, i.to])).toEqual([
    ["2026-11-05T10:00:00Z", "2026-11-05T09:00:00Z"],
  ]);
  expect([...owned([...ledger].reverse()).keys()]).toEqual([]);
});

test("names and paths must be well-formed UTF-16", () => {
  const lone = "\ud800.txt";
  expect(BundleFile.safeParse({ path: lone, mode: "100644", size: 1, sha256: S }).success).toBe(
    false,
  );
  expect(BundleFile.safeParse({ path: "�.txt", mode: "100644", size: 1, sha256: S }).success).toBe(
    true,
  );
  expect(SkillName.safeParse("a\udc00").success).toBe(false);
  expect(() => treeHash([{ path: lone, mode: "100644", bytes: new Uint8Array() }])).toThrow(
    "portable",
  );
});
