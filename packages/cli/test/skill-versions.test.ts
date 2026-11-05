import { expect, test } from "bun:test";
import type { LedgerEntry } from "@quench/fleet";
import type { SessionContext } from "../src/commands/context.ts";
import type { SkillEvidence } from "../src/commands/skills.ts";
import { withVersions } from "../src/skills/versions.ts";

const HOME = "/home/u";
const T1 = Date.parse("2026-10-01T00:00:00.000Z");
const T2 = Date.parse("2026-10-10T00:00:00.000Z");
const hash = (c: string) => `sha256:${c.repeat(64)}`;
const absolute = (path: string) => (path.startsWith("~/") ? `${HOME}/${path.slice(2)}` : path);

let sequence = 0;
const entry = (checkout: string | null, treeHash: string, at: number): LedgerEntry => ({
  path: checkout ? `${checkout}/.claude/skills/tidy` : "~/.claude/skills/tidy",
  skill: "tidy",
  treeHash,
  executables: [],
  harness: "claude-code",
  location: checkout
    ? { scope: "project", remote: "github.com/acme/app", checkout }
    : { scope: "global" },
  kind: sequence < 2 ? "install" : "update",
  sequence: ++sequence,
  appliedAt: new Date(at).toISOString(),
  gitExclude: null,
});

type Session = {
  cwd: string | null;
  at: number;
  load: string | null;
  loadedAt?: number | null;
};

function evidence(sessions: Session[]): SkillEvidence {
  const started = new Map<string, { harness: "claude-code"; at: number; cwd: string | null }>();
  const contexts = new Map<string, SessionContext>();
  sessions.forEach((s, i) => {
    const key = `claude-code:s${i}`;
    started.set(key, { harness: "claude-code", at: s.at, cwd: s.cwd });
    contexts.set(key, {
      skills: ["tidy"],
      loads:
        s.load === null
          ? []
          : [
              {
                name: "tidy",
                path: s.load === "unnamed" ? null : s.load,
                at: s.loadedAt === undefined ? s.at : s.loadedAt,
              },
            ],
      files: [],
    });
  });
  return { since: new Date(0), started, contexts, replies: [] };
}

const record = (location: string) => ({ skill: "tidy", harness: "claude-code" as const, location });

test("an unnamed load counts once, toward the only installation whose scope covers the session", () => {
  sequence = 0;
  const ledger = [
    entry("~/app1", hash("a"), T1),
    entry("~/app2", hash("a"), T1),
    entry("~/app1", hash("b"), T2),
    entry("~/app2", hash("b"), T2),
  ];
  const day = 86_400_000;
  const sessions: Session[] = [
    ...[0, 1, 2, 3, 4, 5].map((i) => ({
      cwd: `${HOME}/app${(i % 2) + 1}/src`,
      at: T1 + day + i,
      load: "unnamed",
    })),
    { cwd: `${HOME}/elsewhere`, at: T1 + day, load: "unnamed" },
    { cwd: null, at: T1 + day, load: "unnamed" },
    { cwd: `${HOME}/elsewhere`, at: T1 + day, load: `${HOME}/app2/.claude/skills/tidy/SKILL.md` },
    { cwd: `${HOME}/app1`, at: T1 + day, load: null },
    { cwd: `${HOME}/elsewhere`, at: T1 + day, load: null },
  ];
  const [app1, app2] = withVersions(
    [record("~/app1/.claude/skills/tidy"), record("~/app2/.claude/skills/tidy")],
    ledger,
    evidence(sessions),
    absolute,
  );
  const before = (r: typeof app1) => r!.versions![0]!;
  expect([before(app1).loaded.sessions, before(app2).loaded.sessions]).toEqual([3, 4]);
  expect(before(app1).loaded.sessions + before(app2).loaded.sessions).toBe(7);
  expect([before(app1).without.sessions, before(app2).without.sessions]).toEqual([1, 0]);
  expect(app1!.versions![1]!.loaded.sessions).toBe(0);
});

test("a global and a project installation that both cover a session leave an unnamed load unattributed", () => {
  sequence = 0;
  const ledger = [entry(null, hash("a"), T1), entry("~/app1", hash("a"), T1)];
  const [global, project] = withVersions(
    [record("~/.claude/skills/tidy"), record("~/app1/.claude/skills/tidy")],
    ledger,
    evidence([
      { cwd: `${HOME}/app1`, at: T1 + 1, load: "unnamed" },
      { cwd: `${HOME}/other`, at: T1 + 1, load: "unnamed" },
      { cwd: `${HOME}/app1`, at: T1 + 1, load: null },
    ]),
    absolute,
  );
  expect(global!.versions![0]!.loaded.sessions).toBe(1);
  expect(project!.versions![0]!.loaded.sessions).toBe(0);
  expect(global!.versions![0]!.without.sessions).toBe(0);
  expect(project!.versions![0]!.without.sessions).toBe(0);
});

test("a load counts for the version installed when it happened, not when its session started", () => {
  sequence = 0;
  const ledger = [entry(null, hash("a"), T1), entry(null, hash("b"), T2)];
  const day = 86_400_000;
  const [global] = withVersions(
    [record("~/.claude/skills/tidy")],
    ledger,
    evidence([
      { cwd: null, at: T1 + day, load: "unnamed", loadedAt: T2 + day },
      { cwd: null, at: T1 + day, load: `${HOME}/.claude/skills/tidy/SKILL.md`, loadedAt: T2 + 2 },
      { cwd: null, at: T1 + day, load: "unnamed", loadedAt: T1 + 2 * day },
      { cwd: null, at: T1 + day, load: "unnamed", loadedAt: null },
      { cwd: null, at: T1 + day, load: "unnamed", loadedAt: T2 },
    ]),
    absolute,
  );
  const [v1, v2] = global!.versions!;
  expect(v1!.loaded.sessions).toBe(1);
  expect(v2!.loaded.sessions).toBe(2);
});

test("a session that loaded two installations of the same version counts for neither", () => {
  sequence = 0;
  const ledger = [entry("~/app1", hash("a"), T1), entry("~/app2", hash("a"), T1)];
  const sessions = evidence([
    { cwd: null, at: T1 + 1, load: `${HOME}/app1/.claude/skills/tidy/SKILL.md` },
    { cwd: null, at: T1 + 1, load: `${HOME}/app1/.claude/skills/tidy/SKILL.md` },
  ]);
  const second = sessions.contexts.get("claude-code:s1")!;
  second.loads = [
    ...second.loads!,
    { name: "tidy", path: `${HOME}/app2/.claude/skills/tidy/SKILL.md`, at: T1 + 2 },
  ];
  const [app1, app2] = withVersions(
    [record("~/app1/.claude/skills/tidy"), record("~/app2/.claude/skills/tidy")],
    ledger,
    sessions,
    absolute,
  );
  expect(app1!.versions![0]!.loaded.sessions).toBe(1);
  expect(app2!.versions![0]!.loaded.sessions).toBe(0);
});
