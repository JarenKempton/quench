import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { endpointProblem, JudgeName, keyProblem, type JudgeChoice } from "@quench/judge";
import { z } from "zod";

const Stored = z.object({
  judge: z
    .object({
      name: JudgeName,
      baseUrl: z.string().optional(),
      model: z.string().optional(),
      apiKey: z.string().optional(),
    })
    .optional(),
  setup: z.object({ done: z.array(z.string()) }).optional(),
});
export type Config = z.infer<typeof Stored>;
type Env = Record<string, string | undefined>;

export const configPath = (homeDir: string) => join(homeDir, ".quench", "config.json");

export async function readConfig(homeDir: string): Promise<Config> {
  const raw = await Bun.file(configPath(homeDir))
    .json()
    .catch(() => ({}));
  return Stored.safeParse(raw).data ?? {};
}

export async function writeConfig(homeDir: string, config: Config): Promise<string> {
  const path = configPath(homeDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  return path;
}

export function judgeChoice(config: Config, env: Env, flag?: string): JudgeChoice | Error {
  const named = flag ?? (env.QUENCH_JUDGE?.trim() || config.judge?.name || "jev");
  const name = JudgeName.safeParse(named).data;
  if (!name) return new Error("--judge must be jev, claude, openai or none");
  const stored = config.judge?.name === name ? config.judge : undefined;
  const pick = (variable: string, value?: string) => env[variable]?.trim() || value || undefined;
  switch (name) {
    case "jev": {
      const apiKey = pick("TYPESAFE_API_KEY", stored?.apiKey);
      return apiKey ? { name, apiKey } : { name };
    }
    case "openai": {
      const baseUrl = pick("QUENCH_OPENAI_BASE_URL", stored?.baseUrl);
      const model = pick("QUENCH_OPENAI_MODEL", stored?.model);
      const apiKey = pick("QUENCH_OPENAI_API_KEY", stored?.apiKey);
      if (!baseUrl || !model)
        return new Error(
          "--judge openai needs a base URL and model: run `quench setup judge`, or set QUENCH_OPENAI_BASE_URL and QUENCH_OPENAI_MODEL",
        );
      const problem = endpointProblem(baseUrl) ?? (apiKey ? keyProblem(apiKey) : null);
      if (problem) return new Error(`--judge openai: ${problem}`);
      return { name, baseUrl, model, ...(apiKey ? { apiKey } : {}) };
    }
    case "claude":
      return { name };
    case "none":
      return { name };
  }
}

export function typesafeKey(config: Config, env: Env): string | undefined {
  return (
    env.TYPESAFE_API_KEY?.trim() ||
    (config.judge?.name === "jev" ? config.judge.apiKey : undefined) ||
    undefined
  );
}
