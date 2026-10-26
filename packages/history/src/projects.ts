import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repositoryRoot, subdirs } from "./files.ts";
import type { Home } from "./home.ts";
import type { HarnessId, InjectedInstruction } from "./model.ts";
import { recordedFailures, type SessionFailure } from "./failures.ts";
import { discoverAll, readSessions, type Progress } from "./read.ts";
import {
  recordedInstructions,
  recordedMcp,
  recordedSkills,
  type SessionSkills,
} from "./recorded.ts";

export type SessionPlace = {
  cwd: string | null;
  harness: HarnessId;
  at: Date | null;
  instructions: InjectedInstruction[] | null;
  skills: SessionSkills | null;
  mcp: { server: string; calls: number }[];
  failures: SessionFailure[];
};

export type ProjectDirectory = {
  path: string;
  sessions: number;
  harnesses: HarnessId[];
  lastActive: string | null;
};

export type Project = {
  root: string;
  git: boolean;
  scanned: boolean;
  sessions: number;
  harnesses: HarnessId[];
  lastActive: string | null;
  directories: ProjectDirectory[];
};

export type PlaceCache = {
  get(path: string, stamp: string): SessionPlace | undefined;
  set(path: string, stamp: string, place: SessionPlace): void;
};

export async function sessionPlaces(
  home: Home,
  since: Date,
  onRead?: Progress,
  cache?: PlaceCache,
) {
  const refs = await discoverAll(home, since);
  const modified = new Map(refs.map((ref) => [ref.path, ref.modified]));
  const stamps = new Map<string, string>();
  const found = new Map<string, SessionPlace>();
  const uncached = [];
  for (const ref of refs) {
    const info = cache && (await stat(ref.path).catch(() => null));
    const stamp = info ? `${info.size}:${info.mtimeMs}` : null;
    const hit = stamp ? cache?.get(ref.path, stamp) : undefined;
    if (hit) found.set(ref.path, hit);
    else uncached.push(ref);
    if (stamp) stamps.set(ref.path, stamp);
  }
  let unreadable = 0;
  for await (const outcome of readSessions(uncached, 8, onRead)) {
    if (!outcome.ok) {
      unreadable++;
      continue;
    }
    const place: SessionPlace = {
      cwd: outcome.session.cwd,
      harness: outcome.session.harness,
      at: modified.get(outcome.session.path) ?? null,
      instructions: recordedInstructions(outcome.session),
      skills: recordedSkills(outcome.session),
      mcp: recordedMcp(outcome.session),
      failures: recordedFailures(outcome.session),
    };
    found.set(outcome.session.path, place);
    const stamp = stamps.get(outcome.session.path);
    if (stamp) cache?.set(outcome.session.path, stamp, place);
  }
  const places = refs.flatMap((ref) => found.get(ref.path) ?? []);
  return { places, unreadable };
}

export async function projects(places: readonly SessionPlace[], scan: readonly string[] = []) {
  const resolved = new Map<string, string | null>();
  for (const cwd of new Set(places.flatMap((p) => (p.cwd ? [p.cwd] : []))))
    resolved.set(cwd, await existingDirectory(cwd));
  const byDirectory = new Map<string, SessionPlace[]>();
  const placesByRoot = new Map<string, SessionPlace[]>();
  for (const place of places) {
    const path = place.cwd ? resolved.get(place.cwd) : null;
    if (path) byDirectory.set(path, [...(byDirectory.get(path) ?? []), place]);
  }
  const missing = [...resolved].flatMap(([cwd, path]) => (path ? [] : [cwd]));
  const found = new Map<string, Project>();
  const project = (root: string, git: boolean) =>
    found.get(root) ??
    found
      .set(root, {
        root,
        git,
        scanned: false,
        sessions: 0,
        harnesses: [],
        lastActive: null,
        directories: [],
      })
      .get(root)!;
  for (const [path, sessions] of byDirectory) {
    const root = await repositoryRoot(path);
    const entry = project(root ?? path, root !== null);
    placesByRoot.set(entry.root, [...(placesByRoot.get(entry.root) ?? []), ...sessions]);
    const directory = {
      path,
      sessions: sessions.length,
      harnesses: unique(sessions.map((s) => s.harness)),
      lastActive: latest(sessions.map((s) => s.at)),
    };
    entry.directories.push(directory);
    entry.sessions += directory.sessions;
    entry.harnesses = unique([...entry.harnesses, ...directory.harnesses]);
    entry.lastActive = latest([entry.lastActive, directory.lastActive]);
  }
  for (const dir of scan) {
    const path = await realpath(resolve(dir));
    const root = await repositoryRoot(path);
    const roots = root
      ? [root]
      : (
          await Promise.all(
            (
              await subdirs(path)
            ).map(async (child) =>
              (await stat(join(child, ".git")).catch(() => null)) ? repositoryRoot(child) : null,
            ),
          )
        ).filter((child) => child !== null);
    for (const r of roots) project(r, true).scanned = true;
  }
  for (const p of found.values())
    p.directories.sort((a, b) => (b.lastActive ?? "").localeCompare(a.lastActive ?? ""));
  return {
    projects: [...found.values()].sort(
      (a, b) =>
        (b.lastActive ?? "").localeCompare(a.lastActive ?? "") || a.root.localeCompare(b.root),
    ),
    missing: missing.sort(),
    placesByRoot,
  };
}

async function existingDirectory(path: string): Promise<string | null> {
  const real = await realpath(path).catch(() => null);
  return real && (await stat(real)).isDirectory() ? real : null;
}

const unique = <T>(values: T[]) => [...new Set(values)];

function latest(dates: (Date | string | null)[]): string | null {
  const times = dates.flatMap((d) => (d ? [new Date(d).toISOString()] : []));
  return times.length ? times.sort().at(-1)! : null;
}
