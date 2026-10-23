import { sha256 } from "./jsonl.ts";
import type { InjectedInstruction, Session } from "./model.ts";

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
