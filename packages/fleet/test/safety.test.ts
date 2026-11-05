import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BundleFile,
  BundleManifest,
  FleetFile,
  importSkillsRepo,
  mergeSnapshot,
  plan,
  resolve,
  Snapshot,
  treeHash,
  type LedgerEntry,
} from "@quench/fleet";
import { buildBundle, readTree } from "@quench/fleet/disk";

const H = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const S = "a".repeat(64);
const roots = {
  "claude-code": "~/.claude/skills",
  codex: "~/.codex/skills",
  pi: "~/.pi/agent/skills",
};
const global = { kind: "global" } as const;
const all = { kind: "all" } as const;

test("bundle files must stay inside their skill folder", () => {
  for (const path of [
    "../../outside",
    "/etc/passwd",
    "C:/x",
    "c:x",
    "a\\b",
    "a/../../b",
    "a//b",
    "./a",
    "",
  ])
    expect(BundleFile.safeParse({ path, mode: "100644", size: 1, sha256: S }).success).toBe(false);
  expect(
    BundleFile.safeParse({ path: "references/a.md", mode: "100644", size: 1, sha256: S }).success,
  ).toBe(true);
  const manifest = (path: string) => ({
    version: 1,
    machine: "box",
    revision: null,
    skills: { a: { treeHash: H(1), files: [{ path, mode: "100644", size: 1, sha256: S }] } },
    placements: [],
    unavailable: [],
  });
  expect(BundleManifest.safeParse(manifest("../outside")).success).toBe(false);
});

async function sourceWith(skills: Record<string, string | null>) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-src-"));
  for (const [name, content] of Object.entries(skills)) {
    if (content === null) continue;
    await mkdir(join(dir, "skills", name), { recursive: true });
    await writeFile(join(dir, "skills", name, "SKILL.md"), content);
  }
  const fleet = FleetFile.parse({
    version: 1,
    skills: Object.fromEntries(Object.keys(skills).map((n) => [n, { path: `skills/${n}` }])),
    assignments: Object.keys(skills).map((skill) => ({
      skill,
      target: all,
      scope: global,
      harnesses: ["claude-code"],
      mode: "include",
    })),
  });
  return { dir, fleet };
}

test("two skills with identical trees both reach the bundle, and the bundle validates", async () => {
  const { dir, fleet } = await sourceWith({ one: "same", two: "same" });
  const { bundle } = await buildBundle(dir, fleet, "box");
  expect(Object.keys(bundle.skills)).toEqual(["one", "two"]);
  expect(bundle.skills.one!.treeHash).toBe(bundle.skills.two!.treeHash);
  expect(bundle.placements.map((p) => p.skill)).toEqual(["one", "two"]);
  expect(BundleManifest.safeParse(bundle).success).toBe(true);
});

test("a bundle whose tree hash does not match its files is rejected", async () => {
  const { dir, fleet } = await sourceWith({ one: "x" });
  const { bundle } = await buildBundle(dir, fleet, "box");
  bundle.skills.one!.treeHash = H(9);
  bundle.placements[0]!.treeHash = H(9);
  expect(BundleManifest.safeParse(bundle).success).toBe(false);
});

const owns = (skill: string, hash: string): LedgerEntry => ({
  path: `~/.claude/skills/${skill}`,
  skill,
  treeHash: hash,
  harness: "claude-code",
  location: { scope: "global" },
  kind: "install",
  appliedAt: "2026-11-01T00:00:00Z",
  sequence: 1,
  gitExclude: null,
  executables: [],
});

test("a missing source for an assigned skill is unavailable, never a removal", async () => {
  const { dir, fleet } = await sourceWith({ gone: null });
  const { bundle } = await buildBundle(dir, fleet, "box");
  const result = plan({
    bundle,
    roots,
    installed: { "~/.claude/skills/gone": { treeHash: H(1), symlink: false, executables: [] } },
    ledger: [owns("gone", H(1))],
    warnings: [],
  });
  expect(result.items.map((i) => [i.skill, i.action, i.path])).toEqual([
    ["gone", "unavailable", "~/.claude/skills/gone"],
  ]);
  expect(result.items[0]!.reason).toContain("cannot read skills/gone");
  expect(result.counts.remove).toBe(0);
});

test("restricted scopes are denied by default, with a reason, and allowed where a machine accepts them", () => {
  const f = FleetFile.parse({
    version: 1,
    openScopes: ["portable"],
    skills: {
      open: { path: "skills/open", scope: "portable" },
      work: { path: "skills/work", scope: "work" },
      plain: { path: "skills/plain" },
    },
    machines: { office: { scopes: ["work"] } },
    assignments: ["open", "work", "plain"].map((skill) => ({
      skill,
      target: all,
      scope: global,
      harnesses: ["pi"],
      mode: "include",
    })),
  });
  const home = resolve(f, "home");
  expect(home.placements.map((p) => p.skill)).toEqual(["open", "plain"]);
  expect(home.denied).toEqual([
    { skill: "work", harness: "pi", scope: global, reason: "scope work is not accepted by home" },
  ]);
  expect(resolve(f, "office").placements.map((p) => p.skill)).toEqual(["open", "plain", "work"]);
  expect(resolve(f, "office").denied).toEqual([]);
});

test("the importer keeps today's set by opening every registry scope", () => {
  const { fleet } = importSkillsRepo({
    registry: "skills:\n  w: { path: skills/w, scope: work }\n",
    manifests: { "claude-global": "skills/w\n" },
    overrides: {},
  });
  expect(fleet.skills.w!.scope).toBe("work");
  expect(fleet.openScopes).toEqual(["work"]);
  expect(resolve(fleet, "anywhere").placements.map((p) => p.skill)).toEqual(["w"]);
});

test("machine overrides apply in order, like the existing merge", () => {
  const { fleet } = importSkillsRepo({
    registry: "skills:\n  a: { path: skills/a }\n  b: { path: skills/b }\n",
    manifests: { "claude-global": "skills/a\n" },
    overrides: { box: { "claude-global": "-a\n+skills/a\n+skills/b\n-b\n" } },
  });
  expect(resolve(fleet, "box").placements.map((p) => p.skill)).toEqual(["a"]);
});

const snap = (generation: number, harnesses: Record<string, boolean>) =>
  Snapshot.parse({
    version: 1,
    id: crypto.randomUUID(),
    generation,
    takenAt: "2026-11-05T00:00:00Z",
    revision: null,
    harnesses: Object.fromEntries(
      Object.entries(harnesses).map(([h, complete]) => [
        h,
        { complete, installs: [], conflicts: generation },
      ]),
    ),
  });

test("snapshots replace state per harness, only from complete harness state, and mark the rest stale", () => {
  const first = mergeSnapshot(null, snap(1, { "claude-code": true, codex: true }));
  expect(first.harnesses["claude-code"]).toMatchObject({ generation: 1, stale: false });
  const partial = mergeSnapshot(first, snap(2, { "claude-code": true, codex: false }));
  expect(partial.harnesses["claude-code"]).toMatchObject({ generation: 2, stale: false });
  expect(partial.harnesses.codex).toMatchObject({ generation: 1, stale: true });
  const empty = mergeSnapshot(partial, snap(3, {}));
  expect(empty.harnesses["claude-code"]).toMatchObject({ generation: 2, stale: true });
  expect(empty.harnesses.codex).toMatchObject({ generation: 1, stale: true });
  expect(mergeSnapshot(empty, snap(2, { "claude-code": true }))).toEqual(empty);
});

test("a snapshot sent after missed polls records how stale the machine was, and the next clears it", () => {
  const first = mergeSnapshot(null, snap(1, { "claude-code": true }));
  const late = Snapshot.parse({
    ...snap(2, { "claude-code": true }),
    staleSince: "2026-11-04T00:00:00Z",
  });
  const caughtUp = mergeSnapshot(first, late);
  expect(caughtUp.staleness).toEqual({
    since: "2026-11-04T00:00:00Z",
    until: "2026-11-05T00:00:00Z",
  });
  expect(mergeSnapshot(caughtUp, snap(3, { "claude-code": true })).staleness).toBeUndefined();
});

test("the executable bit does not change the tree hash, so every OS agrees", async () => {
  const entry = (mode: "100644" | "100755") => [
    { path: "run.sh", mode, bytes: new TextEncoder().encode("x") },
  ];
  expect(treeHash(entry("100755"))).toBe(treeHash(entry("100644")));
  const dir = await mkdtemp(join(tmpdir(), "fleet-mode-"));
  await writeFile(join(dir, "run.sh"), "x");
  const before = treeHash(await readTree(dir));
  await chmod(join(dir, "run.sh"), 0o755);
  expect(treeHash(await readTree(dir))).toBe(before);
});

test("symlink targets are hashed as raw bytes", async () => {
  const hashOf = async (target: string) => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-link-"));
    if (
      !(await symlink(target, join(dir, "alias")).then(
        () => true,
        () => false,
      ))
    )
      return null;
    return treeHash(await readTree(dir));
  };
  const nfd = await hashOf("cafe\u0301.md");
  const nfc = await hashOf("caf\u00e9.md");
  if (nfd && nfc) expect(nfd).not.toBe(nfc);
});

test("skills whose folders collide on a case-insensitive filesystem are conflicts", () => {
  const result = plan({
    bundle: {
      version: 1,
      machine: "box",
      revision: null,
      skills: { Review: { treeHash: H(1), files: [] }, review: { treeHash: H(2), files: [] } },
      placements: [
        { skill: "Review", treeHash: H(1), harness: "claude-code", scope: global },
        { skill: "review", treeHash: H(2), harness: "claude-code", scope: global },
      ],
      unavailable: [],
    },
    roots,
    installed: {},
    ledger: [],
    warnings: [],
  });
  expect(result.items.map((i) => [i.skill, i.action])).toEqual([
    ["Review", "conflict"],
    ["review", "conflict"],
  ]);
  expect(result.items[0]!.reason).toContain("review");
});

test("an unavailable project skill is never also removed, and no path is both unavailable and removed", () => {
  const remote = "github.com/acme/app";
  const checkout = "~/src/app";
  const projectRoots = {
    "claude-code": `${checkout}/.claude/skills`,
    codex: `${checkout}/.codex/skills`,
    pi: `${checkout}/.pi/skills`,
  };
  const path = `${checkout}/.claude/skills/gone`;
  const result = plan({
    bundle: {
      version: 1,
      machine: "box",
      revision: null,
      skills: {},
      placements: [],
      unavailable: [
        {
          skill: "gone",
          harness: "claude-code",
          scope: { kind: "project", remote },
          reason: "cannot read skills/gone",
        },
      ],
    },
    roots,
    installed: { [path]: { treeHash: H(1), symlink: false, executables: [] } },
    ledger: [{ ...owns("gone", H(1)), path, location: { scope: "project", remote, checkout } }],
    warnings: [],
    projects: [{ remote, checkout, roots: projectRoots }],
  });
  expect(result.counts.remove).toBe(0);
  expect(result.items.map((i) => [i.action, i.path])).toEqual([["unavailable", path]]);
  const byPath = new Map<string, Set<string>>();
  for (const item of result.items)
    if (item.path) byPath.set(item.path, (byPath.get(item.path) ?? new Set()).add(item.action));
  for (const actions of byPath.values())
    expect(actions.has("unavailable") && actions.has("remove")).toBe(false);
});
