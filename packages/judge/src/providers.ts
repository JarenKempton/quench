import { z } from "zod";
import { HarnessJudge } from "./harness.ts";
import { Jev } from "./jev.ts";
import { OpenAIJudge } from "./openai.ts";
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
        create: async () => (choice.apiKey ? new Jev(choice.apiKey) : null),
      };
    case "claude":
      return {
        name: "claude",
        id: HarnessJudge.id,
        label: HarnessJudge.label,
        callsPerReply: 1,
        create: () => HarnessJudge.create(env, undefined, platform),
      };
    case "openai": {
      const judge = new OpenAIJudge(choice);
      return {
        name: "openai",
        id: judge.id,
        label: judge.label,
        callsPerReply: 1,
        create: async () => judge,
      };
    }
    case "none":
      return { name: "none", id: null, label: "none", callsPerReply: 0, create: async () => null };
  }
}
