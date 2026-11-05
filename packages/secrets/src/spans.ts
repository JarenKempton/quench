import { detectInFile } from "./detect.ts";

export type Span = [start: number, end: number];

const NAME =
  "(?:token|secret|passw(?:or)?d|passphrase|pass|pwd|api[_-]?key|access[_-]?key|private[_-]?key|auth|credentials?|cookie)";
const ANY = `(?:'(?<single>[^']*)'|"(?<double>[^"]*)"|(?<bare>[^\\s'"]+))`;
const UNTIL_END = `(?<bare>[^\\s"',;]+)`;

const SLOTS = [
  `(?<![\\w-])--?[\\w-]*${NAME}[\\w-]*(?:=|\\s+)${ANY}`,
  `(?<![\\w-])(?:-u|--user)(?:=|\\s+|(?=[^\\s=]))${ANY}`,
  `(?<![\\w.-])[\\w.-]*${NAME}[\\w.-]*\\s*=\\s*${ANY}`,
  `\\bauthorization["']?\\s*[:=]\\s*["']?(?:(?:bearer|basic|token|digest)\\s+)?${UNTIL_END}`,
  `\\bbearer\\s+${UNTIL_END}`,
  `:\\/\\/[^\\s/@:'"]+:(?<bare>[^\\s/@'"]+)@`,
  `:\\/\\/(?<bare>[^\\s/@:'"]+)@`,
].map((source) => new RegExp(source, "gid"));

export function secretSpans(text: string, detectors: readonly RegExp[]): Span[] {
  const spans: Span[] = [];
  for (const pattern of [...SLOTS, ...detectors.map(withIndices)])
    for (const match of text.matchAll(pattern)) {
      const at = valueAt(match);
      if (at && at[1] > at[0]) spans.push(at);
    }
  for (const { value } of detectInFile(text)) spans.push(...occurrences(text, value));
  return merged(spans);
}

function occurrences(text: string, value: string): Span[] {
  const found: Span[] = [];
  if (!value) return found;
  for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1))
    if (
      !/[A-Za-z0-9]/.test(text[at - 1] ?? "") &&
      !/[A-Za-z0-9]/.test(text[at + value.length] ?? "")
    )
      found.push([at, at + value.length]);
  return found;
}

export function rebuilt(text: string, spans: readonly Span[], mask: (value: string) => string) {
  let out = "";
  let from = 0;
  for (const [start, end] of merged(spans)) {
    out += text.slice(from, start) + mask(text.slice(start, end));
    from = end;
  }
  return out + text.slice(from);
}

function merged(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0] || b[1] - a[1])) {
    const last = out.at(-1);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

const withIndices = (pattern: RegExp) =>
  new RegExp(pattern.source, pattern.flags.includes("d") ? pattern.flags : `${pattern.flags}d`);

function valueAt(match: RegExpExecArray | RegExpMatchArray): Span | null {
  const indices = match.indices;
  if (!indices) return null;
  const named = indices.groups ?? {};
  return (
    named.single ??
    named.double ??
    named.bare ??
    indices.slice(1).find((span): span is [number, number] => span !== undefined) ??
    null
  );
}
