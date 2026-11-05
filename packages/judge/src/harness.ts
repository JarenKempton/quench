import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { JudgeFailed, type FailureReason } from "./failure.ts";
import { json, replyPrompt, SYSTEM_PROMPT, verdictIn } from "./questions.ts";
import type { Exchange, Judge, Judgment } from "./verdict.ts";

export const HarnessName = z.enum(["claude"]);
export type HarnessName = z.infer<typeof HarnessName>;

export const CHILD_ENV = "QUENCH_CLASSIFIER_CHILD";
const WORKERS = 4;
const TIMEOUT_MS = 180_000;
const LABEL = "claude -p";
const MODEL = "claude-haiku-5-5";

const ENV_ALLOWED = new Set(
  [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "DISABLE_TELEMETRY",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  ].map((name) => name.toUpperCase()),
);

export function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (value !== undefined && ENV_ALLOWED.has(name.toUpperCase())) out[name] = value;
  return { ...out, [CHILD_ENV]: "1" };
}

export class HarnessMissing extends Error {
  constructor(readonly command: string) {
    super(`${command} was not found on PATH`);
  }
}

export class HarnessUnsupported extends Error {
  constructor(readonly platform: NodeJS.Platform) {
    super("--judge claude is not supported on Windows yet; use Jev (TYPESAFE_API_KEY) instead");
  }
}

type Child = Bun.Subprocess<Uint8Array, "pipe", "pipe">;

export class HarnessFailed extends JudgeFailed {
  constructor(reason: FailureReason, exit?: number) {
    super("claude", reason, exit === undefined ? null : `exit ${exit}`);
  }
}

const ClaudeResult = z.object({
  subtype: z.literal("success"),
  is_error: z.literal(false),
  result: z.string(),
});

export const ARGV = [
  "-p",
  "--no-session-persistence",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--tools",
  "",
  "--disable-slash-commands",
  "--settings",
  '{"disableAllHooks":true,"autoMemoryEnabled":false}',
  "--system-prompt",
  SYSTEM_PROMPT,
  "--model",
  MODEL,
  "--output-format",
  "json",
];

export class HarnessJudge implements Judge {
  static readonly model = MODEL;
  static readonly id = `claude/${MODEL}/reply-v3`;
  static readonly label = LABEL;
  readonly id = HarnessJudge.id;
  readonly label = LABEL;
  readonly #command: string;
  readonly #env: Record<string, string>;
  readonly #timeoutMs: number;
  #broken: HarnessFailed | null = null;

  private constructor(command: string, env: Record<string, string | undefined>, timeoutMs: number) {
    this.#command = command;
    this.#env = childEnv(env);
    this.#timeoutMs = timeoutMs;
  }

  static async create(
    env: Record<string, string | undefined> = process.env,
    timeoutMs = TIMEOUT_MS,
    platform: NodeJS.Platform = process.platform,
  ): Promise<HarnessJudge> {
    if (platform === "win32") throw new HarnessUnsupported(platform);
    if (env[CHILD_ENV]) throw new Error("Quench is already running inside a classifier call");
    const command = Bun.which("claude", env.PATH === undefined ? {} : { PATH: env.PATH });
    if (!command) throw new HarnessMissing("claude");
    return new HarnessJudge(command, env, timeoutMs);
  }

  async classify(exchanges: readonly Exchange[]): Promise<Judgment[]> {
    if (exchanges.length === 0) return [];
    const dir = await mkdtemp(join(tmpdir(), "quench-classify-"));
    try {
      let next = 0;
      const out: Judgment[] = [];
      const worker = async () => {
        while (next < exchanges.length) {
          const i = next++;
          out[i] = await this.#one(exchanges[i] as Exchange, dir);
        }
      };
      await Promise.all(Array.from({ length: Math.min(WORKERS, exchanges.length) }, worker));
      return out;
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    }
  }

  async #one(exchange: Exchange, dir: string): Promise<Judgment> {
    if (this.#broken) return this.#broken;
    let proc: Child;
    try {
      proc = Bun.spawn([this.#command, ...ARGV], {
        cwd: dir,
        env: this.#env,
        stdin: new TextEncoder().encode(replyPrompt(exchange)),
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
    } catch {
      return new HarnessFailed("server");
    }
    let timer: Timer | undefined;
    const deadline = new Promise<HarnessFailed>((done) => {
      timer = setTimeout(() => {
        killGroup(proc);
        done(new HarnessFailed("timeout"));
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([this.#finish(proc), deadline]);
    } catch {
      return new HarnessFailed("server");
    } finally {
      clearTimeout(timer);
    }
  }

  async #finish(proc: Child): Promise<Judgment> {
    const [stdout, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      this.#broken = new HarnessFailed("server", code);
      return this.#broken;
    }
    const envelope = ClaudeResult.safeParse(json(stdout));
    if (!envelope.success) return new HarnessFailed("malformed");
    return verdictIn(envelope.data.result) ?? new HarnessFailed("malformed");
  }
}

function killGroup(proc: Child): void {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
}
