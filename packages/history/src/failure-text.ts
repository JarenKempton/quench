import { basename } from "node:path";

const EXIT_CODE_PATTERNS = [
  /^Exit code (-?\d+)/gm,
  /"exit_code\\?"\s*:\s*(-?\d+)/gm,
  /Process exited with code (-?\d+)/gm,
];

export function exitCodeOf(text: string): number | null {
  const found = EXIT_CODE_PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)])
    .sort((a, b) => a.index - b.index)
    .map((match) => Number(match[1]));
  return found.find((code) => code !== 0) ?? null;
}

export function mentionsInvalidInput(text: string): boolean {
  return /invalid arguments|InputValidationError|validation error|No such tool available/i.test(
    text,
  );
}

export function missingProgramOf(text: string): string | null {
  const match =
    text.match(/command not found: ([\w.+-]+)/) ?? text.match(/([\w.+-]+): command not found/);
  return match?.[1] ?? null;
}

export function missingPathOf(text: string): string | null {
  const match =
    text.match(/No such file or directory(?::|,\s*\w+) '([^']+)'/) ??
    text.match(/([^\s:'"`[\]]*[/.~][^\s:'"`[\]]*)'?: No such file or directory/) ??
    text.match(/no matches found: (\S+)/);
  return match?.[1] ?? null;
}

export function mentionsMissingPath(text: string): boolean {
  return /No such file or directory|File does not exist|ENOENT/i.test(text);
}

export function failureSummary(text: string): string | null {
  const line = firstLineOf(text);
  if (!line) return null;
  return maskVolatile(shortenPaths(line))
    .split(/\s+/)
    .slice(0, 12)
    .join(" ")
    .slice(0, 100)
    .replace(/[.:]$/, "");
}

function firstLineOf(text: string): string | null {
  const unwrapped = text
    .replace(/<\/?[a-z_]+>/g, "")
    .replace(/^\s*[\w:]+ hook error:\s*/i, "")
    .replace(/\[[^\]]*\]:?\s*/g, "")
    .replace(/^\s*(Exit code -?\d+\s*|Error:\s*)+/, "");
  const line = unwrapped.split(/\n|\.\s/).find((l) => l.trim());
  return line?.trim() ?? null;
}

function shortenPaths(line: string): string {
  return line.replace(/\S*\/\S*/g, (token) => basename(token.replace(/[\]:,.]+$/, "")));
}

function maskVolatile(line: string): string {
  return line.replace(/\b[0-9a-f]{7,}\b/g, "…").replace(/\d+/g, "N");
}
