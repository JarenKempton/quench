import type { FileSecrets } from "./configs.ts";
import { detectInFile } from "./detect.ts";
import type { CredentialFile } from "./harvest.ts";
import type { HistorySecret } from "./history.ts";
import type { Masker } from "./mask.ts";
import { secretOf, type Secret } from "./secret.ts";

export type Location = {
  tag: string;
  masked: string;
  provider: string;
  confidence: "high" | "low";
  files: string[];
  envVars: string[];
  sessions: string[];
};

type Sources = {
  history: HistorySecret[];
  sessionsOf: Map<string, string[]>;
  files: (FileSecrets | CredentialFile)[];
  env: Record<string, string | undefined>;
  mask: Masker;
};

export function locations({ history, sessionsOf, files, env, mask }: Sources): Location[] {
  const byTag = new Map<string, Location>();
  const at = (secret: Secret) => {
    const known = byTag.get(secret.tag) ?? {
      tag: secret.tag,
      masked: secret.masked,
      provider: secret.provider,
      confidence: secret.confidence,
      files: [],
      envVars: [],
      sessions: [],
    };
    if (secret.confidence === "high")
      Object.assign(known, { provider: secret.provider, confidence: "high" });
    byTag.set(secret.tag, known);
    return known;
  };
  for (const file of files)
    for (const secret of "values" in file ? file.values : file.secrets)
      add(at(secret).files, file.path);
  for (const [name, value] of Object.entries(env))
    if (value)
      for (const found of detectInFile(`${name}=${value}`))
        add(at(secretOf(found, mask, "env")).envVars, name);
  for (const secret of history)
    if (secret.confidence === "high" || byTag.has(secret.tag))
      at(secret).sessions.push(...(sessionsOf.get(secret.tag) ?? []));
  return [...byTag.values()].sort(
    (a, b) => spread(b) - spread(a) || a.provider.localeCompare(b.provider),
  );
}

const add = (list: string[], item: string) => {
  if (!list.includes(item)) list.push(item);
};

const spread = (l: Location) => l.files.length + l.envVars.length + l.sessions.length;
