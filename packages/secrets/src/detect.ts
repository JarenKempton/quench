import { issuerOf } from "./issuer.ts";
import { globalAllow, rules, type Allow } from "./rules.ts";

export type Detection = { rule: string; provider: string; value: string; issuer: string | null };

const MIN_ENTROPY = 3;

const ordered = [...rules].sort(
  (a, b) => Number(a.id.startsWith("generic")) - Number(b.id.startsWith("generic")),
);

const keywords = [...new Set(rules.flatMap((rule) => rule.keywords))].sort(
  (a, b) => b.length - a.length,
);

const KEYWORD = new RegExp(
  `(?=(${keywords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}))`,
  "g",
);

const prefixes = new Map(
  keywords.map((word) => [word, keywords.filter((k) => word.startsWith(k))]),
);

function keywordsIn(text: string): Set<string> {
  const present = new Set<string>();
  for (const [, word] of text.toLowerCase().matchAll(KEYWORD))
    for (const prefix of prefixes.get(word!) ?? []) present.add(prefix);
  return present;
}

const SECRET_NAME =
  /(?:^|[\s{,"'])["']?([\w.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|auth|credential|private[_-]?key|client[_-]?key)[\w.-]*)["']?[ \t]*(?:[:=]|[ \t])[ \t]*["']?([^\s"',;#}]{8,})/gim;

const REFERENCE = /^(?:\$|<|%|op:|https?:|env:|true$|false$|null$|none$)/i;

export function detect(text: string, path?: string): Detection[] {
  const present = keywordsIn(text);
  const found = new Map<string, Detection>();
  const file = path?.replaceAll("\\", "/");
  for (const rule of ordered) {
    if (rule.path && !(file && rule.path.test(file))) continue;
    if (rule.keywords.length && !rule.keywords.some((word) => present.has(word))) continue;
    for (const match of text.matchAll(rule.regex)) {
      const value = secretOf(match, rule.secretGroup);
      if (!value || found.has(value) || overlaps(found, value)) continue;
      if (entropy(value) < (rule.entropy ?? MIN_ENTROPY)) continue;
      const parts = {
        secret: value,
        match: matchOf(text, match),
        line: lineAt(text, match.index, match.index),
      };
      if ([globalAllow, ...rule.allow].some((allow) => allowed(allow, parts))) continue;
      found.set(value, {
        rule: rule.id,
        provider: providerOf(rule.id),
        value,
        issuer: issuerOf(rule.id, value, lineAt(text, match.index, match.index + match[0].length)),
      });
    }
  }
  return [...found.values()];
}

export function detectInFile(text: string, path?: string): Detection[] {
  const found = detect(text, path);
  for (const [, , value] of text.matchAll(SECRET_NAME)) {
    if (!value || REFERENCE.test(value) || entropy(value) < MIN_ENTROPY) continue;
    if (found.some((d) => d.value.includes(value) || value.includes(d.value))) continue;
    found.push({ rule: "secret-named-value", provider: "plaintext", value, issuer: null });
  }
  return found;
}

export function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length);
  return bits;
}

function secretOf(match: RegExpExecArray, group: number): string | undefined {
  if (group > 0) return match[group];
  if (match.groups) return match[0];
  return match.slice(1).find((part) => part) ?? match[0];
}

const overlaps = (found: Map<string, Detection>, value: string) =>
  [...found.keys()].some((known) => known.includes(value) || value.includes(known));

function matchOf(text: string, match: RegExpExecArray): string {
  let start = match.index;
  while (start > match.index - 50 && start > 0 && /[\w.-]/.test(text[start - 1]!)) start--;
  return text.slice(start, match.index) + match[0];
}

function lineAt(text: string, from: number, to: number): string {
  const start = text.lastIndexOf("\n", from) + 1;
  const end = text.indexOf("\n", to);
  return text.slice(start, end === -1 ? undefined : end);
}

function allowed(allow: Allow, parts: Record<Allow["target"], string>): boolean {
  const secret = parts.secret.toLowerCase();
  return (
    allow.regexes.some((regex) => regex.test(parts[allow.target])) ||
    allow.stopwords.some((word) => secret.includes(word))
  );
}

const PROVIDERS: Record<string, string> = {
  "curl-auth": "http-auth",
  "defined-networking": "defined-networking",
  "generic-api-key": "generic",
  "jwt-base64": "jwt",
  "new-relic": "new-relic",
  "private-key": "private-key",
};

export function providerOf(rule: string): string {
  const known = Object.keys(PROVIDERS).find((prefix) => rule.startsWith(prefix));
  return known ? PROVIDERS[known]! : rule.split("-")[0]!;
}
