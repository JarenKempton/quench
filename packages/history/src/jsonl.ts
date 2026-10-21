import type { z } from "zod";
import type { Diagnostics } from "./model.ts";

export async function* jsonlLines<T>(
  path: string,
  line: z.ZodType<T>,
  diagnostics: Diagnostics,
): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of Bun.file(path).stream()) {
    const text = carry + decoder.decode(chunk, { stream: true });
    const rows = text.split("\n");
    carry = rows.pop() ?? "";
    for (const row of rows) {
      const parsed = parseRow(row, line, diagnostics);
      if (parsed !== undefined) yield parsed;
    }
  }
  const last = parseRow(carry + decoder.decode(), line, diagnostics);
  if (last !== undefined) yield last;
}

function parseRow<T>(row: string, line: z.ZodType<T>, diagnostics: Diagnostics): T | undefined {
  if (!row.trim()) return undefined;
  diagnostics.lines += 1;
  const parsed = line.safeParse(parseJson(row));
  if (parsed.success) return parsed.data;
  diagnostics.unparsed += 1;
  return undefined;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (typeof item === "string" ? item : textField(item)))
    .filter((t): t is string => t !== null)
    .join("\n");
}

function textField(item: unknown): string | null {
  if (typeof item !== "object" || item === null || !("text" in item)) return null;
  return typeof item.text === "string" ? item.text : null;
}

export const date = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export function injectedTag(text: string): boolean {
  const match = /^\s*<([A-Za-z][\w-]*)>/.exec(text);
  return match !== null && text.includes(`</${match[1]}>`);
}
