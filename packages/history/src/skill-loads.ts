import type { ListedSkill, Session } from "./model.ts";

export type SkillListing = { at: Date | null; chars: number; listed: ListedSkill[] };

export type SkillLoad = {
  name: string;
  path: string | null;
  how: "invoked" | "read" | "shell-read" | "script-read";
  by: "model" | "user" | null;
  at: Date | null;
  callId: string | null;
  status: string | null;
  chars: number | null;
};

type TracedRead = {
  callId: string | null;
  requestedAt: Date | null;
  requested: { path: string };
  status: string;
  returned: { path: string | null; returnedTextChars: number } | null;
};

type TracedShellRead = {
  callId: string | null;
  requestedAt: Date | null;
  kind: string;
  written: string;
  path: string | null;
  status: string;
  outputChars: number | null;
};

export function recordedSkillLoading(
  session: Session,
  reads: readonly TracedRead[],
  shell: readonly TracedShellRead[],
): { listings: SkillListing[]; loads: SkillLoad[] } {
  const listings = session.events.flatMap((event) =>
    event.type === "skills" ? [{ at: event.at, chars: event.chars, listed: event.listed }] : [],
  );
  const pathByName = new Map<string, string>();
  const nameByPath = new Map<string, string>();
  for (const listing of listings)
    for (const skill of listing.listed)
      if (skill.path !== null) {
        if (!pathByName.has(skill.name)) pathByName.set(skill.name, skill.path);
        if (!nameByPath.has(skill.path)) nameByPath.set(skill.path, skill.name);
      }

  const loadsByCall = new Map<string | null, SkillLoad[]>();
  const addLoad = (load: SkillLoad) =>
    loadsByCall.set(load.callId, [...(loadsByCall.get(load.callId) ?? []), load]);
  for (const read of reads) {
    const path = listedPathOf(nameByPath, read.returned?.path, read.requested.path);
    if (path === null) continue;
    addLoad({
      name: nameByPath.get(path)!,
      path,
      how: "read",
      by: null,
      at: read.requestedAt,
      callId: read.callId,
      status: read.status,
      chars: read.returned?.returnedTextChars ?? null,
    });
  }
  for (const read of shell) {
    if (read.kind !== "read" && read.kind !== "script-read") continue;
    const path = listedPathOf(nameByPath, read.path, read.written);
    if (path === null) continue;
    addLoad({
      name: nameByPath.get(path)!,
      path,
      how: read.kind === "read" ? "shell-read" : "script-read",
      by: null,
      at: read.requestedAt,
      callId: read.callId,
      status: read.status,
      chars: read.outputChars,
    });
  }

  const loads: SkillLoad[] = [];
  for (const event of session.events) {
    if (event.type === "invocation")
      loads.push({
        name: event.name,
        path: pathByName.get(event.name) ?? null,
        how: "invoked",
        by: event.by,
        at: event.at,
        callId: null,
        status: null,
        chars: null,
      });
    if (event.type === "tool_call" && loadsByCall.has(event.id)) {
      loads.push(...loadsByCall.get(event.id)!);
      loadsByCall.delete(event.id);
    }
  }
  for (const queued of loadsByCall.values()) loads.push(...queued);
  return { listings, loads };
}

function listedPathOf(
  nameByPath: Map<string, string>,
  ...candidates: (string | null | undefined)[]
): string | null {
  for (const candidate of candidates)
    if (candidate != null && nameByPath.has(candidate)) return candidate;
  return null;
}
