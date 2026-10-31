import { sha256 } from "./jsonl.ts";
import type { InjectedInstruction, ListedSkill, Session } from "./model.ts";

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
    const uses =
      event.type === "invocation"
        ? [{ name: event.name, by: event.by }]
        : event.type === "tool_call"
          ? namedSkills(event, byPath)
          : [];
    for (const use of uses)
      if (listed.has(use.name) && !used.has(use.name)) used.set(use.name, use.by);
  }
  return {
    listed: [...listed.values()].map((skill) => ({
      name: intern(skill.name),
      path: skill.path && intern(skill.path),
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

function namedSkills(
  call: Extract<Session["events"][number], { type: "tool_call" }>,
  byPath: Map<string, string>,
): { name: string; by: "model" }[] {
  return [...byPath]
    .filter(
      ([path]) =>
        call.fileRead?.path === path ||
        call.shell?.some((s) =>
          [path, path.replaceAll("\\", "/")].some((form) => s.command?.includes(form)),
        ),
    )
    .map(([, name]) => ({ name, by: "model" }));
}

export function recordedMcp(session: Session): { server: string; calls: number }[] {
  const calls = new Map<string, number>();
  const ids = new Set<string>();
  for (const event of session.events) {
    if (event.type !== "mcp_call") continue;
    if (event.id !== null && !event.inScript) {
      if (ids.has(event.id)) continue;
      ids.add(event.id);
    }
    calls.set(event.server, (calls.get(event.server) ?? 0) + 1);
  }
  return [...calls].map(([server, n]) => ({ server: intern(server), calls: n }));
}

const interned = new Map<string, string>();
export const intern = (text: string) => interned.get(text) ?? interned.set(text, text).get(text)!;
