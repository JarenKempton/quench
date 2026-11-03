import gitleaks from "../vendor/gitleaks.toml";
import { goRegex } from "./go-regex.ts";

type Allowlist = {
  regexes?: string[];
  stopwords?: string[];
  regexTarget?: "secret" | "match" | "line";
  paths?: string[];
};

type GitleaksRule = {
  id: string;
  regex?: string;
  secretGroup?: number;
  entropy?: number;
  keywords?: string[];
  allowlists?: Allowlist[];
};

export type Allow = {
  regexes: RegExp[];
  stopwords: string[];
  target: "secret" | "match" | "line";
};

export type Rule = {
  id: string;
  regex: RegExp;
  secretGroup: number;
  entropy: number | null;
  keywords: string[];
  allow: Allow[];
};

const LAZY_PREFIX = /^((?:\(\?i[:)])?)\[\\w\.-\]\{0,50\}\?/;

const withoutPrefix = (source: string): string => {
  const stripped = source.replace(LAZY_PREFIX, "$1");
  return stripped === source ? source : withoutPrefix(stripped);
};

const config = gitleaks as { allowlist: Allowlist; rules: GitleaksRule[] };

const allowOf = (list: Allowlist): Allow => ({
  regexes: (list.regexes ?? []).map((source) => goRegex(source, "")),
  stopwords: (list.stopwords ?? []).map((word) => word.toLowerCase()),
  target: list.regexTarget ?? "secret",
});

export const globalAllow = allowOf(config.allowlist);

export const rules: Rule[] = config.rules.flatMap((rule) =>
  rule.regex
    ? [
        {
          id: rule.id,
          regex: goRegex(withoutPrefix(rule.regex), "g"),
          secretGroup: rule.secretGroup ?? 0,
          entropy: rule.entropy ?? null,
          keywords: (rule.keywords ?? []).map((word) => word.toLowerCase()),
          allow: (rule.allowlists ?? []).filter((list) => !list.paths).map(allowOf),
        },
      ]
    : [],
);
