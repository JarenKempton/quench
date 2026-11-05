import type { Session } from "@quench/history";

export type PromptLoad = {
  text: string;
  at: Date | null;
  loads: { name: string; by: "model" | "user" }[];
  tokens: number | null;
  reply: string | null;
  model: string | null;
};

export function promptLoads(session: Session): PromptLoad[] {
  const byPath = new Map<string, string>();
  for (const event of session.events)
    if (event.type === "skills")
      for (const skill of event.listed) if (skill.path) byPath.set(skill.path, skill.name);
  const out: PromptLoad[] = [];
  let current: PromptLoad | null = null;
  for (const event of session.events) {
    if (event.type === "message" && event.author === "user") {
      current = {
        text: event.text,
        at: event.at,
        loads: [],
        tokens: null,
        reply: null,
        model: null,
      };
      out.push(current);
      continue;
    }
    if (!current) continue;
    if (event.type === "invocation") current.loads.push({ name: event.name, by: event.by });
    if (event.type === "tool_call" && event.fileRead && byPath.has(event.fileRead.path))
      current.loads.push({ name: byPath.get(event.fileRead.path)!, by: "model" });
    if (event.type === "inference") {
      current.model ??= event.model;
      const { context, output } = event.usage;
      if (context !== null && output !== null)
        current.tokens = (current.tokens ?? 0) + context + output;
    }
    if (event.type === "message" && event.author === "assistant")
      current.reply = current.reply === null ? event.text : `${current.reply}\n${event.text}`;
  }
  return out;
}

export const triggeredBy = (prompt: PromptLoad, skill: string) =>
  prompt.loads.some((l) => l.name === skill && l.by === "model");
