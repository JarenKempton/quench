import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BundleFile,
  installations,
  owned,
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

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "fleet-hosts-"));
  await mkdir(join(dir, "hosts"), { recursive: true });
  await writeFile(join(dir, "registry.yaml"), "skills:\n  a: { path: skills/a }\n");
  await writeFile(join(dir, "hosts/claude-global.manifest"), "skills/a\n");
  return dir;
}

const link = (target: string, path: string) =>
  symlink(target, path, "junction").then(
    () => true,
    () => false,
  );

test("a dangling hosts/overrides link fails the plan instead of reading as absent", async () => {
  const dir = await repo();
  if (!(await link(join(dir, "missing"), join(dir, "hosts/overrides")))) return;
  expect(await failure(loadFleet(dir))).toContain("symlink");
});

test("an overrides folder linked from outside the repo fails the plan", async () => {
  const dir = await repo();
  const outside = await mkdtemp(join(tmpdir(), "fleet-elsewhere-"));
  await mkdir(join(outside, "box"));
  await writeFile(join(outside, "box/claude-global.manifest"), "-skills/a\n");
  if (!(await link(outside, join(dir, "hosts/overrides")))) return;
  expect(await failure(loadFleet(dir))).toContain("symlink");
});

test("any link at or under hosts/ fails the plan, even one that stays inside the repo", async () => {
  const machine = await repo();
  await mkdir(join(machine, "hosts/overrides"));
  await mkdir(join(machine, "machines/box"), { recursive: true });
  await writeFile(join(machine, "machines/box/claude-global.manifest"), "-skills/a\n");
  if (!(await link(join(machine, "machines/box"), join(machine, "hosts/overrides/box")))) return;
  expect(await failure(loadFleet(machine))).toContain("symlink");
  const file = await repo();
  await mkdir(join(file, "hosts/overrides/box"), { recursive: true });
  await writeFile(join(file, "elsewhere.manifest"), "-skills/a\n");
  const linked = await symlink(
    join(file, "elsewhere.manifest"),
    join(file, "hosts/overrides/box/claude-global.manifest"),
  ).then(
    () => true,
    () => false,
  );
  if (linked) expect(await failure(loadFleet(file))).toContain("symlink");
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
