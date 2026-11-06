import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { VersionCounts } from "@quench/fleet";
import { skillFolder } from "@quench/history";
import { changes, sampled, SAMPLE_FLOOR } from "@quench/hub";
import type { Reply } from "@quench/judge";
import { plural } from "../format.ts";
import { sessionOutcomes, tally } from "../skills/co-occurrence.ts";
import type { SessionContext } from "./context.ts";
import { DELETED, snapshots, versionsOf, type Span, type Versions } from "./file-versions.ts";

export const BASIS = "correlation, not cause";

export type FileVersion = {
  treeHash: string;
  from: string;
  to: string | null;
  bytes: number | null;
  loaded: VersionCounts;
  without: VersionCounts;
};

export type FileChange = {
  before: string;
  after: string;
  at: string;
  grewBy: number | null;
  sessions: number;
  shown: boolean;
  rates: { before: number | null; after: number | null };
  grewWithoutDrop: boolean;
};

export type FileHistory = {
  kind: "skill" | "instructions";
  name: string;
  path: string;
  source: Versions["source"];
  sessions: number;
  versions: FileVersion[];
  changes: FileChange[];
};

export type Histories = { basis: typeof BASIS; floor: number; files: FileHistory[] };

type Use = { key: string; at: number };
type Tracked = { kind: FileHistory["kind"]; name: string; path: string; uses: Use[] };

export type SkillPaths = (cwd: string | null, name: string) => string | null;

const iso = (ms: number) => new Date(ms).toISOString();

const rate = (c: VersionCounts) => (c.judged ? c.withHumanCorrection / c.judged : null);

const within = (span: Span, at: number) =>
  at >= span.from && (span.until === null || at < span.until);

export async function fileHistories(input: {
  contexts: ReadonlyMap<string, SessionContext>;
  replies: readonly Reply[];
  since: Date;
  homeDir: string;
  skillPath: SkillPaths;
  write: boolean;
}): Promise<Histories> {
  const outcome = sessionOutcomes(input.replies, input.since);
  const real = new Map<string, string>();
  const resolve = async (path: string) => {
    const known = real.get(path);
    if (known) return known;
    const found = await realpath(path).catch(() => path);
    real.set(path, found);
    return found;
  };
  const tracked = new Map<string, Tracked>();
  const use = async (kind: Tracked["kind"], name: string, path: string, at: Use) => {
    const key = await resolve(path);
    const entry = tracked.get(key) ?? { kind, name, path, uses: [] };
    if (!entry.uses.some((u) => u.key === at.key)) entry.uses.push(at);
    tracked.set(key, entry);
  };
  const baselines = { instructions: [] as Use[], skill: [] as Use[] };
  for (const [key, context] of input.contexts) {
    const at = context.at ?? null;
    if (at === null) continue;
    if (context.paths) {
      baselines.instructions.push({ key, at });
      for (const path of context.paths) await use("instructions", path, path, { key, at });
    }
    if (context.skills) baselines.skill.push({ key, at });
    for (const load of context.loads ?? []) {
      const path =
        load.path === null
          ? input.skillPath(context.cwd ?? null, load.name)
          : load.path.endsWith(".md")
            ? load.path
            : join(skillFolder(load.path), "SKILL.md");
      if (path) await use("skill", load.name, path, { key, at: load.at ?? at });
    }
  }
  const recorded = await snapshots(input.homeDir, input.write);
  const files: FileHistory[] = [];
  for (const [real, entry] of tracked) {
    const { source, spans } = await versionsOf(real, recorded);
    const users = new Set(entry.uses.map((u) => u.key));
    const others = baselines[entry.kind].filter((u) => !users.has(u.key));
    const keysIn = (uses: Use[], span: Span) =>
      uses.filter((u) => within(span, u.at)).map((u) => u.key);
    const versions = spans.map((span) => ({
      treeHash: span.treeHash,
      from: iso(span.from),
      to: span.until === null ? null : iso(span.until),
      bytes: span.bytes,
      loaded: tally([...new Set(keysIn(entry.uses, span))], outcome),
      without: tally([...new Set(keysIn(others, span))], outcome),
    }));
    files.push({
      kind: entry.kind,
      name: entry.name,
      path: entry.path,
      source,
      sessions: users.size,
      versions,
      changes: changes(versions).map(([was, now]) => compare(was, now)),
    });
  }
  await recorded.save();
  return {
    basis: BASIS,
    floor: SAMPLE_FLOOR,
    files: files.sort((a, b) => b.sessions - a.sessions || a.path.localeCompare(b.path)),
  };
}

function compare(was: FileVersion, now: FileVersion): FileChange {
  const floor = sampled(was.loaded, now.loaded);
  const grewBy = was.bytes === null || now.bytes === null ? null : now.bytes - was.bytes;
  const [before, after] = [rate(was.loaded), rate(now.loaded)];
  return {
    before: was.treeHash,
    after: now.treeHash,
    at: now.from,
    grewBy,
    ...floor,
    rates: { before, after },
    grewWithoutDrop:
      floor.shown && grewBy !== null && grewBy > 0 && before !== null && after !== null
        ? after >= before
        : false,
  };
}

const pct = (c: VersionCounts) =>
  c.judged ? `${Math.round((100 * c.withHumanCorrection) / c.judged)}%` : "–";

const counts = (c: VersionCounts) =>
  `${plural(c.sessions, "session")} · ${c.withHumanCorrection} of ${c.judged} judged corrected (${pct(c)})`;

const share = (r: number | null) => (r === null ? "–" : `${Math.round(100 * r)}%`);

const size = (v: FileVersion) =>
  v.bytes !== null ? `${v.bytes} B` : DELETED.test(v.treeHash) ? "deleted" : "size unknown";

export function renderHistories(found: Histories, path: (file: string) => string): string {
  const shown = found.files.filter((f) => f.sessions >= found.floor);
  const lines = [
    "",
    "Skill and instruction file history",
    `${found.files.length} files in context · ${shown.length} with ${found.floor}+ sessions shown · versions from git where tracked, else from snapshots Quench records from now on`,
  ];
  for (const file of shown) {
    lines.push(
      "",
      `  ${file.kind === "skill" ? `skill ${file.name}` : "instructions"}  ${path(file.path)}  (${file.source}, ${plural(file.versions.length, "version")})`,
    );
    if (!file.versions.length) lines.push("    No snapshot yet; history starts with this run.");
    for (const v of file.versions.filter((v) => v.loaded.sessions || v.without.sessions))
      lines.push(
        `    ${v.from.slice(0, 10)} → ${v.to ? v.to.slice(0, 10) : "now"}  ${size(v)}  loaded: ${counts(v.loaded)}  ·  others: ${counts(v.without)}`,
      );
    for (const c of file.changes.filter((c) => c.grewWithoutDrop))
      lines.push(
        `    Grew ${c.grewBy} B on ${c.at.slice(0, 10)} with no drop in correction rate (${share(c.rates.before)} → ${share(c.rates.after)}); ${found.basis}`,
      );
  }
  lines.push(
    "",
    `Changes are compared once both sides have ${found.floor} sessions that loaded the file. Read-only: no skill or instruction file is changed.`,
  );
  return `${lines.join("\n")}\n`;
}
