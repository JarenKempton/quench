import { entropy } from "@quench/secrets";

export type Change = { kind: " " | "-" | "+"; line: string; at: number };

const linesOf = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

export function lineChanges(before: string, after: string): Change[] {
  const a = linesOf(before);
  const b = linesOf(after);
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
  const out: Change[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: " ", line: a[i]!, at: ++j });
      i++;
    } else if (
      j < b.length &&
      (i === a.length || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)
    )
      out.push({ kind: "+", line: b[j]!, at: ++j });
    else out.push({ kind: "-", line: a[i++]!, at: j });
  }
  return out;
}

export function unifiedDiff(before: string, after: string, path: string) {
  const changes = lineChanges(before, after);
  if (!changes.some((c) => c.kind !== " ")) return "";
  return [`--- a/${path}`, `+++ b/${path}`, ...changes.map((c) => `${c.kind}${c.line}`)].join("\n");
}

export type FlagKind = "url" | "shell" | "script" | "credential" | "encoded";
export type Flag = { kind: FlagKind; line: number; text: string };

const URL_PATTERN = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>()"'`]+/gi;
const SCRIPT_FENCE =
  /^\s*(?:```|~~~)\s*(?:sh|bash|zsh|fish|shell|console|powershell|pwsh|ps1|bat|cmd|python|py|javascript|js|typescript|ts|node|ruby|rb|perl|php|lua)\b/i;
const FENCE = /^\s*(?:```|~~~)/;
const SHELL =
  /(?:^\s*[$>#]\s+\S|\b(?:curl|wget|sudo|chmod|chown|eval|exec|ssh|scp|rsync|nc|ncat|npx|bunx|iwr|iex|Invoke-WebRequest|Invoke-Expression)\b|\brm\s+-[a-z]*[rf]|\|\s*(?:ba|z)?sh\b|\b(?:bash|sh|zsh)\s+-c\b|\$\(|\b(?:npm|pnpm|yarn|bun|pip|pip3|brew|apt|apt-get|cargo|go)\s+(?:install|add|i)\b)/i;
const SCRIPT = /^#!|<script\b|\bpowershell\b|\bpython3?\s+-c\b|\bnode\s+-e\b/i;
const CREDENTIAL =
  /\b(?:api[_ -]?keys?|access[_ -]?keys?|tokens?|secrets?|passwords?|passwd|passphrases?|credentials?|private[_ -]?keys?|ssh[_ -]?keys?|bearer|authorization|cookies?|aws_[a-z_]+|gh[pousr]_|\.env|\.netrc|\.npmrc|id_rsa|id_ed25519|keychain)\b/i;

export const DECODE_BUDGET = 64 * 1024;
const DECODE_DEPTH = 3;
const MIN_DECODE = 16;
const REGION = /[A-Za-z0-9+/_=-]+(?:\s+[A-Za-z0-9+/_=-]+)*/g;
const TOKEN = /\S+/g;
const HEX_ONLY = /^[0-9a-fA-F]+$/;
const ESCAPE_GAP = /(%[0-9a-fA-F]{2})\s+(?=%[0-9a-fA-F]{2})/g;
const ESCAPE_RUN = /(?:%[0-9a-fA-F]{2})+/g;
const HAS_ESCAPE = /%[0-9a-fA-F]{2}/;
const DENSE = /[A-Z0-9]/g;

type Run = { text: string; start: number; end: number };

const opaqueToken = (token: string) =>
  /[0-9+/_]/.test(token) || /.[A-Z]/.test(token) || token.length >= 20;

export function opaqueRuns(text: string): Run[] {
  const runs: Run[] = [];
  for (const region of text.matchAll(REGION)) {
    const tokens = [...region[0].matchAll(TOKEN)].map((t) => ({
      text: t[0].replace(/=/g, ""),
      start: region.index + t.index,
      end: region.index + t.index + t[0].length,
    }));
    const opaque = tokens.map((t) => t.text !== "" && opaqueToken(t.text));
    const whole = opaque.filter(Boolean).length >= 0.6 * tokens.length;
    let current: Run | null = null;
    tokens.forEach((token, i) => {
      if (whole || opaque[i]) {
        current = current
          ? { text: current.text + token.text, start: current.start, end: token.end }
          : { ...token };
      } else if (current) {
        runs.push(current);
        current = null;
      }
    });
    if (current) runs.push(current);
  }
  return runs.filter((r) => r.text !== "");
}

const base64Text = (run: string) =>
  [0, 1, 2, 3].map((skip) =>
    Buffer.from(run.slice(skip).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  );

const hexText = (run: string) =>
  HEX_ONLY.test(run) && run.length >= 32
    ? [0, 1].map((skip) => Buffer.from(run.slice(skip), "hex").toString("utf8"))
    : [];

const escapeLines = (text: string) =>
  HAS_ESCAPE.test(text)
    ? text
        .replace(ESCAPE_GAP, "$1")
        .split("\n")
        .filter((line) => HAS_ESCAPE.test(line))
        .map((line) =>
          line.replace(ESCAPE_RUN, (run) =>
            Buffer.from(run.replace(/%/g, ""), "hex").toString("utf8"),
          ),
        )
    : [];

const decodeOnce = (text: string) => [
  ...opaqueRuns(text)
    .filter((run) => run.text.length >= MIN_DECODE)
    .flatMap((run) => [...hexText(run.text), ...base64Text(run.text)]),
  ...escapeLines(text),
];

export function decodedViews(text: string): { views: string[]; complete: boolean } {
  const views: string[] = [];
  let used = 0;
  let layer = [text];
  for (let depth = 0; depth < DECODE_DEPTH && layer.length; depth++) {
    const next: string[] = [];
    for (const input of layer)
      for (const view of decodeOnce(input)) {
        if (view.length < 8) continue;
        used += view.length;
        if (used > DECODE_BUDGET) return { views, complete: false };
        next.push(view);
      }
    views.push(...next);
    layer = next;
  }
  return { views, complete: true };
}

const PERCENT_ESCAPES = /(?:%[0-9a-fA-F]{2}){4,}/g;

const distinct = (run: string) => new Set(run).size;

const encodedRun = (run: string) =>
  (run.length >= 64 && distinct(run) >= 4) ||
  (HEX_ONLY.test(run) && run.length >= 32) ||
  (run.length >= 20 &&
    /\d/.test(run) &&
    /[a-z]/.test(run) &&
    /[A-Z]/.test(run) &&
    (run.match(DENSE)?.length ?? 0) / run.length >= 0.25 &&
    entropy(run) >= 3.8);

function encodedSpans(text: string) {
  const spans = opaqueRuns(text)
    .filter((run) => encodedRun(run.text))
    .map(({ start, end }) => ({ start, end }));
  const joined = text.replace(
    ESCAPE_GAP,
    (gap, escape: string) => escape + " ".repeat(gap.length - escape.length),
  );
  for (const m of joined.matchAll(PERCENT_ESCAPES))
    spans.push({ start: m.index, end: m.index + m[0].length });
  return spans;
}

const clip = (line: string) => (line.length > 200 ? `${line.slice(0, 200)}…` : line);

export function flagsFor(base: string, proposed: string): Flag[] {
  const known = new Set(base.match(URL_PATTERN) ?? []);
  const flags: Flag[] = [];
  const added = new Set<number>();
  let fence: "script" | "other" | null = null;
  for (const change of lineChanges(base, proposed)) {
    if (change.kind === "-") continue;
    const { line, at } = change;
    const opens = FENCE.test(line) && fence === null;
    if (change.kind === "+") {
      added.add(at);
      const add = (kind: FlagKind) => flags.push({ kind, line: at, text: clip(line) });
      if ((line.match(URL_PATTERN) ?? []).some((u) => !known.has(u))) add("url");
      if (SHELL.test(line) || (fence === "script" && !FENCE.test(line) && line.trim() !== ""))
        add("shell");
      if (SCRIPT.test(line) || (opens && SCRIPT_FENCE.test(line))) add("script");
      if (CREDENTIAL.test(line)) add("credential");
    }
    if (opens) fence = SCRIPT_FENCE.test(line) ? "script" : "other";
    else if (FENCE.test(line)) fence = null;
  }
  const lineAt = (offset: number) => proposed.slice(0, offset).split("\n").length;
  for (const span of encodedSpans(proposed)) {
    const first = lineAt(span.start);
    const last = lineAt(span.end);
    const line = Array.from({ length: last - first + 1 }, (_, i) => first + i).find((n) =>
      added.has(n),
    );
    if (line !== undefined)
      flags.push({ kind: "encoded", line, text: clip(proposed.slice(span.start, span.end)) });
  }
  return flags.sort((a, b) => a.line - b.line);
}

const TEXT_CONTROLS = new Set([9, 10, 13]);

export const binary = (text: string) =>
  !text.isWellFormed() ||
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)).some(
    (c) => (c < 32 && !TEXT_CONTROLS.has(c)) || c === 127 || c === 0xfffd,
  );

const SQUEEZED_RUN = /[A-Za-z0-9+/_=-]{16,}/g;
const PRINTABLE_RUN = /[ -~\t]{8,}/g;

const printableRuns = (bytes: Buffer) => bytes.toString("latin1").match(PRINTABLE_RUN) ?? [];

const squeezeOnce = (text: string) =>
  [...text.replace(/\s+/g, "").matchAll(SQUEEZED_RUN)].flatMap(([raw]) => {
    const run = raw.replace(/=/g, "");
    const decoded = [0, 1, 2, 3].map((skip) =>
      Buffer.from(run.slice(skip).replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    );
    if (HEX_ONLY.test(run) && run.length >= 32)
      decoded.push(...[0, 1].map((skip) => Buffer.from(run.slice(skip), "hex")));
    return decoded.flatMap(printableRuns);
  });

export function squeezedViews(texts: string[]): { views: string[]; complete: boolean } {
  const views: string[] = [];
  let used = 0;
  let layer = texts;
  for (let depth = 0; depth < DECODE_DEPTH && layer.length; depth++) {
    const next: string[] = [];
    for (const input of layer)
      for (const view of squeezeOnce(input)) {
        used += view.length;
        if (used > DECODE_BUDGET) return { views, complete: false };
        next.push(view);
      }
    views.push(...next);
    layer = next;
  }
  return { views, complete: true };
}

export function addedBlocks(base: string, proposed: string): string[] {
  const blocks: string[][] = [];
  let open = false;
  for (const change of lineChanges(base, proposed)) {
    if (change.kind === "+") {
      if (!open) blocks.push([]);
      blocks.at(-1)!.push(change.line);
      open = true;
    } else if (change.kind === " ") open = false;
  }
  return blocks.map((lines) => lines.join("\n"));
}
