import { z } from "zod";
import { HarnessJudge } from "./harness.ts";
import { Jev } from "./jev.ts";
import { keyProblem, OpenAIJudge } from "./openai.ts";
import { scrub, type Secrets } from "./redact.ts";
import type { Judge } from "./verdict.ts";

export const JudgeName = z.enum(["jev", "claude", "openai", "none"]);
export type JudgeName = z.infer<typeof JudgeName>;

export type JudgeChoice =
  | { name: "jev"; apiKey?: string }
  | { name: "claude" }
  | { name: "openai"; baseUrl: string; model: string; apiKey?: string }
  | { name: "none" };

export type Provider = {
  readonly name: JudgeName;
  readonly id: string | null;
  readonly label: string;
  readonly callsPerReply: number;
  create(): Promise<Judge | null>;
};

export function provider(
  choice: JudgeChoice,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Provider {
  switch (choice.name) {
    case "jev":
      return {
        name: "jev",
        id: Jev.id,
        label: "Jev",
        callsPerReply: 2,
        create: async () => {
          if (!choice.apiKey) return null;
          checked(choice.apiKey);
          return scrubbed(new Jev(choice.apiKey), [choice.apiKey]);
        },
      };
    case "claude":
      return {
        name: "claude",
        id: HarnessJudge.id,
        label: HarnessJudge.label,
        callsPerReply: 1,
        create: async () => scrubbed(await HarnessJudge.create(env, undefined, platform), []),
      };
    case "openai": {
      const judge = scrubbed(new OpenAIJudge(choice), [choice.apiKey]);
      return {
        name: "openai",
        id: judge.id,
        label: judge.label,
        callsPerReply: 1,
        create: async () => {
          if (choice.apiKey) checked(choice.apiKey);
          return judge;
        },
      };
    }
    case "none":
      return { name: "none", id: null, label: "none", callsPerReply: 0, create: async () => null };
  }
}

function checked(key: string): void {
  const problem = keyProblem(key);
  if (problem) throw new Error(problem);
}

function scrubbed<J extends Judge>(judge: J, secrets: Secrets): J {
  const classify = judge.classify.bind(judge);
  return Object.assign(judge, {
    classify: async (exchanges: Parameters<Judge["classify"]>[0]) => {
      try {
        return (await classify(exchanges)).map((judgment) => scrub(judgment, secrets));
      } catch (error) {
        throw scrub(error, secrets);
      }
    },
  });
}
