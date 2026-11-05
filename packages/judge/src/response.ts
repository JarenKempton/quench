import { z } from "zod";
import { JudgeFailed } from "./failure.ts";

export const UnitInterval = z.number().finite().min(0).max(1);
export const Confidence = UnitInterval.nullable();
export const TokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
export const ModelLabel = z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/);

export const modelLabel = (value: unknown, configured: string): string =>
  ModelLabel.safeParse(value).data ?? configured;

const JevResult = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({ input_tokens: TokenCount.optional(), output_tokens: TokenCount.optional() })
    .optional(),
  model: z.unknown(),
});
const JevChoice = z.object({ choice: z.string(), confidence: Confidence.optional() });

export type JevAnswer = {
  choice: string;
  confidence: number | null;
  input: number;
  output: number;
  model: string;
};

export function jevAnswer(
  result: unknown,
  question: string,
  choices: readonly string[],
  configuredModel: string,
): JevAnswer {
  const parsed = JevResult.safeParse(result);
  const answer = JevChoice.safeParse(parsed.data?.answers[question]);
  if (!parsed.success || !answer.success || !choices.includes(answer.data.choice))
    throw new JudgeFailed("jev", "malformed");
  return {
    choice: answer.data.choice,
    confidence: answer.data.confidence ?? null,
    input: parsed.data.usage?.input_tokens ?? 0,
    output: parsed.data.usage?.output_tokens ?? 0,
    model: modelLabel(parsed.data.model, configuredModel),
  };
}

export const OpenAIUsage = z
  .object({ prompt_tokens: TokenCount.optional(), completion_tokens: TokenCount.optional() })
  .optional();
