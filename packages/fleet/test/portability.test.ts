import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BundleFile,
  BundleSkill,
  FleetFile,
  importSkillsRepo,
  plan,
  resolve,
  SkillName,
  treeHash,
  treeHashOf,
  type BundleManifest,
  type LedgerEntry,
} from "@quench/fleet";
import { buildBundle, readTree } from "@quench/fleet/disk";

const S = "a".repeat(64);
const roots = {
  "claude-code": "~/.claude/skills",
  codex: "~/.codex/skills",
  pi: "~/.pi/agent/skills",
};
const global = { kind: "global" } as const;
const files = [
  { path: "SKILL.md", mode: "100644" as const, size: 1, sha256: S },
  { path: "run.sh", mode: "100755" as const, size: 1, sha256: S },
];
const hash = treeHashOf(files);
const bundle = (placed: boolean): BundleManifest => ({
  version: 1,
  machine: "box",
  revision: null,
  skills: { a: { treeHash: hash, files } },
  placements: placed ? [{ skill: "a", treeHash: hash, harness: "claude-code", scope: global }] : [],
  unavailable: [],
});
const ledger = (executables: string[]): LedgerEntry[] => [
  {
    path: "~/.claude/skills/a",
    skill: "a",
    treeHash: hash,
    executables,
    harness: "claude-code",
    location: { scope: "global" },
    kind: "install",
    appliedAt: "2026-11-01T00:00:00Z",
    gitExclude: null,
  },
];
const actionWith = (placed: boolean, executables: string[] | null, owned: LedgerEntry[] = []) =>
  plan({
    bundle: bundle(placed),
    roots,
    installed: { "~/.claude/skills/a": { treeHash: hash, symlink: false, executables } },
    ledger: owned,
    warnings: [],
  }).items[0]?.action;

test("a mode change is drift: same bytes with a different executable bit are not unchanged", () => {
  expect(actionWith(true, ["run.sh"])).toBe("unchanged");
  expect(actionWith(true, [])).toBe("conflict");
  expect(actionWith(true, [], ledger([]))).toBe("update");
  expect(actionWith(true, null)).toBe("unchanged");
});

test("a local chmod after Quench wrote a skill blocks its removal", () => {
  expect(actionWith(false, [], ledger([]))).toBe("remove");
  expect(actionWith(false, ["run.sh"], ledger([]))).toBe("conflict");
});

test("a bundle skill cannot hold two paths that fold to the same name", () => {
  const twin = [
    { path: "README.md", mode: "100644" as const, size: 1, sha256: S },
    { path: "Readme.md", mode: "100644" as const, size: 1, sha256: S },
  ];
  expect(BundleSkill.safeParse({ treeHash: treeHashOf(twin), files: twin }).success).toBe(false);
});

test("names Windows cannot hold are rejected on every OS", () => {
  for (const name of ["con", "CON", "nul.txt", "com1", "LPT9.md", "a.", "aux"])
    expect(SkillName.safeParse(name).success).toBe(false);
  for (const name of ["console", "com10", "a.b", "nullable"])
    expect(SkillName.safeParse(name).success).toBe(true);
  const bad = [
    "docs/CON",
    "aux.md",
    "a:b",
    "a?b",
    "a<b",
    "a>b",
    "a|b",
    "a*b",
    'a"b',
    "dir./x",
    "x ",
    "a\u0001b",
  ];
  for (const path of bad)
    expect(BundleFile.safeParse({ path, mode: "100644", size: 1, sha256: S }).success).toBe(false);
});

test("paths must already be NFC, in the manifest and on disk alike", async () => {
  const nfd = "café.md";
  expect(BundleFile.safeParse({ path: nfd, mode: "100644", size: 1, sha256: S }).success).toBe(
    false,
  );
  expect(() => treeHash([{ path: nfd, mode: "100644", bytes: new Uint8Array() }])).toThrow();
  const dir = await mkdtemp(join(tmpdir(), "fleet-nfd-"));
  await writeFile(join(dir, nfd), "x");
  const stored = (await import("node:fs")).readdirSync(dir)[0]!;
  if (stored === nfd)
    expect(
      await readTree(dir).then(
        () => null,
        (error: Error) => error.message,
      ),
    ).toContain("portable");
});

test("skills named like Object prototype members are ordinary skills", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-proto-"));
  const names = ["constructor", "toString", "hasOwnProperty"];
  for (const name of names) {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "SKILL.md"), name);
  }
  const fleet = FleetFile.parse({
    version: 1,
    skills: Object.fromEntries(names.map((n) => [n, { path: n }])),
    assignments: names.map((skill) => ({
      skill,
      target: { kind: "all" },
      scope: global,
      harnesses: ["pi"],
      mode: "include",
    })),
  });
  expect(resolve(fleet, "box").placements.map((p) => p.skill)).toEqual(names.toSorted());
  const { bundle } = await buildBundle(dir, fleet, "box");
  expect(bundle.placements.map((p) => p.skill)).toEqual(names.toSorted());
  expect(() =>
    FleetFile.parse({
      version: 1,
      skills: {},
      assignments: [
        {
          skill: "toString",
          target: { kind: "all" },
          scope: global,
          harnesses: "all",
          mode: "include",
        },
      ],
    }),
  ).toThrow("unknown skill");
});

test("a full manifest path must match the registry exactly; only bare names fall back to the name", () => {
  const registry = "skills:\n  a: { path: skills/one/a }\n";
  const run = (manifest: string, folders: Record<string, string> = {}) =>
    importSkillsRepo({
      registry,
      manifests: { "claude-global": manifest },
      overrides: {},
      folders,
    });
  const swapped = run("skills/two/a\n");
  expect(resolve(swapped.fleet, "box").placements).toEqual([]);
  expect(swapped.fleet.skills.a!.path).toBe("skills/one/a");
  expect(swapped.warnings.join("\n")).toContain("skills/two/a");
  expect(resolve(run("a\n").fleet, "box").placements.map((p) => p.skill)).toEqual(["a"]);
  const linked = run("skills/two/a\n", { "skills/two/a": "vendor/a", "skills/one/a": "vendor/a" });
  expect(resolve(linked.fleet, "box").placements.map((p) => p.skill)).toEqual(["a"]);
  expect(linked.warnings).toEqual([]);
});
