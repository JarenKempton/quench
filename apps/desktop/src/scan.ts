// Mirrors hone_core::scan (serde-serialized across the invoke bridge, hone#13).
// Field names are snake_case to match the Rust structs exactly; PathBufs arrive
// as strings, Option<T> as T | null.

/** Where a skill physically lives and how the scanner knows — its provenance. */
export type Origin =
  | { kind: "local"; path: string }
  | { kind: "linked"; link: string; target: string };

export interface Skill {
  name: string;
  description: string | null;
  origin: Origin;
  manifest: string;
}

/** A path the scanner looked for, and whether it was actually there. */
export interface Probe {
  path: string;
  present: boolean;
}

export interface ContextFile {
  path: string;
  bytes: number;
  linked_to: string | null;
}

export interface Harness {
  id: string;
  name: string;
  home: Probe;
  skills_dir: Probe;
  skills: Skill[];
  context_files: ContextFile[];
  dangling: string[];
}

export interface ProjectScan {
  root: string;
  probed: Probe[];
  skills: Skill[];
  dangling: string[];
}

export interface Scan {
  harnesses: Harness[];
  project: ProjectScan;
  duplicate_names: string[];
}

/** The source repo a skill really comes from — the honest origin, short-labelled. */
export function originLabel(origin: Origin): string {
  return origin.kind === "linked" ? origin.target : origin.path;
}

/** Home-dir prefix stripped for readable provenance, without hiding the path. */
export function tildeify(path: string): string {
  const home = path.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(\/|$)/);
  return home ? "~" + path.slice(home[1].length) : path;
}
