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

const BASE64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const HEX_RUN = /(?:[0-9a-fA-F]{2}){16,}/g;
const PERCENT_RUN = /(?:%[0-9a-fA-F]{2})+/g;
const HAS_PERCENT = /%[0-9a-fA-F]{2}/;
const DECODE_DEPTH = 2;

const base64Text = (run: string) =>
  [0, 1, 2, 3].map((skip) =>
    Buffer.from(run.slice(skip).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  );

const decodeOnce = (text: string) => [
  ...[...text.matchAll(HEX_RUN)].map(([run]) => Buffer.from(run, "hex").toString("utf8")),
  ...[...text.matchAll(BASE64_RUN)].flatMap(([run]) => base64Text(run)),
  ...(HAS_PERCENT.test(text)
    ? [
        text.replace(PERCENT_RUN, (run) =>
          Buffer.from(run.replace(/%/g, ""), "hex").toString("utf8"),
        ),
      ]
    : []),
];

export function decodedViews(text: string): string[] {
  const views: string[] = [];
  let layer = [text];
  for (let depth = 0; depth < DECODE_DEPTH && layer.length; depth++) {
    layer = layer.flatMap(decodeOnce).filter((view) => view.length >= 8);
    views.push(...layer);
  }
  return views;
}

const OPAQUE_RUN = /[A-Za-z0-9+/_-]{24,}={0,2}/g;
const LONG_HEX = /(?:[0-9a-fA-F]{2}){16,}/;
const PERCENT_ESCAPES = /(?:%[0-9a-fA-F]{2}){4,}/;
const DENSE = /[A-Z0-9]/g;

const opaque = (line: string) =>
  PERCENT_ESCAPES.test(line) ||
  LONG_HEX.test(line) ||
  [...line.matchAll(OPAQUE_RUN)].some(
    ([run]) =>
      /\d/.test(run) &&
      /[A-Za-z]/.test(run) &&
      (run.match(DENSE)?.length ?? 0) / run.length >= 0.3 &&
      entropy(run) >= 3.5,
  );

const clip = (line: string) => (line.length > 200 ? `${line.slice(0, 200)}…` : line);

export function flagsFor(base: string, proposed: string): Flag[] {
  const known = new Set(base.match(URL_PATTERN) ?? []);
  const flags: Flag[] = [];
  let fence: "script" | "other" | null = null;
  for (const change of lineChanges(base, proposed)) {
    if (change.kind === "-") continue;
    const { line, at } = change;
    const opens = FENCE.test(line) && fence === null;
    const added = change.kind === "+";
    if (added) {
      const add = (kind: FlagKind) => flags.push({ kind, line: at, text: clip(line) });
      if ((line.match(URL_PATTERN) ?? []).some((u) => !known.has(u))) add("url");
      if (SHELL.test(line) || (fence === "script" && !FENCE.test(line) && line.trim() !== ""))
        add("shell");
      if (SCRIPT.test(line) || (opens && SCRIPT_FENCE.test(line))) add("script");
      if (CREDENTIAL.test(line)) add("credential");
      if (opaque(line)) add("encoded");
    }
    if (opens) fence = SCRIPT_FENCE.test(line) ? "script" : "other";
    else if (FENCE.test(line)) fence = null;
  }
  return flags;
}

const TEXT_CONTROLS = new Set([9, 10, 13]);

export const binary = (text: string) =>
  !text.isWellFormed() ||
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)).some(
    (c) => (c < 32 && !TEXT_CONTROLS.has(c)) || c === 127 || c === 0xfffd,
  );
