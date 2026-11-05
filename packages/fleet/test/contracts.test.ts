import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FleetFile,
  installations,
  normaliseRemote,
  plan,
  proposal,
  ProposalSubmission,
  resolve,
  treeHash,
  type BundleManifest,
  type LedgerEntry,
  type TreeEntry,
} from "@quench/fleet";
import { readTree } from "@quench/fleet/disk";

const bytes = (s: string) => new TextEncoder().encode(s);
const file = (path: string, content: string, mode: TreeEntry["mode"] = "100644"): TreeEntry => ({
  path,
  mode,
  bytes: bytes(content),
});
const H = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

test("the tree hash spec is frozen: hash mode, path, NUL, content sha256, newline; sorted by UTF-8 bytes", () => {
  const entries = [
    file("b.md", "b"),
    file("SKILL.md", "x"),
    file("a/c.sh", "#!/bin/sh\n", "100755"),
  ];
  const line = (mode: string, path: string, content: string) =>
    `${mode} ${path}\0${new Bun.CryptoHasher("sha256").update(content).digest("hex")}\n`;
  const spec =
    line("100644", "SKILL.md", "x") +
    line("100644", "a/c.sh", "#!/bin/sh\n") +
    line("100644", "b.md", "b");
  expect(treeHash(entries)).toBe(
    `sha256:${new Bun.CryptoHasher("sha256").update(spec).digest("hex")}`,
  );
  expect(treeHash([...entries].reverse())).toBe(treeHash(entries));
});

test("the tree hash tells symlinks from files, rejects backslashes and non-NFC paths, and skips exclusions", () => {
  const base = [file("SKILL.md", "x")];
  expect(treeHash([file("SKILL.md", "x", "120000")])).not.toBe(treeHash(base));
  expect(
    treeHash([...base, file(".git/HEAD", "ref"), file("a/.DS_Store", ""), file("Thumbs.db", "")]),
  ).toBe(treeHash(base));
  expect(() => treeHash([...base, file("ref\\cafe.md", "y")])).toThrow("portable");
  expect(() => treeHash([...base, file("ref/cafe\u0301.md", "y")])).toThrow("portable");
  expect(() => treeHash([...base, file("SKILL.md", "y")])).toThrow("duplicate");
});

test("readTree records symlinks inside a skill as links and follows the skill folder itself", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-"));
  await mkdir(join(dir, "skill/.git"), { recursive: true });
  await writeFile(join(dir, "skill/SKILL.md"), "x");
  await writeFile(join(dir, "skill/.git/HEAD"), "ref");
  const linked = await symlink("SKILL.md", join(dir, "skill/alias.md")).then(
    () => true,
    () => false,
  );
  await symlink(join(dir, "skill"), join(dir, "via"), "junction").catch(() => {});
  const tree = await readTree(join(dir, "skill"));
  expect(tree.map((e) => [e.path, e.mode])).toEqual([
    ["SKILL.md", "100644"],
    ...(linked ? [["alias.md", "120000"]] : []),
  ]);
  expect(treeHash(await readTree(join(dir, "via")))).toBe(treeHash(tree));
});

const fleet = (assignments: unknown[], machines = {}) =>
  FleetFile.parse({ version: 1, skills: { a: { path: "skills/a" } }, machines, assignments });
const all = { kind: "all" };
const global = { kind: "global" };

test("the most specific target wins, and exclude wins a tie", () => {
  const f = fleet(
    [
      { skill: "a", target: all, scope: global, harnesses: "all", mode: "include" },
      {
        skill: "a",
        target: { kind: "tag", tag: "work" },
        scope: global,
        harnesses: ["codex"],
        mode: "exclude",
      },
      {
        skill: "a",
        target: { kind: "person", person: "sam" },
        scope: global,
        harnesses: ["codex"],
        mode: "include",
      },
      {
        skill: "a",
        target: { kind: "machine", machine: "box" },
        scope: global,
        harnesses: ["pi"],
        mode: "exclude",
      },
      {
        skill: "a",
        target: { kind: "machine", machine: "box" },
        scope: global,
        harnesses: ["pi"],
        mode: "include",
      },
    ],
    { box: { tags: ["work"], person: "sam" }, other: { tags: ["work"] } },
  );
  expect(resolve(f, "box").placements.map((p) => p.harness)).toEqual(["claude-code", "codex"]);
  expect(resolve(f, "other").placements.map((p) => p.harness)).toEqual(["claude-code", "pi"]);
  expect(resolve(f, "unknown").placements.map((p) => p.harness)).toEqual([
    "claude-code",
    "codex",
    "pi",
  ]);
});

test("project scope keys on a normalised remote, and the fleet file rejects unknown skills and escaping paths", () => {
  const remote = normaliseRemote("git@GitHub.com:JarenKempton/quench.git")!;
  expect(remote).toBe("github.com/jarenkempton/quench");
  expect(normaliseRemote("https://user@github.com/JarenKempton/quench")).toBe(remote);
  expect(normaliseRemote("ssh://git@github.com/JarenKempton/quench.git/")).toBe(remote);
  const f = fleet([
    {
      skill: "a",
      target: all,
      scope: { kind: "project", remote },
      harnesses: ["pi"],
      mode: "include",
    },
  ]);
  expect(resolve(f, "box").placements).toEqual([
    { skill: "a", harness: "pi", scope: { kind: "project", remote } },
  ]);
  expect(() =>
    fleet([{ skill: "b", target: all, scope: global, harnesses: "all", mode: "include" }]),
  ).toThrow("unknown skill b");
  expect(() => FleetFile.parse({ version: 1, skills: { a: { path: "../a" } } })).toThrow();
  expect(() => FleetFile.parse({ version: 1, skills: { "../a": { path: "a" } } })).toThrow();
});

const entry = (kind: LedgerEntry["kind"], treeHash: string, appliedAt: string): LedgerEntry => ({
  path: "~/.claude/skills/a",
  skill: "a",
  treeHash,
  harness: "claude-code",
  location: { scope: "global" },
  kind,
  appliedAt,
  sequence: Date.parse(appliedAt),
  gitExclude: null,
  executables: [],
});

test("the ledger yields installation intervals with prior tree hashes", () => {
  const ledger = [
    entry("update", H(2), "2026-11-02T00:00:00Z"),
    entry("install", H(1), "2026-11-01T00:00:00Z"),
    entry("remove", H(2), "2026-11-03T00:00:00Z"),
  ];
  expect(installations(ledger).map((i) => [i.treeHash, i.from, i.to])).toEqual([
    [H(1), "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"],
    [H(2), "2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z"],
  ]);
});

test("the planner updates only what the ledger owns and never overwrites foreign or edited folders", () => {
  const remote = "github.com/o/r";
  const bundle: BundleManifest = {
    version: 1,
    machine: "box",
    revision: null,
    skills: { a: { treeHash: H(2), files: [] } },
    placements: [
      { skill: "a", treeHash: H(2), harness: "claude-code", scope: { kind: "global" } },
      { skill: "a", treeHash: H(2), harness: "codex", scope: { kind: "global" } },
      { skill: "a", treeHash: H(2), harness: "pi", scope: { kind: "project", remote } },
    ],
    unavailable: [],
  };
  const roots = {
    "claude-code": "~/.claude/skills",
    codex: "~/.codex/skills",
    pi: "~/.pi/agent/skills",
  };
  const ledger = [
    entry("install", H(1), "2026-11-01T00:00:00Z"),
    { ...entry("install", H(4), "2026-11-01T00:00:00Z"), path: "~/.claude/skills/old" },
  ];
  const result = plan({
    bundle,
    roots,
    installed: {
      "~/.claude/skills/a": { treeHash: H(1), symlink: false, executables: [] },
      "~/.codex/skills/a": { treeHash: H(3), symlink: true, executables: [] },
    },
    ledger,
    warnings: [],
  });
  expect(result.items.map((i) => [i.harness, i.path, i.action])).toEqual([
    ["claude-code", "~/.claude/skills/a", "update"],
    ["claude-code", "~/.claude/skills/old", "remove"],
    ["codex", "~/.codex/skills/a", "conflict"],
    ["pi", null, "unresolved"],
  ]);
  const edited = plan({
    bundle,
    roots,
    installed: { "~/.claude/skills/old": { treeHash: H(5), symlink: false, executables: [] } },
    ledger,
    warnings: [],
  });
  expect(edited.items.find((i) => i.path === "~/.claude/skills/old")?.action).toBe("conflict");
});

test("a proposal takes its machine from the token, never the payload, and labels agent fields as claims", () => {
  const submission = {
    skill: "a",
    baseTreeHash: H(1),
    file: "SKILL.md",
    content: "new",
    claims: { agent: "claude" },
  };
  expect(() => ProposalSubmission.parse({ ...submission, machine: "spoofed" })).toThrow();
  expect(() => ProposalSubmission.parse({ ...submission, content: "x".repeat(65 * 1024) })).toThrow(
    "too large",
  );
  const stored = proposal(ProposalSubmission.parse(submission), "box", "2026-11-05T00:00:00Z");
  expect(stored.machine).toBe("box");
  expect(stored.revision).toBe(new Bun.CryptoHasher("sha256").update("new").digest("hex"));
  expect(stored.claims).toEqual({ agent: "claude" });
  expect(stored.evidence).toEqual([]);
  expect(Object.isFrozen(stored)).toBe(true);
});
