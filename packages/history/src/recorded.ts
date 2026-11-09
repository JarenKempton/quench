import { sha256 } from "./jsonl.ts";
import type { Event, InjectedInstruction, ListedSkill, Session } from "./model.ts";

export type SessionSkills = {
  listed: ListedSkill[];
  upFront: { count: number; chars: number };
  used: { name: string; by: "model" | "user" }[];
};

export function recordedSkills(session: Session): SessionSkills | null {
  const listings = session.events.flatMap((e) => (e.type === "skills" ? [e] : []));
  if (!listings.length) return null;
  const listed = new Map(listings.flatMap((l) => l.listed).map((s) => [s.name, s]));
  const byPath = new Map([...listed.values()].flatMap((s) => (s.path ? [[s.path, s.name]] : [])));
  const used = new Map<string, "model" | "user">();
  for (const event of session.events) {
    const by = event.type === "invocation" ? event.by : "model";
    for (const name of skillUsesOf(event, byPath))
      if (used.get(name) !== "user") used.set(name, by);
  }
  return {
    listed: [...listed.values()].map((skill) => ({
      name: intern(skill.name),
      path: skill.path && intern(skill.path),
      chars: skill.chars,
    })),
    upFront: { count: listings[0]!.listed.length, chars: listings[0]!.chars },
    used: [...used].map(([name, by]) => ({ name: intern(name), by })),
  };
}

export type DiskComparison = "same" | "differs" | "missing" | "not comparable";

export function recordedInstructions(session: Session): InjectedInstruction[] | null {
  const latest = new Map<string, InjectedInstruction>();
  let recorded = false;
  for (const event of session.events) {
    if (event.type !== "instructions") continue;
    recorded = true;
    for (const file of event.files)
      latest.set(file.path ?? `combined:${file.directory ?? ""}`, file);
  }
  return recorded ? [...latest.values()] : null;
}

export async function compareWithDisk(record: InjectedInstruction): Promise<DiskComparison> {
  if (!record.path || record.textDiffersFromFile) return "not comparable";
  const text = await Bun.file(record.path)
    .text()
    .catch(() => null);
  if (text === null) return "missing";
  return [text, text.replace(/\n$/, "")].some((t) => sha256(t) === record.textSha256)
    ? "same"
    : "differs";
}

export function skillUsesOf(event: Event, byPath: ReadonlyMap<string, string>): string[] {
  if (event.type === "invocation") return [event.name];
  if (event.type !== "tool_call") return [];
  return [...byPath]
    .filter(
      ([path]) =>
        event.fileRead?.path === path ||
        event.shell?.some((s) =>
          [path, path.replaceAll("\\", "/")].some((form) => s.command?.includes(form)),
        ),
    )
    .map(([, name]) => name);
}

export type SessionMcp = {
  server: string;
  calls: number;
  failed?: string | null;
  needsLogin?: true;
};

export function recordedMcp(session: Session): SessionMcp[] {
  const calls = new Map<string, number>();
  const failed = new Map<string, string | null>();
  const needsLogin = new Set<string>();
  const ids = new Set<string>();
  for (const event of session.events) {
    if (event.type === "mcp_status") {
      for (const f of event.failed) failed.set(f.server, f.code ?? failed.get(f.server) ?? null);
      for (const name of event.needsLogin) needsLogin.add(name);
    }
    if (event.type !== "mcp_call") continue;
    if (event.id !== null && !event.inScript) {
      if (ids.has(event.id)) continue;
      ids.add(event.id);
    }
    calls.set(event.server, (calls.get(event.server) ?? 0) + 1);
  }
  const servers = new Set([...calls.keys(), ...failed.keys(), ...needsLogin]);
  return [...servers].map((server) => ({
    server: intern(server),
    calls: calls.get(server) ?? 0,
    ...(failed.has(server) ? { failed: failed.get(server)! } : {}),
    ...(needsLogin.has(server) ? { needsLogin: true as const } : {}),
  }));
}

const interned = new Map<string, string>();
export const intern = (text: string) => interned.get(text) ?? interned.set(text, text).get(text)!;

export function recordedModels(session: Session): { used: string[]; unknown: string[] } {
  const used = new Set<string>();
  const unknown = new Set<string>();
  for (const event of session.events) {
    if (event.type === "inference" && event.model) used.add(intern(event.model));
    if (event.type === "unknown_model") unknown.add(intern(event.model));
  }
  return { used: [...used], unknown: [...unknown] };
}
