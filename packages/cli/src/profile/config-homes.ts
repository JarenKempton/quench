import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { harnessById, type Home } from "@quench/history";

export type ConfigHome = {
  path: string;
  sessions: number;
  instructionBytes: number;
  settings: boolean;
  hooks: number;
};

export async function claudeConfigHomes(home: Home, since: Date): Promise<ConfigHome[]> {
  const claude = harnessById["claude-code"];
  const siblings = await readdir(home.dir, { withFileTypes: true }).catch(() => []);
  const paths = new Set([
    home.of(claude.home),
    ...siblings
      .filter((e) => e.isDirectory() && (e.name === ".claude" || e.name.startsWith(".claude-")))
      .map((e) => join(home.dir, e.name)),
  ]);
  return Promise.all(
    [...paths].sort().map(async (path) => {
      const refs = await claude.discover(home.withVar(claude.home.variable, path));
      const settings = await Promise.all(
        ["settings.json", "settings.local.json"].map((name) => readJson(join(path, name))),
      );
      return {
        path,
        sessions: refs.filter((r) => !r.modified || r.modified >= since).length,
        instructionBytes: (await stat(join(path, "CLAUDE.md")).catch(() => null))?.size ?? 0,
        settings: settings[0] !== null,
        hooks: settings.reduce<number>((n, s) => n + hookCount(s), 0),
      };
    }),
  );
}

export function unconfiguredHomes(homes: readonly ConfigHome[]) {
  const configured = homes
    .filter((h) => h.instructionBytes || h.hooks)
    .sort((a, b) => b.sessions - a.sessions)[0];
  if (!configured) return null;
  const bare = homes.filter((h) => h.sessions && !h.instructionBytes && !h.hooks);
  return bare.length ? { bare, configured } : null;
}

async function readJson(path: string): Promise<unknown> {
  const text = await Bun.file(path)
    .text()
    .catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function hookCount(settings: unknown): number {
  const events = (settings as { hooks?: unknown } | null)?.hooks;
  if (!events || typeof events !== "object") return 0;
  return Object.values(events).reduce<number>(
    (n, groups) =>
      n +
      (Array.isArray(groups)
        ? groups.reduce<number>((m, g) => m + (Array.isArray(g?.hooks) ? g.hooks.length : 0), 0)
        : 0),
    0,
  );
}
