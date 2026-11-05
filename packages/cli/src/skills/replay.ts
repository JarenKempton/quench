import { rmSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TreeEntry } from "@quench/fleet";
import { CHILD_ENV, childEnv } from "@quench/judge";

export const CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export const BUILTIN_PLUGINS = [
  "cc-plugin-agents-md@builtin",
  "cc-plugin-telemetry@builtin",
  "cc-plugin-privacy@builtin",
  "cc-plugin-plugin-authoring@builtin",
];

const PREFIX = "quench-eval-";
const MARKER = "quench-eval.json";
const STALE_MS = 3_600_000;
const PRIVATE = 0o700;
const WATCH =
  'while kill -0 "$1" 2>/dev/null; do kill -0 "-$2" 2>/dev/null || exit 0; sleep 0.2; done; kill -KILL "-$2" 2>/dev/null; rm -rf -- "$3"';
const MAX_TURNS = 3;
const TIMEOUT_MS = 180_000;

export const replayArgv = (model: string | null, budgetUsd: number) => [
  "-p",
  "--no-session-persistence",
  "--setting-sources",
  "user",
  "--strict-mcp-config",
  "--tools",
  "Skill",
  "--settings",
  JSON.stringify({
    disableAllHooks: true,
    autoMemoryEnabled: false,
    enabledPlugins: Object.fromEntries(BUILTIN_PLUGINS.map((p) => [p, false])),
  }),
  "--max-turns",
  String(MAX_TURNS),
  "--max-budget-usd",
  budgetUsd.toFixed(4),
  ...(model ? ["--model", model] : []),
  "--output-format",
  "stream-json",
  "--verbose",
];

export type Replay =
  | {
      ok: true;
      triggered: boolean;
      errored: boolean;
      tokens: number;
      costUsd: number | null;
      output: string;
    }
  | { ok: false; reason: string };

export type ReplayInput = {
  command: string;
  env: Record<string, string | undefined>;
  skill: string;
  tree: TreeEntry[];
  prompt: string;
  model: string | null;
  budgetUsd: number;
  timeoutMs?: number;
};

type Line = Record<string, unknown>;

const isolationProblem = (init: Line): string | null => {
  const tools = init.tools;
  if (!Array.isArray(tools) || tools.length !== 1 || tools[0] !== "Skill")
    return "tools other than Skill were enabled";
  if (!Array.isArray(init.mcp_servers) || init.mcp_servers.length) return "MCP servers loaded";
  if (!Array.isArray(init.plugins) || init.plugins.length) return "plugins loaded";
  return null;
};

async function writeTree(dir: string, tree: TreeEntry[]) {
  for (const entry of tree) {
    const path = join(dir, ...entry.path.split("/"));
    await mkdir(dirname(path), { recursive: true, mode: PRIVATE });
    if (entry.mode === "120000") await symlink(new TextDecoder().decode(entry.bytes), path);
    else {
      await writeFile(path, entry.bytes);
      if (entry.mode === "100755") await chmod(path, 0o755);
    }
  }
}

const json = (text: string): Line | null => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
};

const count = (value: unknown) => (typeof value === "number" ? value : 0);

type Live = { scratch: string; proc: Bun.Subprocess | null; watch: Bun.Subprocess | null };
const live = new Set<Live>();
let guarded = false;

const killGroup = (proc: Bun.Subprocess) => {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
};

const stop = (run: Live) => {
  run.watch?.kill("SIGKILL");
  if (run.proc) killGroup(run.proc);
};

async function stopAll() {
  const running = [...live];
  running.forEach(stop);
  await Promise.all(running.flatMap((run) => (run.proc ? [run.proc.exited] : [])));
  await Promise.all(
    running.map((run) => rm(run.scratch, { recursive: true, force: true, maxRetries: 5 })),
  );
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

type Marker = { owner: number; group: number | null; createdAt: number };

const markerOf = (text: string): Marker | null => {
  try {
    const m = JSON.parse(text);
    return Number.isInteger(m.owner) &&
      (m.group === null || Number.isInteger(m.group)) &&
      Number.isFinite(m.createdAt)
      ? m
      : null;
  } catch {
    return null;
  }
};

export async function reclaimScratch(dir = tmpdir(), now = Date.now()) {
  const uid = process.getuid?.();
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(dir, name);
    const info = await lstat(path).catch(() => null);
    if (!info?.isDirectory() || (uid !== undefined && info.uid !== uid)) continue;
    const marker = markerOf(await readFile(join(path, MARKER), "utf8").catch(() => ""));
    const abandoned = marker
      ? !alive(marker.owner) || now - marker.createdAt > STALE_MS
      : now - info.mtimeMs > STALE_MS;
    if (!abandoned) continue;
    if (marker?.group && marker.group !== process.pid) {
      try {
        process.kill(-marker.group, "SIGKILL");
      } catch {}
    }
    await rm(path, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
}

async function guard() {
  if (guarded) return;
  guarded = true;
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    process.on(signal, () => void stopAll().finally(() => process.exit(code)));
  process.on("exit", () => {
    for (const run of live) {
      stop(run);
      rmSync(run.scratch, { recursive: true, force: true });
    }
  });
  await reclaimScratch();
}

const parentDeath = () => {
  if (process.platform !== "linux") return [];
  const setpriv = Bun.which("setpriv");
  return setpriv ? [setpriv, "--pdeathsig", "KILL", "--"] : [];
};

const watchdog = (group: number, scratch: string) => {
  const watch = Bun.spawn(
    ["/bin/sh", "-c", WATCH, "quench-watchdog", String(process.pid), String(group), scratch],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true },
  );
  watch.unref();
  return watch;
};

const mark = (run: Live, marker: Marker) =>
  writeFile(join(run.scratch, MARKER), JSON.stringify(marker), { mode: 0o600 });

export async function replay(input: ReplayInput): Promise<Replay> {
  await guard();
  const run: Live = { scratch: await mkdtemp(join(tmpdir(), PREFIX)), proc: null, watch: null };
  live.add(run);
  const createdAt = Date.now();
  const config = join(run.scratch, "config");
  const home = join(run.scratch, "home");
  const work = join(run.scratch, "work");
  try {
    await mark(run, { owner: process.pid, group: null, createdAt });
    for (const dir of [home, work, config]) await mkdir(dir, { recursive: true, mode: PRIVATE });
    await writeTree(join(config, "skills", input.skill), input.tree);
    const env = { ...childEnv(input.env), HOME: home, CLAUDE_CONFIG_DIR: config, [CHILD_ENV]: "1" };
    const proc = Bun.spawn(
      [...parentDeath(), input.command, ...replayArgv(input.model, input.budgetUsd)],
      {
        cwd: work,
        env,
        stdin: new TextEncoder().encode(input.prompt),
        stdout: "pipe",
        stderr: "ignore",
        detached: true,
      },
    );
    run.proc = proc;
    run.watch = watchdog(proc.pid, run.scratch);
    await mark(run, { owner: process.pid, group: proc.pid, createdAt });
    const timer = setTimeout(() => killGroup(proc), input.timeoutMs ?? TIMEOUT_MS);
    try {
      return await read(proc, input.skill, () => killGroup(proc));
    } finally {
      clearTimeout(timer);
      stop(run);
      await proc.exited;
    }
  } finally {
    await rm(run.scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    live.delete(run);
  }
}

async function read(
  proc: Bun.Subprocess<Uint8Array, "pipe", "ignore">,
  skill: string,
  kill: () => void,
): Promise<Replay> {
  let init = false;
  let triggered = false;
  let errored = false;
  let result: Line | null = null;
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = json(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      if (line.type === "system" && line.subtype === "init") {
        const problem = isolationProblem(line);
        if (problem) {
          kill();
          return { ok: false, reason: `isolation not confirmed: ${problem}` };
        }
        init = true;
      }
      if (line.type === "assistant") {
        if (!init) {
          kill();
          return { ok: false, reason: "isolation not confirmed: no init event" };
        }
        const content = (line.message as { content?: unknown } | undefined)?.content;
        for (const block of Array.isArray(content) ? content : [])
          if (block?.type === "tool_use" && block.name === "Skill" && block.input?.skill === skill)
            triggered = true;
      }
      if (line.type === "user" && triggered) {
        const content = (line.message as { content?: unknown } | undefined)?.content;
        for (const block of Array.isArray(content) ? content : [])
          if (block?.type === "tool_result" && block.is_error === true) errored = true;
      }
      if (line.type === "result") result = line;
    }
  }
  const code = await proc.exited;
  if (!init) return { ok: false, reason: `claude -p exited with ${code} before starting` };
  if (!result) return { ok: false, reason: `claude -p exited with ${code} and no result` };
  if (result.is_error === true && result.subtype === "success")
    return { ok: false, reason: "claude -p is not signed in, or the request failed" };
  const usage = (result.usage ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    triggered,
    errored: errored || result.is_error === true,
    tokens:
      count(usage.input_tokens) +
      count(usage.cache_read_input_tokens) +
      count(usage.cache_creation_input_tokens) +
      count(usage.output_tokens),
    costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
    output: typeof result.result === "string" ? result.result : "",
  };
}
