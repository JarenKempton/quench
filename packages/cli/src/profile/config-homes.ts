import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { harnessById, hookScriptsIn, type Home } from "@quench/history";

export type ConfigHome = {
  path: string;
  sessions: number;
  instructionBytes: number;
  settings: boolean;
  hooks: number;
  hookScripts: string[];
  dead: DeadCommand[];
};

export type DeadCommand = {
  file: string;
  event: string;
  script: string | null;
  problem: "missing" | "commented out";
};

type HookCommand = { file: string; event: string; command: string };

export async function claudeConfigHomes(home: Home, since: Date): Promise<ConfigHome[]> {
  const claude = harnessById["claude-code"];
  const siblings = await readdir(home.dir, { withFileTypes: true }).catch(() => []);
  const byReal = new Map<string, string>();
  for (const path of [
    resolve(home.of(claude.home)),
    ...siblings
      .filter((e) => e.name === ".claude" || e.name.startsWith(".claude-"))
      .map((e) => join(home.dir, e.name))
      .sort(),
  ]) {
    const real = await realpath(path).catch(() => null);
    if (real && !byReal.has(real) && (await stat(real)).isDirectory()) byReal.set(real, path);
  }
  return Promise.all(
    [...byReal.values()].sort().map(async (path) => {
      const refs = await claude.discover(home.withVar(claude.home.variable, path));
      const files = ["settings.json", "settings.local.json"].map((name) => join(path, name));
      const settings = await Promise.all(files.map(readJson));
      const commands = settings.flatMap((s, i) => hookCommands(files[i]!, s));
      return {
        path,
        sessions: refs.filter((r) => r.parent === null && (!r.modified || r.modified >= since))
          .length,
        instructionBytes: (await stat(join(path, "CLAUDE.md")).catch(() => null))?.size ?? 0,
        settings: settings[0] !== null,
        hooks: settings.reduce<number>((n, s) => n + hookCount(s), 0),
        hookScripts: [...new Set(commands.flatMap((c) => hookScriptsIn(c.command)))],
        dead: (await Promise.all(commands.map((c) => deadCommand(c, home.dir, path)))).flatMap(
          (d) => d ?? [],
        ),
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

function hookCommands(file: string, settings: unknown): HookCommand[] {
  const config = settings as {
    hooks?: unknown;
    statusLine?: { command?: unknown };
  } | null;
  const status =
    typeof config?.statusLine?.command === "string"
      ? [{ file, event: "statusLine", command: config.statusLine.command }]
      : [];
  const events = config?.hooks;
  if (!events || typeof events !== "object") return status;
  return [
    ...Object.entries(events).flatMap(([event, groups]) =>
      (Array.isArray(groups) ? groups : []).flatMap((g) =>
        (Array.isArray(g?.hooks) ? g.hooks : []).flatMap((h: { command?: unknown }) =>
          typeof h?.command === "string" ? [{ file, event, command: h.command }] : [],
        ),
      ),
    ),
    ...status,
  ];
}

const INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "ruby",
  "perl",
  "pwsh",
]);

function scriptOf(command: string, homeDir: string, configDir: string): string | null {
  const words = command.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const named = words.map((w) => w.replace(/^["']|["']$/g, ""));
  const first = named[0] && INTERPRETERS.has(win32.basename(named[0])) ? named[1] : named[0];
  if (!first || !/[\\/]/.test(first)) return null;
  const path = first
    .replace(/^~(?=[\\/])/, homeDir)
    .replace(/^\$\{?HOME\}?(?=[\\/])/, homeDir)
    .replace(/^\$\{?CLAUDE_CONFIG_DIR\}?(?=[\\/])/, configDir);
  return isAbsolute(path) ? resolve(path) : null;
}

async function deadCommand(
  hook: HookCommand,
  homeDir: string,
  configDir: string,
): Promise<DeadCommand | null> {
  const lines = hook.command
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length && lines.every((l) => l.startsWith("#")))
    return {
      file: hook.file,
      event: hook.event,
      script: null,
      problem: "commented out",
    };
  const script = scriptOf(hook.command, homeDir, configDir);
  if (!script || (await stat(script).catch(() => null))) return null;
  return { file: hook.file, event: hook.event, script, problem: "missing" };
}

export async function projectHookScripts(roots: readonly string[]): Promise<string[]> {
  const files = roots.flatMap((root) =>
    ["settings.json", "settings.local.json"].map((name) => join(root, ".claude", name)),
  );
  const settings = await Promise.all(files.map(readJson));
  return settings.flatMap((s, i) =>
    hookCommands(files[i]!, s).flatMap((c) => hookScriptsIn(c.command)),
  );
}
